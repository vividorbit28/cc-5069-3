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
import {
  DISPOSITION, resolvePerNoteDisposition, controlRule, recomputeBendError, quantiseField,
} from './degradation.js';
import { createDiagnostics } from './diagnostics.js';
import { createLoopGuard } from './loopguard.js';

export const DEFAULT_POLICY = Object.freeze({
  // What to do with a new voice of a note when no channel is free for it.
  noteConflict: 'fold', // 'fold' | 'refuse'
  // How to carry a wide controller on a 7-bit sink: one quantised message, or
  // an MSB/LSB pair (14-bit via controller n and n+32). 'split' uses the extra
  // event budget; if the budget is spent it falls back to quantise.
  controlResolution: 'split', // 'split' | 'quantise'
  // Per-note pressure / per-note pitch bend on a sink with no note identity.
  //   'drop'                 refuse the event, keep the reason;
  //   'channel-approximate'  bend the whole channel (moves other voices too);
  //   'migrate-note'         move the note to a dedicated channel first;
  //   'staged-degrade'       keep the note in place, defer the bend until the
  //                          note can be isolated at its release.
  perNoteControl: 'drop', // 'drop' | 'channel-approximate' | 'migrate-note' | 'staged-degrade'
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

export function createBridge({ sink, policy = {}, bridgeId = 'bridge-1' } = {}) {
  if (!sink) throw new Error('createBridge: a sink is required');
  const mergedPolicy = { ...DEFAULT_POLICY, ...policy };
  const diagnostics = createDiagnostics();
  const loopGuard = createLoopGuard({ bridgeId: policy.bridgeId ?? bridgeId });
  const state = {
    policy: mergedPolicy,
    sink: normalizeSink(sink),
    notes: new Map(), // noteId -> note record (kept after release for trace)
    identityBySource: new Map(), // `${group}:${sourceNoteId}` -> noteId
    nextNoteId: 1,
    onOrder: 0,
    trace: [],
    traceSeq: 0,
    // Per-note expression that must follow the note across channel moves:
    // noteId -> { perNotePitchBend: {valueUnit, valueRaw} | null, polyPressure: ... }
    expression: new Map(),
    // Expression withheld by the staged policy, keyed by noteId.
    deferred: new Map(),
    diagnostics,
    loopGuard,
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

  // Initial allocation: different notes share a channel freely, so only a
  // channel already hosting the same note number is busy.
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

  // Isolation allocation for per-note expression: the target channel must
  // carry no wire voice at all, so a channel-wide bend reaches only this note.
  function findIsolatedChannel(note) {
    const busy = new Set(
      [...state.sink.wireVoices.values()]
        .filter((v) => v.channel != null)
        .map((v) => v.channel),
    );
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

  // A note is isolated when its wire channel carries no other sounding voice.
  // On an isolated channel a channel-wide bend reaches exactly this note.
  function isIsolated(note) {
    const ch = note.route?.channel;
    if (ch == null) return false;
    for (const other of state.notes.values()) {
      if (other.noteId === note.noteId || other.state !== 'sounding') continue;
      if (other.route.kind === 'rejected') continue;
      if (other.group === note.group && other.route.channel === ch) return false;
    }
    return true;
  }

  function findSoundingNoteForEvent(event) {
    if (event.sourceNoteId != null) {
      const id = state.identityBySource.get(`${event.group}:${event.sourceNoteId}`);
      const n = id != null ? state.notes.get(id) : null;
      if (n && n.state === 'sounding') return n;
    }
    let oldest = null;
    for (const n of state.notes.values()) {
      if (n.state !== 'sounding' || n.route.kind === 'rejected') continue;
      if (n.group !== event.group || n.note !== event.note) continue;
      if (!oldest || n.onOrder < oldest.onOrder) oldest = n;
    }
    return oldest;
  }

  function freeChannelExists(note) {
    return findIsolatedChannel(note) !== null;
  }

  // Moves one sounding, routed note onto a free channel. The old wire voice is
  // closed with its own Note Off before the new one opens, so the renderer can
  // never see a dangling voice, and the internal instance id is unchanged —
  // that is what lets the later release settle the migrated voice.
  function migrateNote(note, reason) {
    const sink = state.sink;
    const p = PROTOCOLS[sink.protocol];
    const oldRoute = note.route;
    const outputs = [];
    const losses = [];
    if (oldRoute.kind === 'channel' || oldRoute.kind === 'folded') {
      const oldVoice = sink.wireVoices.get(oldRoute.wireKey);
      if (oldVoice) {
        const representative = state.notes.get(oldVoice.primary) ?? note;
        outputs.push(noteOffOutput(representative, oldVoice.channel, p.velocityBits));
        if (oldRoute.kind === 'folded') {
          // Unfolding: the remaining folded members stay on the old voice.
          oldVoice.refcount -= 1;
          oldVoice.members = oldVoice.members.filter((id) => id !== note.noteId);
          if (oldVoice.refcount <= 0) sink.wireVoices.delete(oldRoute.wireKey);
        } else {
          sink.wireVoices.delete(oldRoute.wireKey);
        }
      }
    }
    const channel = findIsolatedChannel(note);
    if (channel == null) {
      return { ok: false, outputs, losses, reason: 'no-free-channel' };
    }
    const key = noteKey(channel, note.note);
    sink.wireVoices.set(key, {
      kind: 'channel', group: note.group, channel, note: note.note,
      refcount: 1, members: [note.noteId], primary: note.noteId, foldedCount: 0,
    });
    outputs.push(noteOnOutput(note, channel, p.velocityBits));
    note.route = { kind: 'channel', wireKey: key, channel, wireId: null };
    const velCmp = compareLevel(note.velocityUnit, p.velocityBits);
    losses.push({
      field: 'velocity', fromBits: note.sourcePrecision.velocityBits, toBits: p.velocityBits,
      intended: note.velocityUnit, delivered: velCmp.delivered, error: velCmp.error, quantisable: true,
      note: `re-triggered on migration channel ${channel}; velocity re-quantised`,
    });
    state.diagnostics.migration({
      noteId: note.noteId, group: note.group, note: note.note,
      fromChannel: oldRoute.channel ?? null, toChannel: channel, reason,
    });
    record({ noteId: note.noteId, action: 'note-migrate', wireKey: key, detail: `ch${oldRoute.channel ?? '?'}->ch${channel}: ${reason}` });
    return { ok: true, outputs, losses, channel, wireKey: key };
  }

  function saveBendExpression(noteId, event) {
    const expr = state.expression.get(noteId) ?? { perNotePitchBend: null, polyPressure: [] };
    expr.perNotePitchBend = { valueUnit: event.valueUnit, valueRaw: event.valueRaw };
    state.expression.set(noteId, expr);
  }

  // Re-evaluates withheld per-note expression. A deferred bend becomes a real
  // channel bend as soon as its note is isolated; bends whose note ended first
  // are closed as documented, never-sounded losses.
  function flushDeferred(exceptNoteId = null) {
    const outputs = [];
    const losses = [];
    const pitchErrors = [];
    for (const [noteId, item] of [...state.deferred.entries()]) {
      if (noteId === exceptNoteId) continue;
      const note = state.notes.get(noteId);
      if (!note || note.state !== 'sounding' || note.route.kind === 'rejected') {
        state.diagnostics.refusal({ noteId, field: 'perNotePitchBend', reason: 'note released before it could be isolated; withheld per-note bend never sounded', disposition: DISPOSITION.REFUSE });
        state.deferred.delete(noteId);
        losses.push({ field: 'perNotePitchBend', fromBits: 32, toBits: 0, intended: item.event.valueUnit, delivered: null, error: null, quantisable: false, note: 'staged bend expired at note release without an isolated channel' });
        continue;
      }
      if (isIsolated(note)) {
        const applied = emitChannelBend(note, item.event);
        outputs.push(...applied.outputs);
        losses.push(...applied.losses);
        pitchErrors.push(applied.pitchError);
        state.deferred.delete(noteId);
        record({ noteId, action: 'deferred-bend-applied', wireKey: note.route.wireKey, detail: `isolation achieved; bend delivered on ch${note.route.channel}` });
      }
    }
    return { outputs, losses, pitchErrors };
  }

  // Encodes a per-note bend as a channel bend on the note's current channel.
  function emitChannelBend(note, event) {
    const sink = state.sink;
    const channels = [note.route.channel];
    const code14 = unitToUint(event.valueUnit, 14);
    const outputs = channels.map((ch) => pitchBendMessage(sink.protocol, event.group, ch, code14));
    const pitchError = recomputeBendError(event.valueUnit, { semitoneRange: 2, bits: 14 });
    state.diagnostics.quantisation({
      field: 'perNotePitchBend', valueUnit: event.valueUnit, bits: 14,
      noteId: note.noteId, channel: note.route.channel, carrier: 'midi1-pitchbend-14bit',
    });
    const losses = [{
      field: 'perNotePitchBend', fromBits: 32, toBits: 14,
      intended: event.valueUnit, delivered: pitchError.deliveredUnit,
      error: pitchError.unitError, quantisable: true,
      note: `delivered as a channel bend on isolated ch${note.route.channel}; pitch error ${pitchError.centsError.toFixed(3)} cents`,
    }];
    return { outputs, losses, pitchError: { noteId: note.noteId, ...pitchError, channel: note.route.channel } };
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
    // A voice needs a (channel, note) slot. Prefer the source channel, then
    // any channel not already hosting this note number; different notes share
    // a channel freely. Only a same-note collision forces a split / fold.
    let channel = findFreeChannel(note);
    const split = sameNoteSounding(note, note.noteId);
    if (channel === null) {
      // Every allowed channel already hosts this note; a completely empty
      // channel can still carry the independent voice on its own.
      channel = findIsolatedChannel(note);
    }
    if (channel !== null) {
      const key = noteKey(channel, note.note);
      // A same-note re-press landing on an occupied (other-note) channel folds
      // into that channel's voice space via a distinct key; different notes
      // keep distinct keys but share the channel, which is legal polyphony.
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

    // No channel can host the voice: fold into a same-note voice, or refuse.
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
    state.expression.set(noteId, { perNotePitchBend: null, polyPressure: [] });
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

    // A release changes channel occupancy: deferred per-note expression on the
    // remaining, still-sounding notes may now be deliverable. The releasing
    // note's own withheld bend can never sound and is closed as a documented
    // loss rather than silently dropped.
    const ownDeferred = state.deferred.get(noteId);
    state.deferred.delete(noteId);
    const flush = flushDeferred();
    const deferredLosses = [...flush.losses];
    const deferredOutputs = [...flush.outputs];
    if (ownDeferred) {
      state.diagnostics.refusal({ noteId, field: 'perNotePitchBend', reason: 'note released before isolation; withheld per-note bend never sounded', disposition: DISPOSITION.REFUSE });
      deferredLosses.push({ field: 'perNotePitchBend', fromBits: 32, toBits: 0, intended: ownDeferred.event.valueUnit, delivered: null, error: null, quantisable: false, note: 'staged bend expired at note release without an isolated channel' });
    }
    state.expression.delete(noteId);

    if (route.kind === 'identity') {
      const output = noteOffOutput(note, route.channel, 16);
      state.sink.wireVoices.delete(route.wireKey);
      record({ noteId, action: 'noteOff-identity', wireKey: route.wireKey, detail: null });
      const result = buildResult(event, { decision: 'noteOff-identity', outputs: [output, ...deferredOutputs], losses: deferredLosses, route }, { noteIds: [noteId] });
      attachPitchErrors(result, flush.pitchErrors);
      return result;
    }

    if (route.kind === 'channel' || route.kind === 'folded') {
      const voice = state.sink.wireVoices.get(route.wireKey);
      if (!voice) {
        return { input: event, decision: 'noteOff-unmatched', outputs: deferredOutputs, losses: deferredLosses, noteIds: [noteId], rejected: true, reason: 'wire voice no longer exists' };
      }
      voice.refcount -= 1;
      voice.members = voice.members.filter((id) => id !== noteId);
      if (voice.refcount > 0) {
        // The residue: the source released a key, the wire voice keeps sounding.
        const losses = [{
          field: 'noteOff', fromBits: 16, toBits: 0, intended: noteId, delivered: null, error: null, quantisable: false,
          note: `release suppressed: wire voice still held by ${voice.members.map((m) => '#' + m).join(', ')} (refcount ${voice.refcount})`,
        }, ...deferredLosses];
        record({ noteId, action: 'noteOff-suppressed', wireKey: route.wireKey, detail: `refcount=${voice.refcount}; residue=still sounding` });
        const result = buildResult(event, { decision: 'noteOff-suppressed', outputs: deferredOutputs, losses, route }, { noteIds: [noteId], residue: true });
        attachPitchErrors(result, flush.pitchErrors);
        return result;
      }
      const representative = state.notes.get(voice.primary) ?? note;
      const output = noteOffOutput(representative, voice.channel, PROTOCOLS[state.sink.protocol].velocityBits);
      state.sink.wireVoices.delete(route.wireKey);
      record({ noteId, action: 'noteOff-closes-voice', wireKey: route.wireKey, detail: `refcount 0; closes voice opened by #${voice.primary}` });
      const result = buildResult(event, { decision: route.kind === 'folded' ? 'noteOff-closes-folded' : 'noteOff', outputs: [output, ...deferredOutputs], losses: deferredLosses, route }, { noteIds: [noteId] });
      attachPitchErrors(result, flush.pitchErrors);
      return result;
    }

    // rejected voice: nothing on the wire to stop.
    record({ noteId, action: 'noteOff-rejected', wireKey: null, detail: 'voice was never taken over by the sink' });
    const result = buildResult(event, { decision: 'noteOff-rejected', outputs: deferredOutputs, losses: deferredLosses, route }, { noteIds: [noteId] });
    attachPitchErrors(result, flush.pitchErrors);
    return result;
  }

  function attachPitchErrors(result, pitchErrors) {
    if (pitchErrors?.length) result.pitchErrors = pitchErrors;
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
      // Keep per-note expression even on a wide sink so a later renegotiation
      // onto a low-capability endpoint can re-apply and re-quantise it.
      if (event.type === 'perNotePitchBend') {
        const note = findSoundingNoteForEvent(event);
        if (note) saveBendExpression(note.noteId, event);
      } else if (event.type === 'polyPressure') {
        const note = findSoundingNoteForEvent(event);
        if (note) {
          const expr = state.expression.get(note.noteId) ?? { perNotePitchBend: null, polyPressure: [] };
          expr.polyPressure.push({ valueUnit: event.valueUnit, code: event.valueRaw });
          state.expression.set(note.noteId, expr);
        }
      }
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
      for (const ch of channels) {
        state.diagnostics.quantisation({ field: 'controllerValue', valueUnit: event.valueUnit, bits, channel: ch, carrier: useSplit ? controlRule('controlChange', sink.protocol)?.altCarrier : controlRule('controlChange', sink.protocol)?.carrier });
      }
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
      for (const ch of channels) {
        state.diagnostics.quantisation({ field: 'pitchBend', valueUnit: event.valueUnit, bits: 14, channel: ch, carrier: controlRule('pitchBend', sink.protocol)?.carrier });
      }
      losses.push({ field: 'pitchBend', fromBits: 32, toBits: 14, intended: event.valueUnit, delivered: cmp.delivered, error: cmp.error, quantisable: true, note: 'bend reduced to a 14-bit wheel value' });
      decision = 'pitchBend-quantised-14bit';
    } else if (event.type === 'channelPressure') {
      const code = unitToUint(event.valueUnit, 7);
      for (const ch of channels) outputs.push(channelPressureMessage(sink.protocol, event.group, ch, code));
      const q = quantiseField(event.valueUnit, 7);
      state.diagnostics.quantisation({ field: 'channelPressure', valueUnit: event.valueUnit, bits: 7, channel: event.channel, carrier: controlRule('channelPressure', sink.protocol)?.carrier });
      losses.push({ field: 'channelPressure', fromBits: 32, toBits: 7, intended: event.valueUnit, delivered: q.deliveredUnit, error: q.error, quantisable: true, note: 'channel pressure reduced to 7 bits' });
      decision = 'channelPressure-quantised-7bit';
    } else if (event.type === 'polyPressure') {
      // Native (channel, note) carrier exists on every endpoint, so per-note
      // pressure maps cleanly — only its width is quantised.
      const note = findSoundingNoteForEvent(event);
      const targetChannels = note?.route?.channel != null ? [note.route.channel] : channels;
      const code = unitToUint(event.valueUnit, 7);
      for (const ch of targetChannels) outputs.push(polyPressureMessage(sink.protocol, event.group, ch, event.note, code));
      const q = quantiseField(event.valueUnit, 7);
      state.diagnostics.quantisation({ field: 'polyPressure', valueUnit: event.valueUnit, bits: 7, noteId: note?.noteId ?? null, channel: targetChannels[0], carrier: controlRule('polyPressure', sink.protocol)?.carrier });
      if (note) {
        const expr = state.expression.get(note.noteId) ?? { perNotePitchBend: null, polyPressure: [] };
        expr.polyPressure.push({ valueUnit: event.valueUnit, code });
        state.expression.set(note.noteId, expr);
      }
      losses.push({
        field: 'polyPressure', fromBits: 32, toBits: 7, intended: event.valueUnit, delivered: q.deliveredUnit,
        error: q.error, quantisable: true, disposition: DISPOSITION.CHANNEL,
        note: 'polyphonic key pressure has a native (channel, note) MIDI 1 carrier; only the 7-bit width is lost',
      });
      decision = 'polyPressure-channel-7bit';
    } else {
      // perNotePitchBend: identity is the hard part, resolved from live state.
      const result = handlePerNoteBend(event);
      return buildResult(event, result, { noteIds: result.noteIds ?? [] });
    }

    return buildResult(event, { decision, outputs, losses, route: null, extraEvents: extra }, {});
  }

  function polyPressureMessage(protocol, group, channel, note, value) {
    if (protocol === 'ump-midi1') {
      return emitUmp('ump-midi1', group, { type: 'midi1PolyPressure', channel, note, value }, `MIDI1 PolyPressure ch${channel} n${note}=${value}/127`);
    }
    return emitMidi1(group, [0xa0 | clampChannel(channel), note & 0x7f, value & 0x7f], `Legacy PolyPressure ch${channel} n${note}=${value}/127`);
  }

  // Per-note pitch bend against an identity-less endpoint. The disposition is
  // never assumed: it is resolved from the note's live isolation and the
  // configured policy, and every branch leaves a diagnostic behind.
  function handlePerNoteBend(event) {
    const sink = state.sink;
    const note = findSoundingNoteForEvent(event);
    const isolated = note ? isIsolated(note) : false;
    const freeChannelAvailable = note ? freeChannelExists(note) : false;
    const resolved = resolvePerNoteDisposition('perNotePitchBend', sink.protocol, {
      policy: state.policy.perNoteControl, isolated, freeChannelAvailable,
    });
    const losses = [];
    const outputs = [];
    let pitchErrors = [];
    let decision;
    const noteIds = note ? [note.noteId] : [];

    if (note) saveBendExpression(note.noteId, event);

    if (resolved.disposition === DISPOSITION.CHANNEL) {
      const applied = emitChannelBend(note, event);
      outputs.push(...applied.outputs);
      losses.push(...applied.losses);
      pitchErrors = [applied.pitchError];
      decision = isolated ? 'perNotePitchBend-isolated-channel' : 'perNotePitchBend-channel';
    } else if (resolved.disposition === DISPOSITION.EXTRA_CHANNEL && resolved.requiresMigration) {
      const moved = migrateNote(note, 'per-note pitch bend needs an isolated channel');
      if (!moved.ok) {
        state.diagnostics.refusal({ noteId: note.noteId, field: 'perNotePitchBend', reason: moved.reason, disposition: DISPOSITION.REFUSE });
        losses.push({ field: 'perNotePitchBend', fromBits: 32, toBits: 0, intended: event.valueUnit, delivered: null, error: null, quantisable: false, disposition: DISPOSITION.REFUSE, note: 'migration impossible: no free channel; bend refused rather than bending other notes' });
        return { decision: 'perNotePitchBend-refused', outputs: [], losses, route: null, noteIds, reason: moved.reason };
      }
      outputs.push(...moved.outputs);
      losses.push(...moved.losses);
      const applied = emitChannelBend(note, event);
      outputs.push(...applied.outputs);
      losses.push(...applied.losses);
      pitchErrors = [applied.pitchError];
      decision = 'perNotePitchBend-migrated';
    } else if (resolved.deferred) {
      state.deferred.set(note.noteId, { event, since: state.onOrder });
      state.diagnostics.deferred({ noteId: note.noteId, field: 'perNotePitchBend', valueUnit: event.valueUnit, reason: resolved.reason });
      // Another voice may already have ended, opening isolation: re-evaluate.
      const flush = flushDeferred();
      outputs.push(...flush.outputs);
      losses.push(...flush.losses);
      pitchErrors.push(...flush.pitchErrors);
      losses.push({ field: 'perNotePitchBend', fromBits: 32, toBits: 14, intended: event.valueUnit, delivered: null, error: null, quantisable: false, disposition: DISPOSITION.APPROXIMATE, note: resolved.reason });
      decision = 'perNotePitchBend-deferred';
    } else if (resolved.disposition === DISPOSITION.APPROXIMATE) {
      const code14 = unitToUint(event.valueUnit, 14);
      const channels = targetChannelsFor(event.group, event.channel);
      for (const ch of channels) outputs.push(pitchBendMessage(sink.protocol, event.group, ch, code14));
      const pitchError = recomputeBendError(event.valueUnit, { semitoneRange: 2, bits: 14 });
      pitchErrors = [{ noteId: note?.noteId ?? null, ...pitchError, channel: channels[0] }];
      state.diagnostics.quantisation({ field: 'perNotePitchBend', valueUnit: event.valueUnit, bits: 14, noteId: note?.noteId ?? null, channel: channels[0], carrier: 'midi1-pitchbend-14bit' });
      losses.push({
        field: 'perNotePitchBend', fromBits: 32, toBits: 14, intended: event.valueUnit,
        delivered: pitchError.deliveredUnit, error: pitchError.unitError,
        quantisable: false, disposition: DISPOSITION.APPROXIMATE,
        note: `${resolved.reason}; measured pitch error ${pitchError.centsError.toFixed(3)} cents`,
      });
      decision = 'perNotePitchBend-channel-approximate';
    } else {
      state.diagnostics.refusal({ noteId: note?.noteId ?? null, field: 'perNotePitchBend', reason: resolved.reason, disposition: DISPOSITION.REFUSE });
      losses.push({
        field: 'perNotePitchBend', fromBits: 32, toBits: 0, intended: event.valueUnit, delivered: null,
        error: null, quantisable: false, disposition: DISPOSITION.REFUSE, note: resolved.reason,
      });
      decision = 'perNotePitchBend-refused';
    }

    return { decision, outputs, losses, route: note?.route ?? null, noteIds, pitchErrors, reason: resolved.reason };
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
      pitchErrors: routed.pitchErrors ?? extra.pitchErrors ?? [],
      extraEvents: routed.extraEvents ?? Math.max(0, outputs.length - 1),
    };
  }

  // ---- public API ----------------------------------------------------------

  function handle(event) {
    const result = dispatch(event);
    return stampResult(result);
  }

  function dispatch(event) {
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

  // Switches the sink (or shrinks its channel list — a capability
  // renegotiation) and takes over every sounding voice, in original press
  // order so earlier voices keep priority for scarce channels. After a voice
  // is migrated, per-note expression it already held is re-applied on the new
  // channel and the realised pitch error is recomputed against the new
  // endpoint width; deferred bends get another chance once the dust settles.
  function setSink(config) {
    const from = state.sink;
    const channelsRemoved = from.availableChannels
      .filter((ch) => !(config.availableChannels ?? from.availableChannels).includes(ch));
    const next = normalizeSink(config);

    // Close every wire voice on the endpoint being left before re-routing.
    // Without this an explicit renegotiation (same protocol, fewer channels)
    // would strand voices on channels the new endpoint no longer owns — a
    // dangling note the renderer would never see released.
    const closureOutputs = [];
    const oldWireBits = PROTOCOLS[from.protocol].velocityBits;
    const oldSounding = [...state.notes.values()]
      .filter((n) => n.state === 'sounding')
      .sort((a, b) => a.onOrder - b.onOrder);
    const closedKeys = new Set();
    for (const note of oldSounding) {
      const route = note.route;
      if ((route.kind === 'channel' || route.kind === 'folded') && !closedKeys.has(route.wireKey)) {
        closureOutputs.push(noteOffOutput(note, route.channel, oldWireBits));
        closedKeys.add(route.wireKey);
      }
    }
    from.wireVoices.clear();

    state.sink = next;
    const decisions = [];
    const outputs = [...closureOutputs];
    const losses = [];
    const pitchErrors = [];
    const sounding = [...state.notes.values()]
      .filter((n) => n.state === 'sounding')
      .sort((a, b) => a.onOrder - b.onOrder);
    for (const note of sounding) {
      const routed = routeNote(note, { takeover: true });
      note.route = routed.route;
      decisions.push({ noteId: note.noteId, note: note.note, group: note.group, decision: routed.decision, reason: routed.reason ?? null, wireKey: routed.route.wireKey ?? null, channel: routed.route.channel ?? null });
      outputs.push(...routed.outputs);
      losses.push(...routed.losses);
      record({ noteId: note.noteId, action: routed.decision, wireKey: routed.route.wireKey ?? null, detail: routed.reason ?? null });
    }

    // Re-apply stored per-note expression on the endpoint that now carries it.
    if (isNarrow(next.protocol)) {
      for (const note of sounding) {
        if (note.route.kind === 'rejected') continue;
        const expr = state.expression.get(note.noteId);
        if (!expr) continue;
        if (expr.perNotePitchBend) {
          const bendEvent = { group: note.group, channel: note.route.channel, note: note.note, valueUnit: expr.perNotePitchBend.valueUnit, valueRaw: expr.perNotePitchBend.valueRaw };
          if (isIsolated(note)) {
            const applied = emitChannelBend(note, bendEvent);
            outputs.push(...applied.outputs);
            losses.push(...applied.losses);
            pitchErrors.push(applied.pitchError);
            state.deferred.delete(note.noteId);
          } else if (state.policy.perNoteControl === 'staged-degrade') {
            if (!state.deferred.has(note.noteId)) state.deferred.set(note.noteId, { event: bendEvent, since: state.onOrder });
          }
        }
        const lastPressure = expr.polyPressure[expr.polyPressure.length - 1];
        if (lastPressure && note.route.channel != null) {
          const code = unitToUint(lastPressure.valueUnit, 7);
          outputs.push(polyPressureMessage(next.protocol, note.group, note.route.channel, note.note, code));
          state.diagnostics.quantisation({ field: 'polyPressure', valueUnit: lastPressure.valueUnit, bits: 7, noteId: note.noteId, channel: note.route.channel, carrier: controlRule('polyPressure', next.protocol)?.carrier });
        }
      }
      const flush = flushDeferred();
      outputs.push(...flush.outputs);
      losses.push(...flush.losses);
      pitchErrors.push(...flush.pitchErrors);
    }

    const renegotiation = {
      protocolChanged: from.protocol !== next.protocol,
      channelsRemoved,
      channelCountBefore: from.availableChannels.length,
      channelCountAfter: next.availableChannels.length,
    };
    return {
      from: from.protocol,
      to: next.protocol,
      availableChannels: next.availableChannels,
      renegotiation,
      decisions,
      outputs,
      losses,
      pitchErrors,
      extraEvents: Math.max(0, outputs.length - sounding.length),
    };
  }

  // Stamps every output of a result with its loop-guard echo token and a
  // stable content key, so a peer bridge can recognise its own echo.
  function stampResult(result) {
    for (const output of result.outputs ?? []) {
      const kind = output.description?.split(' ')[0] ?? output.protocol;
      state.loopGuard.stamp(output, kind, {
        protocol: output.protocol,
        group: output.group,
        hex: output.hex,
        noteIds: result.noteIds ?? [],
      });
    }
    return result;
  }

  // Bidirectional entry point. `mark` is the loop-guard token the peer bridge
  // stamped on the event it converted. An event that is an echo of something
  // this bridge emitted is dropped once and recorded; new events are handled.
  function handleFromPeer(event, mark = null) {
    const payload = { type: event.type, group: event.group, channel: event.channel ?? null, note: event.note ?? null, sourceNoteId: event.sourceNoteId ?? null, valueUnit: event.valueUnit ?? null };
    if (state.loopGuard.isEcho(event.type, payload, mark)) {
      state.diagnostics.loop({ action: 'echo-suppressed', type: event.type, note: event.note ?? null });
      return {
        input: event, decision: 'loop-echo-suppressed', outputs: [], losses: [], noteIds: [],
        rejected: true, reason: 'returning echo of an event this bridge already emitted',
      };
    }
    const result = dispatch(event);
    return stampResult(result);
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
    const deferred = [...state.deferred.entries()].map(([noteId, item]) => ({
      noteId, note: state.notes.get(noteId)?.note ?? null,
      valueUnit: item.event.valueUnit, channel: state.notes.get(noteId)?.route?.channel ?? null,
    }));
    return {
      sink: state.sink.protocol,
      availableChannels: state.sink.availableChannels,
      sounding,
      wireVoices,
      deferred,
      expression: [...state.expression.entries()].map(([noteId, expr]) => ({ noteId, ...expr })),
      diagnostics: state.diagnostics.all(),
      diagnosticViolations: state.diagnostics.violations(),
      loopGuard: state.loopGuard.stats(),
      trace: [...state.trace],
    };
  }

  return {
    handle,
    handleFromPeer,
    setSink,
    snapshot,
    get policy() { return state.policy; },
    setPolicy(patch) { state.policy = { ...state.policy, ...patch }; },
    get sinkProtocol() { return state.sink.protocol; },
    notes: () => state.notes,
    diagnostics: () => state.diagnostics,
    loopGuard: () => state.loopGuard,
    deferred: () => new Map(state.deferred),
  };
}
