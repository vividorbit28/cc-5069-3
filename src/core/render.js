// Test processor / render engine.
//
// Consumes the actual messages the bridge emits (decoded UMP words or legacy
// MIDI bytes), rebuilds receiver-side voices and records when each voice starts
// and stops. Acceptance therefore depends on what the sink would really hear,
// not on what the bridge intended.
//
// Never trusts the bridge's bookkeeping: if the bridge emits no Note Off, the
// voice stays sounding here and the residue is visible.

import { decodeUmp } from './ump.js';

export function parseOutput(output) {
  if (output.encoding === 'ump') {
    const { message } = decodeUmp(output.words, 0);
    return { ...message, group: output.group, port: output.protocol };
  }
  // legacy byte stream, only the small set the bridge emits
  const bytes = output.bytes;
  const status = bytes[0];
  const kind = status & 0xf0;
  const channel = status & 0x0f;
  const group = output.group;
  if (kind === 0x90) return { type: bytes[2] > 0 ? 'noteOn' : 'noteOff', channel, note: bytes[1] & 0x7f, velocity: bytes[2] & 0x7f, group, port: output.protocol };
  if (kind === 0x80) return { type: 'noteOff', channel, note: bytes[1] & 0x7f, velocity: bytes[2] & 0x7f, group, port: output.protocol };
  if (kind === 0xb0) return { type: 'controlChange', channel, controller: bytes[1] & 0x7f, value: bytes[2] & 0x7f, group, port: output.protocol };
  if (kind === 0xa0) return { type: 'polyPressure', channel, note: bytes[1] & 0x7f, value: bytes[2] & 0x7f, group, port: output.protocol };
  if (kind === 0xe0) return { type: 'pitchBend', channel, value: (bytes[2] & 0x7f) * 128 + (bytes[1] & 0x7f), group, port: output.protocol };
  if (kind === 0xd0) return { type: 'channelPressure', channel, value: bytes[1] & 0x7f, group, port: output.protocol };
  if (status === 0xf0) return { type: 'sysex', data: bytes.slice(1, -1), group, port: output.protocol };
  return { type: 'unknown', group, port: output.protocol, bytes };
}

export function createRenderer() {
  const voices = new Map(); // wireKey -> voice
  const timeline = []; // every wire event with time
  let nextVoiceId = 1;
  const portStatus = new Map(); // portId -> { open, closedAt }

  function voiceKeyFor(msg) {
    if (msg.type !== 'noteOn' && msg.type !== 'noteOff') return null;
    if (msg.port === 'ump-midi2' && Number.isInteger(msg.noteId)) {
      return `id:${msg.group}:${msg.noteId}`;
    }
    return `ch:${msg.port}:${msg.group}:${msg.channel}:${msg.note}`;
  }

  function closePort(port, atMs) {
    const at = atMs ?? (timeline.length ? timeline[timeline.length - 1].atMs : 0);
    portStatus.set(port, { open: false, closedAt: at });
    for (const v of voices.values()) {
      if (v.port === port && v.endMs == null) {
        v.endMs = at;
        v.endedBy = 'port-switch';
      }
    }
  }

  // Feeds one batch of bridge outputs emitted at `atMs` on port `port`.
  function feed(atMs, port, outputs) {
    if (portStatus.get(port)?.open === false) portStatus.set(port, { open: true, closedAt: null });
    else if (!portStatus.has(port)) portStatus.set(port, { open: true, closedAt: null });
    for (const output of outputs) {
      const msg = parseOutput(output);
      timeline.push({ atMs, port: output.protocol, message: msg, hex: output.hex });
      if (msg.type === 'noteOn') {
        const key = voiceKeyFor(msg);
        const existing = voices.get(key);
        if (existing && existing.endMs == null) existing.endMs = atMs; // retrigger closes previous
        const voice = {
          voiceId: nextVoiceId++,
          key,
          port: msg.port,
          group: msg.group,
          channel: msg.channel,
          note: msg.note,
          velocity: msg.velocity,
          levelUnit: msg.port === 'ump-midi2' ? msg.velocity / 0xffff : msg.velocity / 127,
          wireIdentity: msg.port === 'ump-midi2' && Number.isInteger(msg.noteId) ? msg.noteId : null,
          startMs: atMs,
          endMs: null,
          endedBy: null,
          foldedMembers: [],
        };
        voices.set(key, voice);
      } else if (msg.type === 'noteOff') {
        const key = voiceKeyFor(msg);
        const voice = voices.get(key);
        if (voice && voice.endMs == null) {
          voice.endMs = atMs;
          voice.endedBy = 'noteOff';
        } else {
          timeline[timeline.length - 1].origin = 'unmatched-noteOff';
        }
      }
    }
  }

  function at(timeMs) {
    return [...voices.values()]
      .filter((v) => v.startMs <= timeMs && (v.endMs == null || v.endMs > timeMs))
      .map((v) => ({ voiceId: v.voiceId, port: v.port, channel: v.channel, note: v.note, velocity: v.velocity, wireIdentity: v.wireIdentity }));
  }

  function report() {
    const list = [...voices.values()].sort((a, b) => a.startMs - b.startMs || a.voiceId - b.voiceId);
    const unmatchedOffs = timeline.filter((t) => t.origin === 'unmatched-noteOff').length;
    const stillSounding = list.filter((v) => v.endMs == null);
    return {
      voices: list,
      timeline,
      unmatchedOffs,
      stillSounding,
      // Every wire Note On must have one matching Note Off for bounded events.
      balanced: unmatchedOffs === 0 && stillSounding.length === 0,
    };
  }

  return { feed, at, report, closePort, voices };
}

// Convenience: run a whole plan of {atMs, ports:{[port]: outputs}} batches.
export function renderPlan(batches) {
  const r = createRenderer();
  for (const batch of batches) {
    for (const [port, outputs] of Object.entries(batch.ports ?? {})) {
      r.feed(batch.atMs, port, outputs);
    }
    for (const port of batch.closePorts ?? []) r.closePort(port, batch.atMs);
  }
  return r;
}
