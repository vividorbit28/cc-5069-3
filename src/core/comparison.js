// Comparison of the two degradation strategies when a high-precision per-note
// expression meets a low-capability endpoint.
//
//   migrate-note      the addressed note is re-homed onto a free channel the
//                     moment the per-note control arrives; a channel carrier
//                     there reaches only that note. The expression is exact
//                     (modulo endpoint quantisation), but the move costs a
//                     Note Off / Note On pair and consumes a channel.
//
//   staged-degrade    the note stays put; the expression is withheld until the
//                     note can be isolated at a release / renegotiation. No
//                     retrigger while overlapping voices sound, but the bend is
//                     not heard during the overlap — a measured, reported loss.
//
// Both strategies are driven through the real bridge and the real renderer, so
// the numbers come from what would actually sound, not from intent.

import { createBridge } from './bridge.js';
import { createRenderer } from './render.js';
import { eventFromUmp } from './internal.js';
import { decodeUmpStream, encodeUmp } from './ump.js';

function toEvent(packet, group = 0) {
  const words = encodeUmp(packet, { group });
  const { events, errors } = decodeUmpStream(words);
  if (errors.length) throw new Error('comparison fixture failed: ' + JSON.stringify(errors));
  return eventFromUmp(events[0].group, events[0].message);
}

// A fixed musical situation: two notes share channel 0 on a two-channel
// identity-less endpoint, and a per-note bend targets the first note while both
// still sound. The third channel is a migration target in the wide setting.
function buildPlan({ channels, bendUnit }) {
  const bendRaw = Math.round(bendUnit * 0xffffffff) >>> 0;
  return {
    pressA: toEvent({ type: 'noteOn', channel: 0, note: 60, velocity: 0xffff, noteId: 1 }),
    pressB: toEvent({ type: 'noteOn', channel: 0, note: 64, velocity: 0xffff, noteId: 2 }),
    bend: toEvent({ type: 'perNotePitchBend', channel: 0, note: 60, value: bendRaw, noteId: 1 }),
    releaseA: toEvent({ type: 'noteOff', channel: 0, note: 60, velocity: 0, noteId: 1 }),
    releaseB: toEvent({ type: 'noteOff', channel: 0, note: 64, velocity: 0, noteId: 2 }),
    channels,
  };
}

function runOne(strategy, { channels, bendUnit, shrinkTo = null }) {
  const plan = buildPlan({ channels, bendUnit });
  // Start identity-capable so both presses keep their own instance, then
  // renegotiate down to the low-capability endpoint before the bend arrives.
  const bridge = createBridge({
    sink: { protocol: 'ump-midi2' },
    policy: { perNoteControl: strategy, noteConflict: 'fold' },
    bridgeId: `cmp-${strategy}`,
  });
  const renderer = createRenderer();
  const feed = (t, result) => renderer.feed(t, bridge.sinkProtocol, result.outputs);
  const trace = [];

  feed(0, bridge.handle(plan.pressA));
  feed(1, bridge.handle(plan.pressB));
  const renegotiated = bridge.setSink({ protocol: 'legacy', availableChannels: channels });
  renderer.closePort('ump-midi2', 2);
  feed(2, { outputs: renegotiated.outputs });

  const bendResult = bridge.handle(plan.bend);
  feed(3, bendResult);
  trace.push({ stage: 'bend', decision: bendResult.decision, outputs: bendResult.outputs.length });

  let shrink = null;
  if (shrinkTo) {
    shrink = bridge.setSink({ protocol: 'legacy', availableChannels: shrinkTo });
    feed(4, { outputs: shrink.outputs });
    trace.push({ stage: 'channel-shrink', removed: shrink.renegotiation.channelsRemoved, decisions: shrink.decisions.map((d) => d.decision) });
  }

  const releaseAResult = bridge.handle(plan.releaseA);
  feed(5, releaseAResult);
  trace.push({ stage: 'releaseA', decision: releaseAResult.decision, outputs: releaseAResult.outputs.length });
  const releaseBResult = bridge.handle(plan.releaseB);
  feed(6, releaseBResult);
  trace.push({ stage: 'releaseB', decision: releaseBResult.decision, outputs: releaseBResult.outputs.length });

  const report = renderer.report();
  const wireEvents = report.timeline.map((t) => ({ atMs: t.atMs, type: t.message.type, channel: t.message.channel, note: t.message.note, value: t.message.value ?? null }));
  const retriggerCount = report.voices.filter((v) => v.endedBy === 'noteOff' && v.note === 60).length - 1;
  const bendsHeard = wireEvents.filter((e) => e.type === 'pitchBend');
  const diagnostics = bridge.diagnostics();

  return {
    strategy,
    trace,
    bendDecision: bendResult.decision,
    bendDeliveredDuringOverlap: bendsHeard.some((e) => e.atMs <= 4),
    bendChannel: bendsHeard[0]?.channel ?? null,
    retriggerCount: Math.max(0, retriggerCount),
    pitchErrors: bendResult.pitchErrors ?? renegotiated.pitchErrors ?? shrink?.pitchErrors ?? [],
    deferredAtBend: bridge.snapshot().deferred.length,
    wireEvents,
    balanced: report.balanced,
    unmatchedOffs: report.unmatchedOffs,
    stillSounding: report.stillSounding.length,
    diagnosticViolations: diagnostics.violations(),
    losses: [...(bendResult.losses ?? []), ...(releaseAResult.losses ?? [])],
  };
}

// Runs both strategies against the same musical situation and contrasts them
// on the axes a musician actually cares about.
export function compareDegradationStrategies({
  channels = [0, 1, 2],
  bendUnit = 0.625, // an upward bend off centre
  shrinkTo = null,
} = {}) {
  const migration = runOne('migrate-note', { channels, bendUnit, shrinkTo });
  const staged = runOne('staged-degrade', { channels, bendUnit, shrinkTo });

  const contrast = [
    {
      axis: 'expression heard while both notes overlap',
      migrateNote: migration.bendDeliveredDuringOverlap ? 'yes, on a dedicated channel' : 'no',
      stagedDegrade: staged.bendDeliveredDuringOverlap ? 'yes' : 'no — withheld until isolation',
    },
    {
      axis: 'retriggers (Note Off/On pairs) on the bent note',
      migrateNote: migration.retriggerCount,
      stagedDegrade: staged.retriggerCount,
    },
    {
      axis: 'channels consumed',
      migrateNote: `moves the note onto a free channel (needs ${channels.length} available)`,
      stagedDegrade: 'none extra; the note keeps its current channel',
    },
    {
      axis: 'behaviour when no channel is free',
      migrateNote: 'refuses the bend with a preserved reason rather than bending the neighbour',
      stagedDegrade: 'defers the bend; it is applied at the next release or expired as a documented loss',
    },
    {
      axis: 'measured pitch error',
      migrateNote: describeError(migration),
      stagedDegrade: describeError(staged),
    },
    {
      axis: 'wire balance (every Note On closed once)',
      migrateNote: migration.balanced,
      stagedDegrade: staged.balanced,
    },
  ];

  return {
    params: { channels, bendUnit, shrinkTo },
    migration,
    staged,
    contrast,
    recommendation: 'migrate-note keeps the expression exact but costs a channel and a retrigger; staged-degrade avoids the retrigger and channel cost but the bend is silent during overlap — choose by whether pitch timing or voice stability matters more.',
  };
}

function describeError(run) {
  const err = run.pitchErrors[0];
  if (!err) return 'no bend delivered';
  return `${err.centsError.toFixed(3)} cents (code ${err.code}/${err.maxCode} at ${err.bits} bit)`;
}
