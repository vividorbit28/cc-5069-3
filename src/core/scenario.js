// Acceptance scenario driver.
//
// Reproduces the review scenario end to end with real arithmetic:
//   1. Two simultaneous presses of the same key arrive on a high-resolution
//      port, each with its own 16-bit note identity.
//   2. Mid-performance the bridge switches to a legacy channel-only port, in a
//      setting with a free channel and one with every channel occupied.
//   3. Each key is released in turn.
// The renderer replays the messages the bridge actually emitted and reports
// which voices keep sounding and what residue a single release leaves behind.

import { decodeUmpStream } from './ump.js';
import { eventFromUmp } from './internal.js';
import { createBridge } from './bridge.js';
import { createRenderer } from './render.js';
import { encodeUmp } from './ump.js';

function decodeAll(words) {
  const { events, errors } = decodeUmpStream(words);
  return { events: events.map((e) => eventFromUmp(e.group, e.message)), errors };
}

// Builds the standard two-same-note press stream.
function duplicatePressWords({ note = 60, channel = 0, idA = 1, idB = 2, velA = 0xffff, velB = 0x8000 } = {}) {
  return {
    onA: encodeUmp({ type: 'noteOn', channel, note, velocity: velA, noteId: idA }, { group: 0 }),
    onB: encodeUmp({ type: 'noteOn', channel, note, velocity: velB, noteId: idB }, { group: 0 }),
    offA: encodeUmp({ type: 'noteOff', channel, note, velocity: 0, noteId: idA }, { group: 0 }),
    offB: encodeUmp({ type: 'noteOff', channel, note, velocity: 0, noteId: idB }, { group: 0 }),
  };
}

const compactLoss = (l) => ({
  field: l.field,
  fromBits: l.fromBits,
  toBits: l.toBits,
  error: l.error,
  quantisable: l.quantisable,
  note: l.note,
});

export function runSwitchScenario({
  note = 60,
  availableChannels = [0, 1, 2, 3],
  noteConflict = 'fold',
  controlResolution = 'split',
  occupiedNotes = [],
} = {}) {
  const words = duplicatePressWords({ note });
  const { events, errors } = decodeAll([...words.onA, ...words.onB]);
  if (errors.length) throw new Error('scenario fixture failed to decode: ' + JSON.stringify(errors));

  const bridge = createBridge({ sink: { protocol: 'ump-midi2' }, policy: { noteConflict, controlResolution } });
  const renderer = createRenderer();
  const steps = [];
  let t = 0;

  const feedResult = (atMs, port, result, label) => {
    renderer.feed(atMs, port, result.outputs);
    steps.push({
      atMs,
      label,
      decision: result.decision,
      reason: result.reason ?? null,
      outputs: result.outputs.map((o) => ({ protocol: o.protocol, hex: o.hex, description: o.description })),
      losses: (result.losses ?? []).map(compactLoss),
      noteIds: result.noteIds ?? [],
      residue: result.residue ?? false,
      soundingAfter: renderer.at(atMs + 0.001).map(slimVoice),
    });
  };
  const slimVoice = (v) => ({ voiceId: v.voiceId, port: v.port, channel: v.channel, note: v.note, velocity: v.velocity, wireIdentity: v.wireIdentity });

  // Occupy channels with other notes first (identity sink keeps them independent).
  for (const [i, n] of occupiedNotes.entries()) {
    const w = encodeUmp({ type: 'noteOn', channel: 0, note: n, velocity: 0xffff, noteId: 100 + i }, { group: 0 });
    const ev = decodeAll(w).events[0];
    const res = bridge.handle(ev);
    feedResult(t, 'ump-midi2', res, `occupying note ${n}`);
    t += 1;
  }

  const first = decodeAll(words.onA).events[0];
  const second = decodeAll(words.onB).events[0];
  feedResult(t, 'ump-midi2', bridge.handle(first), `press A n${note} #1`);
  t += 1;
  feedResult(t, 'ump-midi2', bridge.handle(second), `press B n${note} #2`);
  t += 1;

  const switchAt = t;
  const switched = bridge.setSink({ protocol: 'legacy', availableChannels });
  const switchResult = {
    decision: 'switch-sink',
    reason: `moved to legacy port with channels [${availableChannels.join(', ')}]`,
    outputs: switched.outputs,
    losses: switched.losses,
    noteIds: switched.decisions.map((d) => d.noteId),
    residue: false,
  };
  renderer.feed(switchAt, 'legacy', switched.outputs);
  renderer.closePort('ump-midi2', switchAt);
  steps.push({
    atMs: switchAt,
    label: 'switch to legacy sink',
    decision: 'switch-sink',
    reason: switchResult.reason,
    decisions: switched.decisions,
    outputs: switched.outputs.map((o) => ({ protocol: o.protocol, hex: o.hex, description: o.description })),
    losses: switched.losses.map(compactLoss),
    noteIds: switchResult.noteIds,
    residue: false,
    soundingAfter: renderer.at(switchAt + 0.001).map(slimVoice),
  });
  t = switchAt + 1;

  const offA = decodeAll(words.offA).events[0];
  const releaseA = bridge.handle(offA);
  feedResult(t, 'legacy', releaseA, `release A n${note} #1`);
  t += 1;
  const afterA = renderer.at(t).map(slimVoice);

  const offB = decodeAll(words.offB).events[0];
  const releaseB = bridge.handle(offB);
  feedResult(t, 'legacy', releaseB, `release B n${note} #2`);
  t += 1;
  const afterB = renderer.at(t).map(slimVoice);

  const report = renderer.report();
  const foldDecision = switched.decisions.find((d) => d.decision === 'takeover-fold');
  const refuseDecision = switched.decisions.find((d) => d.decision === 'takeover-refuse');
  const splitCount = switched.decisions.filter((d) => d.decision === 'takeover-split').length;

  // Acceptance: independent release survives iff both same-note voices each
  // got their own channel. After releasing only A, exactly one voice should
  // still sound (B's), and after releasing B nothing should sound.
  const independentRelease = splitCount === 2 && afterA.length === 1 && afterB.length === 0;
  const residueAfterSingleRelease = afterA.length;

  return {
    params: { note, availableChannels: [...availableChannels], noteConflict, controlResolution, occupiedNotes: [...occupiedNotes] },
    steps,
    switchDecisions: switched.decisions,
    decisionSummary: {
      splits: splitCount,
      folds: foldDecision ? 1 : 0,
      refusals: refuseDecision ? 1 : 0,
    },
    afterReleaseA: afterA,
    afterReleaseB: afterB,
    independentRelease,
    residueAfterSingleRelease,
    quantifiableLoss: lostFields(switched.losses),
    destructiveLoss: destructiveFields(switched.losses),
    renderer: {
      voices: report.voices.map((v) => ({
        voiceId: v.voiceId,
        port: v.port,
        channel: v.channel,
        note: v.note,
        velocity: v.velocity,
        levelUnit: v.levelUnit,
        wireIdentity: v.wireIdentity,
        startMs: v.startMs,
        endMs: v.endMs,
        endedBy: v.endedBy,
      })),
      balanced: report.balanced,
      stillSounding: report.stillSounding.map(slimVoice),
      unmatchedOffs: report.unmatchedOffs,
      timeline: report.timeline.map((x) => ({ atMs: x.atMs, port: x.port, type: x.message.type, hex: x.hex })),
    },
    decodeErrors: errors,
  };
}

function lostFields(losses) {
  const out = [];
  for (const l of losses) {
    if (l.field === 'velocity' && l.error != null && l.error > 0) {
      out.push({ field: 'velocity', error: l.error, bits: l.toBits, note: 'velocity re-quantised to the sink width' });
    }
    if (l.field === 'controllerValue' && l.error != null && l.error > 0) {
      out.push({ field: 'controllerValue', error: l.error, bits: l.toBits, note: l.note });
    }
  }
  return out;
}

function destructiveFields(losses) {
  return losses
    .filter((l) => l.quantisable === false)
    .map((l) => ({ field: l.field, note: l.note }));
}

export { duplicatePressWords, decodeAll };
