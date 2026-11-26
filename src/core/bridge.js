// The bridge: routes internal high-precision events to a chosen sink port and
// decides, per event, whether identity can be kept, whether a voice must be
// split onto another channel, whether same-note presses must be folded into a
// single channel voice, or whether the sink must refuse the voice outright.
//
// Decisions are made from the sink's actual capability, never from a promise:
//   * identity-capable sink (ump-midi2): every note keeps its own identity.
//   * channel-only sink (ump-midi1 / legacy): a note needs a (channel, note)
//     slot. Two independent presses of the same note need two channels.
//       - a channel free of that note exists  -> SPLIT (independent release kept)
//       - none exists, a same-group folded voice exists, policy 'fold'
//                                             -> FOLD (one wire voice, refcount,
//                                                independent release destroyed)
//       - otherwise                           -> REFUSE (voice is not taken over,
//                                                existing voices are untouched)
//
// Termination is traceable: every emitted wire Note On has exactly one emitted
// wire Note Off, and a folded voice emits that single Note Off only when the
// last internal key is released. Extra events per input event are bounded by
// policy.maxExtraEventsPerInput (used only by continuous-controller splitting).

import { encodeUmp, toHex } from './ump.js';
import { PROTOCOLS, compareLevel, unitToUint, maxForBits } from './precision.js';

export const DEFAULT_POLICY = Object.freeze({
  // What to do with a new voice of a note when no channel is free for it.
  noteConflict: 'fold', // 'fold' | 'refuse'
  // How to carry a wide controller on a 7-bit sink: one quantised message, or
  // an MSB/LSB pair (14-bit via controller n and n+32). 'split' uses the extra
  // event budget; if the budget is spent it falls back to quantise.
  controlResolution: 'split', // 'split' | 'quantise'
  // Per-note pressure / per-note pitch bend on a sink with no note identity.
  perNoteControl: 'drop', // 'drop' | 'channel-approximate'
  maxExtraEventsPerInput: 1,
});

const clampChannel = (ch) => ch & 0xf;
const isNarrow = (protocolId) => protocolId !== 'ump-midi2';

function normalizeSink(config) {
  const p = PROTOCOLS[config.protocol];
  if (!p) throw new Error(`bridge: unknown sink protocol ${config.protocol}`);
  const channels = config.availableChannels ?? Array.from({ length: 16 }, (_, i) => i);
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error('bridge: availableChannels must be a non-empty array');
  }
  for (const ch of channels) {
    if (!Number.isInteger(ch) || ch < 0 || ch > 15) throw new Error(`bridge: invalid channel ${ch}`);
  }
  return {
    id: config.id ?? p.id,
    protocol: p.id,
    label: config.label ?? p.label,
    availableChannels: [...new Set(channels.map(clampChannel))].sort((a, b) => a - b),
    wireVoices: new Map(), // wireKey -> wire voice record
  };
}

const noteKey = (channel, note) => `${channel}:${note}`;

export function createBridge({ sink, policy = {} } = {}) {
  if (!sink) throw new Error('createBridge: a sink is required');
  const mergedPolicy = { ...DEFAULT_POLICY, ...policy };
  const state = {
    policy: mergedPolicy,
    sink: normalizeSink(sink),
    notes: new Map(), // noteId -> note record (kept after release for trace)
    identityBySource: new Map(), // `${group}:${sourceNoteId}` -> noteId
    nextNoteId: 1,
    onOrder: 0,
    trace: [],
    traceSeq: 0,
  };

  function record(entry) {
    state.trace.push({ seq: ++state.traceSeq, ...entry });
  }

  function noteOnWireId(noteId) {
    // Attribute-data voice id is 16-bit; keep bridge ids inside that window.
    return noteId <= 0xffff ? noteId : 0xffff;
  }

  // ---- output construction -------------------------------------------------

  function emitUmp(protocol, group, packet, description) {
    const words = encodeUmp(packet, { group });
    return {
      protocol,
      encoding: 'ump',
      group,
      words,
      hex: toHex(words),
      description,
    };
  }

  function emitMidi1(group, bytes, description) {
    return {
      protocol: 'legacy',
      encoding: 'midi1-bytes',
      group,
      bytes,
      hex: bytes.map((b) => '0x' + b.toString(16).toUpperCase().padStart(2, '0')).join(' '),
      description,
    };
  }

  function velocityLoss(note, bits) {
    const c = compareLevel(note.velocityUnit, bits);
    return {
      field: 'velocity',
      fromBits: note.sourcePrecision.velocityBits,
      toBits: bits,
      intended: note.velocityUnit,
      delivered: c.delivered,
      error: c.error,
      quantisable: true,
      note: 'velocity survives only as its nearest code at the sink width',
    };
  }

  function noteOnOutput(note, channel, wireBits) {
    const code = Math.min(maxForBits(wireBits), Math.max(1, unitToUint(note.velocityUnit, wireBits)));
    const delivered = code / maxForBits(wireBits);
    if (state.sink.protocol === 'ump-midi2') {
      const wireId = noteOnWireId(note.noteId);
      return emitUmp(
        'ump-midi2',
        note.group,
        { type: 'noteOn', channel, note: note.note, velocity: code, noteId: wireId },
        `NoteOn G${note.group} ch${channel} n${note.note} vel=${code}/${maxForBits(wireBits)} #${wireId}`,
      );
    }
    if (state.sink.protocol === 'ump-midi1') {
      return emitUmp(
        'ump-midi1',
        note.group,
        { type: 'midi1NoteOn', channel, note: note.note, velocity: code },
        `MIDI1 NoteOn G${note.group} ch${channel} n${note.note} vel=${code}/127`,
      );
    }
    return emitMidi1(
      note.group,
      [0x90 | clampChannel(channel), note.note & 0x7f, code],
      `Legacy NoteOn ch${channel} n${note.note} vel=${code}/127`,
    );
  }

  function noteOffOutput(note, channel, wireBits) {
    if (state.sink.protocol === 'ump-midi2') {
      const wireId = noteOnWireId(note.noteId);
      return emitUmp(
        'ump-midi2',
        note.group,
        { type: 'noteOff', channel, note: note.note, velocity: 0, noteId: wireId },
        `NoteOff G${note.group} ch${channel} n${note.note} #${wireId}`,
      );
    }
    if (state.sink.protocol === 'ump-midi1') {
      return emitUmp(
        'ump-midi1',
        note.group,
        { type: 'midi1NoteOff', channel, note: note.note, velocity: 0 },
        `MIDI1 NoteOff G${note.group} ch${channel} n${note.note}`,
      );
    }
    return emitMidi1(
      note.group,
      [0x80 | clampChannel(channel), note.note & 0x7f, 0],
      `Legacy NoteOff ch${channel} n${note.note}`,
    );
  }

  // ---- channel allocation on a channel-only sink ---------------------------

  function channelsHosting(group, note) {
    const out = [];
    for (const v of state.sink.wireVoices.values()) {
      if (v.kind !== 'channel' && v.kind !== 'folded') continue;
      if (v.group === group && v.note === note) out.push(v.channel);
    }
    return out;
  }

  function findFreeChannel(note) {
    const busy = new Set(
      [...state.sink.wireVoices.values()]
        .filter((v) => v.note === note.note)
        .map((v) => v.channel),
    );
    // Prefer the source channel, then the rest of the sink's channels.
    const order = [note.channel, ...state.sink.availableChannels.filter((c) => c !== note.channel)];
    for (const ch of order) {
      if (!state.sink.availableChannels.includes(ch)) continue;
      if (!busy.has(ch)) return ch;
    }
    return null;
  }

  function findFoldTarget(note) {
    for (const [key, v] of state.sink.wireVoices) {
      if (v.kind === 'folded' || v.kind === 'channel') {
        if (v.group === note.group && v.note === note.note) return { key, voice: v };
      }
    }
    return null;
  }

  function sameNoteSounding(note, excludeId) {
    for (const other of state.notes.values()) {
      if (other.noteId === excludeId) continue;
      if (other.state !== 'sounding') continue;
      if (other.route.kind === 'rejected') continue;
      if (other.group === note.group && other.note === note.note) return true;
    }
    return false;
  }

  // Routes a single sounding note onto the current sink. Returns
  // { route, outputs, losses, decision, reason }.
  function routeNote(note, { takeover = false } = {}) {
    const sink = state.sink;
    const p = PROTOCOLS[sink.protocol];
    const losses = [];

    if (!isNarrow(sink.protocol)) {
      // Identity-capable sink: one wire voice per internal note.
      const wireId = noteOnWireId(note.noteId);
      const key = `id:${wireId}`;
      sink.wireVoices.set(key, {
        kind: 'identity', group: note.group, channel: note.channel, note: note.note, noteId: note.noteId,
      });
      const outputs = [noteOnOutput(note, note.channel, 16)];
      // velocity loss is zero on a 16-bit sink but report the exact comparison.
      const cmp = compareLevel(note.velocityUnit, 16);
      if (!cmp.exact) {
        losses.push({
          field: 'velocity', fromBits: note.sourcePrecision.velocityBits, toBits: 16,
          intended: note.velocityUnit, delivered: cmp.delivered, error: cmp.error, quantisable: cmp.error < 1e-9,
        });
      }
      return { route: { kind: 'identity', wireKey: key, channel: note.channel, wireId }, outputs, losses, decision: takeover ? 'takeover-identity' : 'noteOn-identity' };
    }

    const wireBits = p.velocityBits;
    const channel = findFreeChannel(note);
    if (channel !== null) {
      const key = noteKey(channel, note.note);
      const split = sameNoteSounding(note, note.noteId);
      sink.wireVoices.set(key, {
        kind: 'channel', group: note.group, channel, note: note.note,
        refcount: 1, members: [note.noteId], primary: note.noteId, foldedCount: 0,
      });
      const outputs = [noteOnOutput(note, channel, wireBits)];
      losses.push(velocityLoss(note, wireBits));
      const decision = takeover ? 'takeover-split' : split ? 'noteOn-split' : 'noteOn';
      return {
        route: { kind: 'channel', wireKey: key, channel, wireId: null },
        outputs, losses, decision,
        reason: split ? 'same note already sounding; independent voice placed on another channel' : undefined,
      };
    }

    const fold = findFoldTarget(note);
    if (fold && state.policy.noteConflict === 'fold') {
      fold.voice.refcount += 1;
      fold.voice.foldedCount += 1;
      fold.voice.members.push(note.noteId);
      losses.push(velocityLoss(note, wireBits));
      losses.push({
        field: 'noteIdentity',
        fromBits: 16,
        toBits: 0,
        intended: note.noteId,
        delivered: fold.voice.primary,
        error: null,
        quantisable: false,
        note: 'folded into an existing same-note channel voice; independent release is no longer representable',
      });
      return {
        route: { kind: 'folded', wireKey: fold.key, channel: fold.voice.channel, foldedInto: fold.voice.primary },
        outputs: [], losses,
        decision: takeover ? 'takeover-fold' : 'noteOn-fold',
        reason: 'no channel free for this note; merged into an existing voice (refcount)',
      };
    }

    losses.push({
      field: 'note',
      fromBits: p.velocityBits,
      toBits: 0,
      intended: note.noteId,
      delivered: null,
      error: null,
      quantisable: false,
      note: 'voice refused: no free channel and folding is not permitted',
    });
    return {
      route: { kind: 'rejected', wireKey: null, channel: null },
      outputs: [], losses,
      decision: takeover ? 'takeover-refuse' : 'noteOn-refuse',
      reason: 'no-free-channel',
    };
  }

  // ---- note identity resolution -------------------------------------------

  function resolveNoteOnIdentity(group, message) {
    const sourceKey = message.noteId != null ? `${group}:${message.noteId}` : null;
    if (sourceKey && state.identityBySource.has(sourceKey)) {
      const existing = state.identityBySource.get(sourceKey);
      if (state.notes.get(existing)?.state === 'sounding') {
        throw new Error(`bridge: note identity ${message.noteId} pressed twice before release`);
      }
    }
    const noteId = state.nextNoteId++;
    if (sourceKey) state.identityBySource.set(sourceKey, noteId);
    return noteId;
  }

  function resolveNoteOff(note) {
    const sourceKey = note.sourceNoteId != null ? `${note.group}:${note.sourceNoteId}` : null;
    if (sourceKey && state.identityBySource.has(sourceKey)) {
      return state.identityBySource.get(sourceKey);
    }
    // No wire identity: release the oldest matching sounding note (FIFO).
    let oldest = null;
    for (const n of state.notes.values()) {
      if (n.state !== 'sounding') continue;
      if (n.group !== note.group || n.channel !== note.channel || n.note !== note.note) continue;
      if (!oldest || n.onOrder < oldest.onOrder) oldest = n;
    }
    return oldest ? oldest.noteId : null;
  }

  // ---- event handlers ------------------------------------------------------

  function handleNoteOn(event) {
    const noteId = resolveNoteOnIdentity(event.group, event.raw);
    const note = {
      noteId,
      group: event.group,
      channel: event.channel,
      note: event.note,
      sourceNoteId: event.sourceNoteId,
      sourcePrecision: event.sourcePrecision,
      velocityUnit: event.velocity,
      velocityRaw: event.velocityRaw,
      onOrder: ++state.onOrder,
      state: 'sounding',
      route: { kind: 'pending' },
      trace: [],
    };
    state.notes.set(noteId, note);
    const routed = routeNote(note);
    note.route = routed.route;
    record({ noteId, action: routed.decision, wireKey: routed.route.wireKey ?? null, detail: routed.reason ?? null });
    return buildResult(event, routed, { noteIds: [noteId] });
  }

  function handleNoteOff(event) {
    const noteId = resolveNoteOff(event);
    if (noteId == null) {
      return {
        input: event,
        decision: 'noteOff-unmatched',
        outputs: [],
        losses: [],
        noteIds: [],
        rejected: true,
        reason: 'no sounding internal note matched this release',
      };
    }
    const note = state.notes.get(noteId);
    note.state = 'released';
    const route = note.route;

    if (route.kind === 'identity') {
      const output = noteOffOutput(note, route.channel, 16);
      state.sink.wireVoices.delete(route.wireKey);
      record({ noteId, action: 'noteOff-identity', wireKey: route.wireKey, detail: null });
      return buildResult(event, { decision: 'noteOff-identity', outputs: [output], losses: [], route }, { noteIds: [noteId] });
    }

    if (route.kind === 'channel' || route.kind === 'folded') {
      const voice = state.sink.wireVoices.get(route.wireKey);
      if (!voice) {
        return { input: event, decision: 'noteOff-unmatched', outputs: [], losses: [], noteIds: [noteId], rejected: true, reason: 'wire voice no longer exists' };
      }
      voice.refcount -= 1;
      voice.members = voice.members.filter((id) => id !== noteId);
      if (voice.refcount > 0) {
        // The residue: the source released a key, the wire voice keeps sounding.
        const losses = [{
          field: 'noteOff', fromBits: 16, toBits: 0, intended: noteId, delivered: null, error: null, quantisable: false,
          note: `release suppressed: wire voice still held by ${voice.members.map((m) => '#' + m).join(', ')} (refcount ${voice.refcount})`,
        }];
        record({ noteId, action: 'noteOff-suppressed', wireKey: route.wireKey, detail: `refcount=${voice.refcount}; residue=still sounding` });
        return buildResult(event, { decision: 'noteOff-suppressed', outputs: [], losses, route }, { noteIds: [noteId], residue: true });
      }
      const representative = state.notes.get(voice.primary) ?? note;
      const output = noteOffOutput(representative, voice.channel, PROTOCOLS[state.sink.protocol].velocityBits);
      state.sink.wireVoices.delete(route.wireKey);
      record({ noteId, action: 'noteOff-closes-voice', wireKey: route.wireKey, detail: `refcount 0; closes voice opened by #${voice.primary}` });
      return buildResult(event, { decision: route.kind === 'folded' ? 'noteOff-closes-folded' : 'noteOff', outputs: [output], losses: [], route }, { noteIds: [noteId] });
    }

    // rejected voice: nothing on the wire to stop.
    record({ noteId, action: 'noteOff-rejected', wireKey: null, detail: 'voice was never taken over by the sink' });
    return buildResult(event, { decision: 'noteOff-rejected', outputs: [], losses: [], route }, { noteIds: [noteId] });
  }

  function targetChannelsFor(group, sourceChannel) {
    const hosting = [...new Set(
      [...state.sink.wireVoices.values()]
        .filter((v) => v.group === group && v.channel != null)
        .map((v) => v.channel),
    )];
    if (hosting.length) return hosting.sort((a, b) => a - b);
    if (state.sink.availableChannels.includes(sourceChannel)) return [sourceChannel];
    return [state.sink.availableChannels[0]];
  }

  function handleControl(event) {
    const sink = state.sink;
    const wide = !isNarrow(sink.protocol);

    if (wide) {
      const packet = controlPacketBase(event, event.channel);
      // Values are re-emitted at the source integer width exactly.
      return buildResult(event, {
        decision: `${event.type}-wide`,
        outputs: [emitUmp('ump-midi2', event.group, packet, `${event.type} G${event.group} ch${event.channel}`)],
        losses: [],
        route: null,
      }, {});
    }

    const p = PROTOCOLS[sink.protocol];
    const channels = targetChannelsFor(event.group, event.channel);
    const outputs = [];
    const losses = [];
    let decision;
    let extra = 0;

    if (event.type === 'controlChange') {
      const eligible = event.controller >= 0 && event.controller <= 31;
      const useSplit = state.policy.controlResolution === 'split'
        && eligible
        && state.policy.maxExtraEventsPerInput >= 1;
      for (const ch of channels) {
        if (useSplit) {
          const code14 = unitToUint(event.valueUnit, 14);
          const msb = (code14 >> 7) & 0x7f;
          const lsb = code14 & 0x7f;
          outputs.push(ccMessage(sink.protocol, event.group, ch, event.controller, msb));
          outputs.push(ccMessage(sink.protocol, event.group, ch, event.controller + 32, lsb));
          extra += 1;
        } else {
          const code = unitToUint(event.valueUnit, 7);
          outputs.push(ccMessage(sink.protocol, event.group, ch, event.controller, code));
        }
      }
      const bits = useSplit ? 14 : 7;
      const cmp = compareLevel(event.valueUnit, bits);
      losses.push({
        field: 'controllerValue', fromBits: 32, toBits: bits,
        intended: event.valueUnit, delivered: cmp.delivered, error: cmp.error,
        quantisable: true,
        note: useSplit
          ? `14-bit split onto CC ${event.controller}/${event.controller + 32}; fine steps below 1/16383 are lost`
          : 'quantised to one 7-bit message; steps below 1/127 are lost',
      });
      if (channels.length > 1) {
        losses.push({ field: 'controlFanout', fromBits: 0, toBits: 0, intended: 1, delivered: channels.length, error: null, quantisable: false, note: `broadcast to ${channels.length} legacy channels hosting source ch${event.channel}` });
      }
      decision = useSplit ? 'controlChange-split-14bit' : 'controlChange-quantised-7bit';
    } else if (event.type === 'pitchBend') {
      const code14 = unitToUint(event.valueUnit, 14);
      for (const ch of channels) outputs.push(pitchBendMessage(sink.protocol, event.group, ch, code14));
      const cmp = compareLevel(event.valueUnit, 14);
      losses.push({ field: 'pitchBend', fromBits: 32, toBits: 14, intended: event.valueUnit, delivered: cmp.delivered, error: cmp.error, quantisable: true, note: 'bend reduced to a 14-bit wheel value' });
      decision = 'pitchBend-quantised-14bit';
    } else if (event.type === 'channelPressure') {
      const code = unitToUint(event.valueUnit, 7);
      for (const ch of channels) outputs.push(channelPressureMessage(sink.protocol, event.group, ch, code));
      const cmp = compareLevel(event.valueUnit, 7);
      losses.push({ field: 'channelPressure', fromBits: 32, toBits: 7, intended: event.valueUnit, delivered: cmp.delivered, error: cmp.error, quantisable: true, note: 'channel pressure reduced to 7 bits' });
      decision = 'channelPressure-quantised-7bit';
    } else {
      // polyPressure / perNotePitchBend / per-note CC cannot address identity.
      if (state.policy.perNoteControl === 'channel-approximate' && event.type === 'perNotePitchBend') {
        // Approximate per-note bend as a channel-wide bend. This necessarily
        // bends every other voice on the target channel too, so it is reported
        // as a destructive loss rather than a clean mapping.
        const code14 = unitToUint(event.valueUnit, 14);
        for (const ch of channels) outputs.push(pitchBendMessage(sink.protocol, event.group, ch, code14));
        losses.push({
          field: 'perNotePitchBend', fromBits: 32, toBits: 14, intended: event.valueUnit, delivered: code14 / 16383, error: Math.abs(code14 / 16383 - event.valueUnit),
          quantisable: false,
          note: 'per-note bend approximated as a channel bend; every other voice on the channel is bent too',
        });
        decision = 'perNotePitchBend-channel-approximate';
      } else {
        losses.push({
          field: event.type, fromBits: 32, toBits: 0, intended: event.valueUnit ?? null, delivered: null, error: null,
          quantisable: false,
          note: 'sink has no per-note identity; per-note control cannot be delivered without changing other notes on the channel',
        });
        decision = `${event.type}-dropped`;
      }
    }

    return buildResult(event, { decision, outputs, losses, route: null, extraEvents: extra }, {});
  }

  function ccMessage(protocol, group, channel, controller, value) {
    if (protocol === 'ump-midi1') {
      return emitUmp('ump-midi1', group, { type: 'midi1ControlChange', channel, controller, value }, `MIDI1 CC ch${channel} cc${controller}=${value}/127`);
    }
    return emitMidi1(group, [0xb0 | clampChannel(channel), controller & 0x7f, value & 0x7f], `Legacy CC ch${channel} cc${controller}=${value}/127`);
  }

  function pitchBendMessage(protocol, group, channel, code14) {
    if (protocol === 'ump-midi1') {
      return emitUmp('ump-midi1', group, { type: 'midi1PitchBend', channel, value: code14 }, `MIDI1 Bend ch${channel}=${code14}/16383`);
    }
    return emitMidi1(group, [0xe0 | clampChannel(channel), code14 & 0x7f, (code14 >> 7) & 0x7f], `Legacy Bend ch${channel}=${code14}/16383`);
  }

  function channelPressureMessage(protocol, group, channel, value) {
    // MIDI 1.0 UMP channel pressure is status 0xD0 with one data byte.
    if (protocol === 'ump-midi1') {
      const word = ((0x2 << 28) | ((group & 0xf) * 0x01000000) | ((0xd0 | (channel & 0xf)) << 16) | (value & 0x7f)) >>> 0;
      return { protocol, encoding: 'ump', group, words: [word], hex: toHex([word]), description: `MIDI1 ChPressure ch${channel}=${value}/127` };
    }
    return emitMidi1(group, [0xd0 | clampChannel(channel), value & 0x7f], `Legacy ChPressure ch${channel}=${value}/127`);
  }

  function controlPacketBase(event, channel) {
    switch (event.type) {
      case 'controlChange':
        return { type: 'controlChange', channel, controller: event.controller, value: Math.min(0xffffffff, Math.max(0, event.valueRaw)) };
      case 'pitchBend':
        return { type: 'pitchBend', channel, value: Math.min(0xffffffff, Math.max(0, event.valueRaw)) };
      case 'channelPressure':
        return { type: 'channelPressure', channel, value: Math.min(0xffffffff, Math.max(0, event.valueRaw)) };
      case 'polyPressure':
        return { type: 'polyPressure', channel, note: event.note, value: Math.min(0xffffffff, Math.max(0, event.valueRaw)) };
      case 'perNotePitchBend':
        return { type: 'perNotePitchBend', channel, note: event.note, value: Math.min(0xffffffff, Math.max(0, event.valueRaw)) };
      default:
        throw new Error(`bridge: unhandled control type ${event.type}`);
    }
  }

  function handlePassthrough(event) {
    const sink = state.sink;
    if (event.type === 'sysex') {
      if (sink.protocol === 'legacy') {
        return buildResult(event, {
          decision: 'sysex-legacy-bytes',
          outputs: [emitMidi1(event.group, [0xf0, ...event.data, 0xf7], `SysEx ${event.data.length} byte(s)`)],
          losses: [], route: null,
        }, {});
      }
      return buildResult(event, { decision: 'sysex-passthrough', outputs: [], losses: [], route: null, rejected: true, reason: 'SysEx re-encoding not emitted by this bridge build' }, {});
    }
    if (sink.protocol === 'legacy') {
      return buildResult(event, {
        decision: `${event.type}-unsupported-sink`,
        outputs: [], losses: [],
        route: null,
        rejected: true,
        reason: `${event.type} has no representation on a legacy channel port`,
      }, {});
    }
    // UMP sinks keep timing/system utility messages as-is.
    if (sink.protocol === 'ump-midi1' && (event.type === 'tempo' || event.type === 'timeSignature')) {
      return buildResult(event, { decision: `${event.type}-unsupported-sink`, outputs: [], losses: [], route: null, rejected: true, reason: `${event.type} is not a MIDI 1.0 channel message` }, {});
    }
    return buildResult(event, { decision: `${event.type}-passthrough`, outputs: [], losses: [], route: null }, {});
  }

  function buildResult(input, routed, extra) {
    const outputs = routed.outputs ?? [];
    return {
      input,
      decision: routed.decision,
      reason: routed.reason ?? null,
      outputs,
      losses: routed.losses ?? [],
      noteIds: extra.noteIds ?? [],
      residue: extra.residue ?? false,
      rejected: routed.rejected ?? false,
      route: routed.route ?? null,
      extraEvents: routed.extraEvents ?? Math.max(0, outputs.length - 1),
    };
  }

  // ---- public API ----------------------------------------------------------

  function handle(event) {
    switch (event.type) {
      case 'noteOn':
        return handleNoteOn(event);
      case 'noteOff':
        return handleNoteOff(event);
      case 'controlChange':
      case 'pitchBend':
      case 'channelPressure':
      case 'polyPressure':
      case 'perNotePitchBend':
        return handleControl(event);
      case 'noteManagement':
        return buildResult(event, {
          decision: 'noteManagement-ignored',
          outputs: [], losses: [], route: null, rejected: true,
          reason: 'per-note management is not in the routable subset for this sink',
        }, {});
      default:
        return handlePassthrough(event);
    }
  }

  // Switches the sink and takes over every sounding voice, in original press
  // order so earlier voices keep priority for scarce channels.
  function setSink(config) {
    const from = state.sink;
    const next = normalizeSink(config);
    state.sink = next;
    const decisions = [];
    const outputs = [];
    const losses = [];
    const sounding = [...state.notes.values()]
      .filter((n) => n.state === 'sounding')
      .sort((a, b) => a.onOrder - b.onOrder);
    for (const note of sounding) {
      const routed = routeNote(note, { takeover: true });
      note.route = routed.route;
      decisions.push({ noteId: note.noteId, note: note.note, group: note.group, decision: routed.decision, reason: routed.reason ?? null, wireKey: routed.route.wireKey ?? null });
      outputs.push(...routed.outputs);
      losses.push(...routed.losses);
      record({ noteId: note.noteId, action: routed.decision, wireKey: routed.route.wireKey ?? null, detail: routed.reason ?? null });
    }
    return {
      from: from.protocol,
      to: next.protocol,
      availableChannels: next.availableChannels,
      decisions,
      outputs,
      losses,
      extraEvents: Math.max(0, outputs.length - sounding.length),
    };
  }

  function snapshot() {
    const sounding = [...state.notes.values()]
      .filter((n) => n.state === 'sounding' && n.route.kind !== 'rejected')
      .map((n) => ({
        noteId: n.noteId,
        sourceNoteId: n.sourceNoteId,
        group: n.group,
        note: n.note,
        velocityUnit: n.velocityUnit,
        velocityRaw: n.velocityRaw,
        sourcePrecision: n.sourcePrecision,
        routeKind: n.route.kind,
        wireKey: n.route.wireKey ?? null,
        channel: n.route.channel ?? null,
        foldedInto: n.route.foldedInto ?? null,
      }));
    const wireVoices = [...state.sink.wireVoices.entries()].map(([key, v]) => ({ key, ...v }));
    return {
      sink: state.sink.protocol,
      availableChannels: state.sink.availableChannels,
      sounding,
      wireVoices,
      trace: [...state.trace],
    };
  }

  return {
    handle,
    setSink,
    snapshot,
    get policy() { return state.policy; },
    setPolicy(patch) { state.policy = { ...state.policy, ...patch }; },
    get sinkProtocol() { return state.sink.protocol; },
    notes: () => state.notes,
  };
}
