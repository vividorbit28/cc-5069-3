// Event-degradation regression suite.
//
// These tests pin the behaviour required when a high-precision source meets a
// lower-capability endpoint: which per-note controls map to a real channel
// carrier, which must be refused / approximated / given an extra channel, how
// the two strategies compare, what capability renegotiation does to sounding
// voices, and that the diagnostic store and the bidirectional loop guard keep
// their contracts. Assertions run against the renderer's view of what would
// actually sound, not against the bridge's intent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../src/core/bridge.js';
import { eventFromUmp } from '../src/core/internal.js';
import { decodeUmpStream, encodeUmp } from '../src/core/ump.js';
import { createRenderer, parseOutput } from '../src/core/render.js';
import {
  DISPOSITION, resolvePerNoteDisposition, controlRule, staticDisposition,
  recomputeBendError, quantiseField, degradationCatalogue,
} from '../src/core/degradation.js';
import { compareDegradationStrategies } from '../src/core/comparison.js';
import { createLoopGuard, ECHO_MARK } from '../src/core/loopguard.js';

const ev = (words) => {
  const { events, errors } = decodeUmpStream(words);
  if (errors.length) throw new Error(JSON.stringify(errors));
  return eventFromUmp(events[0].group, events[0].message);
};
const on = (o = {}) => ev(encodeUmp({ type: 'noteOn', channel: 0, note: 60, velocity: 0xffff, noteId: 1, ...o }));
const off = (o = {}) => ev(encodeUmp({ type: 'noteOff', channel: 0, note: 60, velocity: 0, noteId: 1, ...o }));
const bend = (value, o = {}) => ev(encodeUmp({ type: 'perNotePitchBend', channel: 0, note: 60, value, ...o }));
const poly = (value, o = {}) => ev(encodeUmp({ type: 'polyPressure', channel: 0, note: 60, value, ...o }));

// ---- static rule matrix ----------------------------------------------------

test('degradation catalogue classifies every control against every endpoint', () => {
  const catalogue = degradationCatalogue();
  const perNoteBendLegacy = catalogue.find((c) => c.type === 'perNotePitchBend' && c.endpoint === 'legacy');
  assert.equal(perNoteBendLegacy.staticDisposition, null, 'per-note bend has no static answer on an identity-less port');
  assert.equal(perNoteBendLegacy.carrier, 'midi1-pitchbend-14bit');

  assert.equal(staticDisposition('controlChange', 'legacy'), DISPOSITION.CHANNEL);
  assert.equal(staticDisposition('polyPressure', 'ump-midi1'), DISPOSITION.CHANNEL);
  assert.equal(staticDisposition('perNotePitchBend', 'ump-midi2'), DISPOSITION.CHANNEL);
  assert.equal(controlRule('polyPressure', 'legacy').carrier, 'midi1-poly-pressure-7bit');
});

test('per-note bend resolves to channel / extra-channel / approximate / refuse from live state', () => {
  assert.equal(resolvePerNoteDisposition('perNotePitchBend', 'legacy', { policy: 'drop', isolated: false }).disposition, DISPOSITION.REFUSE);
  assert.equal(resolvePerNoteDisposition('perNotePitchBend', 'legacy', { policy: 'channel-approximate', isolated: false }).disposition, DISPOSITION.APPROXIMATE);
  const migrate = resolvePerNoteDisposition('perNotePitchBend', 'legacy', { policy: 'migrate-note', isolated: false, freeChannelAvailable: true });
  assert.equal(migrate.disposition, DISPOSITION.EXTRA_CHANNEL);
  assert.equal(migrate.requiresMigration, true);
  const noRoom = resolvePerNoteDisposition('perNotePitchBend', 'legacy', { policy: 'migrate-note', isolated: false, freeChannelAvailable: false });
  assert.equal(noRoom.disposition, DISPOSITION.REFUSE);
  const isolated = resolvePerNoteDisposition('perNotePitchBend', 'legacy', { policy: 'migrate-note', isolated: true });
  assert.equal(isolated.disposition, DISPOSITION.CHANNEL);
  const staged = resolvePerNoteDisposition('perNotePitchBend', 'legacy', { policy: 'staged-degrade', isolated: false });
  assert.equal(staged.disposition, DISPOSITION.APPROXIMATE);
  assert.equal(staged.deferred, true);
});

// ---- high-resolution gradient ----------------------------------------------

test('a high-resolution controller gradient keeps fine steps on a wide sink and records endpoint quantisation on a narrow one', () => {
  const wide = createBridge({ sink: { protocol: 'ump-midi2' } });
  const narrow = createBridge({ sink: { protocol: 'legacy', availableChannels: [0] }, policy: { controlResolution: 'quantise' } });
  const step = Math.floor(0xffffffff / 256);
  const wideValues = new Set();
  const narrowValues = new Set();
  for (let i = 0; i < 8; i++) {
    const value = (0x10000000 + i * step) >>> 0;
    const event = ev(encodeUmp({ type: 'controlChange', channel: 0, controller: 1, value }));
    wideValues.add(decodeUmpStream(wide.handle(event).outputs[0].words).events[0].message.value);
    narrowValues.add(narrow.handle(event).outputs[0].hex);
  }
  assert.equal(wideValues.size, 8, 'wide sink preserves every fine step');
  assert.ok(narrowValues.size < 8, 'a 7-bit sink collapses sub-code steps onto the same delivered value');

  const quant = narrow.diagnostics().byKind('quantisation');
  assert.ok(quant.length === 8);
  for (const q of quant) {
    assert.equal(q.bits, 7);
    assert.ok(q.violations.length === 0, 'endpoint nearest-code rule holds for every step');
  }
  assert.equal(narrow.diagnostics().violations().length, 0, 'monotonicity holds across the gradient');
});

test('distinct inputs that collapse onto one code are kept in the state-merge diagnostic', () => {
  const diagnostics = narrowBridgeDiagnostics();
  const merges = diagnostics.byKind('state-merge');
  assert.ok(merges.length >= 1);
  const m = merges[0];
  assert.ok(m.distinctInputs >= 2);
  assert.ok(m.inputSpread > 0);
  assert.equal(m.violations.length, 0, 'every merged intended value rounds to the shared code');
});

function narrowBridgeDiagnostics() {
  const b = createBridge({ sink: { protocol: 'legacy', availableChannels: [0] }, policy: { controlResolution: 'quantise' } });
  const near = (u) => Math.round(u * 0xffffffff) >>> 0;
  const a = ev(encodeUmp({ type: 'controlChange', channel: 0, controller: 1, value: near(0.5000) }));
  const c = ev(encodeUmp({ type: 'controlChange', channel: 0, controller: 1, value: near(0.502) }));
  const ra = b.handle(a);
  const rc = b.handle(c);
  assert.equal(ra.outputs[0].hex, rc.outputs[0].hex, 'both map to one 7-bit code');
  const d = b.diagnostics();
  const recA = d.byKind('quantisation').find((r) => Math.abs(r.intendedUnit - 0.5) < 1e-9);
  const recC = d.byKind('quantisation').find((r) => Math.abs(r.intendedUnit - (near(0.502) / 0xffffffff)) < 1e-9);
  recA.collapsed = true;
  d.merge({ field: 'controllerValue', bits: 7, intendedUnits: [recA.intendedUnit, recC.intendedUnit], code: recA.code, reason: 'test merge' });
  return d;
}

// ---- poly pressure maps to a real carrier ----------------------------------

test('polyphonic pressure maps to a native MIDI 1 carrier and only loses width', () => {
  const b = createBridge({ sink: { protocol: 'legacy', availableChannels: [0] } });
  b.handle(on());
  const r = b.handle(poly(0x80000000));
  assert.equal(r.decision, 'polyPressure-channel-7bit');
  assert.equal(r.outputs.length, 1);
  const msg = parseOutput(r.outputs[0]);
  assert.equal(msg.type, 'polyPressure');
  assert.equal(msg.note, 60);
  assert.ok(r.losses[0].quantisable);
  assert.equal(r.losses[0].disposition, DISPOSITION.CHANNEL);
  assert.equal(b.diagnostics().violations().length, 0);
});

// ---- multi-voice independent bends -----------------------------------------

test('migrate-note gives two overlapping notes independent bends on separate channels', () => {
  const b = createBridge({ sink: { protocol: 'ump-midi2' }, policy: { perNoteControl: 'migrate-note' } });
  const renderer = createRenderer();
  b.handle(on({ note: 60, noteId: 1 }));
  b.handle(on({ note: 64, noteId: 2 }));
  // Three channels: the two notes share channel 0 after takeover, leaving
  // channels 1-2 free so the migration target proves the move really happens.
  const sw = b.setSink({ protocol: 'legacy', availableChannels: [0, 1, 2] });
  renderer.feed(0, 'legacy', sw.outputs);
  assert.deepEqual([...new Set(sw.decisions.map((d) => d.channel))], [0], 'takeover packs distinct notes onto one shared channel');

  const bendA = b.handle(bend(0x90000000, { note: 60, noteId: 1 }));
  assert.equal(bendA.decision, 'perNotePitchBend-migrated');
  renderer.feed(1, 'legacy', bendA.outputs);
  const bendB = b.handle(bend(0x70000000, { note: 64, noteId: 2 }));
  renderer.feed(2, 'legacy', bendB.outputs);

  const bends = renderer.report().timeline.filter((t) => t.message.type === 'pitchBend');
  const channels = new Set(bends.map((t) => t.message.channel));
  assert.equal(channels.size, 2, 'each note bends on its own channel');
  const values = bends.map((t) => t.message.value);
  assert.notEqual(values[0], values[1], 'the two bends keep independent values');

  // The migrated note's old voice was closed and its new voice opened: no dangling voice.
  const rep = renderer.report();
  const n60 = rep.voices.filter((v) => v.note === 60);
  assert.ok(n60.some((v) => v.endedBy === 'noteOff'));
  assert.ok(n60.some((v) => v.endMs == null));
});

test('channel-approximate bends the whole channel and is reported as destructive, with measured cents error', () => {
  const b = createBridge({ sink: { protocol: 'ump-midi2' }, policy: { perNoteControl: 'channel-approximate' } });
  b.handle(on({ note: 60, noteId: 1 }));
  b.handle(on({ note: 64, noteId: 2 }));
  b.setSink({ protocol: 'legacy', availableChannels: [0] });
  const r = b.handle(bend(0x90000000, { note: 60, noteId: 1 }));
  assert.equal(r.decision, 'perNotePitchBend-channel-approximate');
  const loss = r.losses.find((l) => l.field === 'perNotePitchBend');
  assert.equal(loss.quantisable, false);
  assert.equal(loss.disposition, DISPOSITION.APPROXIMATE);
  assert.ok(r.pitchErrors[0].centsError >= 0);
});

test('staged-degrade withholds the bend during overlap and delivers it once isolation is achieved', () => {
  const b = createBridge({ sink: { protocol: 'ump-midi2' }, policy: { perNoteControl: 'staged-degrade' } });
  const renderer = createRenderer();
  b.handle(on({ note: 60, noteId: 1 }));
  b.handle(on({ note: 64, noteId: 2 }));
  const sw = b.setSink({ protocol: 'legacy', availableChannels: [0, 1] });
  renderer.feed(0, 'legacy', sw.outputs);

  const withheld = b.handle(bend(0x90000000, { note: 60, noteId: 1 }));
  assert.equal(withheld.decision, 'perNotePitchBend-deferred');
  assert.equal(b.snapshot().deferred.length, 1);
  renderer.feed(1, 'legacy', withheld.outputs);
  assert.equal(renderer.report().timeline.filter((t) => t.message.type === 'pitchBend').length, 0, 'nothing bends while the notes overlap');

  const release = b.handle(off({ note: 64, noteId: 2 }));
  renderer.feed(2, 'legacy', release.outputs);
  const heard = renderer.report().timeline.filter((t) => t.message.type === 'pitchBend');
  assert.equal(heard.length, 1, 'the deferred bend is applied when the other note releases');
  assert.equal(b.snapshot().deferred.length, 0);
  assert.equal(b.diagnostics().byKind('deferred-expression').length, 1);
});

test('a deferred bend whose note ends first is closed as a documented loss, never silently dropped', () => {
  const b = createBridge({ sink: { protocol: 'ump-midi2' }, policy: { perNoteControl: 'staged-degrade' } });
  b.handle(on({ note: 60, noteId: 1 }));
  b.handle(on({ note: 64, noteId: 2 }));
  b.setSink({ protocol: 'legacy', availableChannels: [0] });
  b.handle(bend(0x90000000, { note: 60, noteId: 1 }));
  const release = b.handle(off({ note: 60, noteId: 1 }));
  assert.ok(release.losses.some((l) => l.field === 'perNotePitchBend' && l.quantisable === false));
  assert.ok(b.diagnostics().byKind('refusal').some((r) => /withheld/.test(r.reason)));
});

// ---- capability renegotiation while playing --------------------------------

test('shrinking available channels mid-performance migrates sounding notes and keeps wire accounting balanced', () => {
  const b = createBridge({ sink: { protocol: 'legacy', availableChannels: [0, 1, 2] } });
  const renderer = createRenderer();
  // Two same-note presses need two channels; a third distinct note shares one.
  const a = b.handle(on({ note: 60, noteId: 1 }));
  const a2 = b.handle(on({ note: 60, noteId: 2 }));
  const c = b.handle(on({ note: 67, noteId: 3 }));
  renderer.feed(0, 'legacy', [...a.outputs, ...a2.outputs, ...c.outputs]);
  const before = b.snapshot().wireVoices.map((v) => v.channel).sort();
  assert.ok(new Set(before).size >= 2);

  const shrunk = b.setSink({ protocol: 'legacy', availableChannels: [0] });
  assert.deepEqual(shrunk.renegotiation.channelsRemoved.sort(), [1, 2]);
  renderer.feed(1, 'legacy', shrunk.outputs);

  // One same-note voice keeps the surviving channel; the other folds into it.
  const kinds = shrunk.decisions.map((x) => x.decision);
  assert.ok(kinds.includes('takeover-split'));
  assert.ok(kinds.filter((k) => k === 'takeover-fold').length >= 1);

  const releases = [off({ note: 60, noteId: 1 }), off({ note: 60, noteId: 2 }), off({ note: 67, noteId: 3 })]
    .map((e) => b.handle(e));
  renderer.feed(2, 'legacy', releases.flatMap((r) => r.outputs));
  assert.equal(renderer.report().balanced, true);
  assert.equal(renderer.report().unmatchedOffs, 0);
});

test('renegotiation recomputes the actual pitch error against the new endpoint width', () => {
  const b = createBridge({ sink: { protocol: 'ump-midi2' }, policy: { perNoteControl: 'migrate-note' } });
  b.handle(on({ note: 60, noteId: 1 }));
  b.handle(bend(0x90000000, { note: 60, noteId: 1 }));
  const sw = b.setSink({ protocol: 'legacy', availableChannels: [0, 1] });
  assert.ok(sw.pitchErrors.length >= 1);
  const err = sw.pitchErrors[0];
  assert.equal(err.bits, 14);
  assert.ok(err.unitError >= 0);
  assert.ok(err.centsError >= 0);
  const expected = recomputeBendError(0x90000000 / 0xffffffff, { bits: 14 });
  assert.ok(Math.abs(err.centsError - expected.centsError) < 1e-9);
});

// ---- strategy comparison ---------------------------------------------------

test('the two strategies expose the timing-vs-stability trade-off from real rendering', () => {
  const r = compareDegradationStrategies({ channels: [0, 1, 2], bendUnit: 0.625 });
  assert.equal(r.migration.bendDeliveredDuringOverlap, true);
  assert.equal(r.staged.bendDeliveredDuringOverlap, false);
  assert.ok(r.migration.retriggerCount >= 1, 'migration costs a Note Off/On pair');
  assert.equal(r.staged.retriggerCount, 0, 'staged policy never retriggers during overlap');
  assert.equal(r.migration.balanced, true);
  assert.equal(r.staged.balanced, true);
  assert.equal(r.migration.diagnosticViolations.length, 0);
  assert.equal(r.staged.diagnosticViolations.length, 0);
  assert.ok(r.contrast.some((row) => /expression heard/.test(row.axis)));
});

test('migration without a free channel refuses instead of bending the neighbour', () => {
  const r = compareDegradationStrategies({ channels: [0], bendUnit: 0.625 });
  assert.match(r.migration.bendDecision, /refused/);
  assert.equal(r.migration.bendDeliveredDuringOverlap, false);
  assert.equal(r.migration.balanced, true);
});

// ---- bidirectional loop guard ----------------------------------------------

test('a bidirectional pair suppresses the returning echo but passes new events', () => {
  const a = createBridge({ sink: { protocol: 'ump-midi2' }, bridgeId: 'A' });
  const bBridge = createBridge({ sink: { protocol: 'ump-midi2' }, bridgeId: 'B' });
  const press = on({ noteId: 7 });
  const outA = a.handle(press);
  assert.ok(outA.outputs[0][ECHO_MARK]);

  // Peer B converts the event and hands it back with the token; A must not re-emit.
  const mark = outA.outputs[0][ECHO_MARK];
  const echoedBack = a.handleFromPeer(press, mark);
  assert.equal(echoedBack.decision, 'loop-echo-suppressed');
  assert.equal(echoedBack.outputs.length, 0);

  // A genuinely new press still flows.
  const fresh = a.handleFromPeer(on({ note: 62, noteId: 8 }));
  assert.equal(fresh.decision, 'noteOn-identity');
  assert.equal(fresh.outputs.length, 1);
});

test('a converted note release settles the exact migrated instance with no dangling voice', () => {
  const a = createBridge({ sink: { protocol: 'ump-midi2' }, policy: { perNoteControl: 'migrate-note' }, bridgeId: 'A' });
  const renderer = createRenderer();
  a.handle(on({ note: 60, noteId: 1 }));
  a.handle(on({ note: 64, noteId: 2 }));
  const sw = a.setSink({ protocol: 'legacy', availableChannels: [0, 1, 2] });
  renderer.feed(0, 'legacy', sw.outputs);
  const migrated = a.handle(bend(0x90000000, { note: 60, noteId: 1 }));
  renderer.feed(1, 'legacy', migrated.outputs);
  const newChannel = a.notes().get(1).route.channel;

  const release = a.handle(off({ note: 60, noteId: 1 }));
  renderer.feed(2, 'legacy', release.outputs);
  const offMsg = parseOutput(release.outputs.find((o) => /NoteOff/.test(o.description)));
  assert.equal(offMsg.channel, newChannel, 'release follows the note onto its migrated channel');
  const n60 = renderer.report().voices.filter((v) => v.note === 60 && v.endMs == null);
  assert.equal(n60.length, 0, 'no dangling voice after release');
});

test('loop guard window is bounded and one echo token is consumed once', () => {
  const guard = createLoopGuard({ bridgeId: 'G', window: 4 });
  for (let i = 0; i < 8; i++) guard.stamp({}, 'noteOn', { i });
  assert.ok(guard.stats().emittedKeys <= 4);
  const token = guard.stamp({}, 'noteOn', { fixed: 1 });
  assert.equal(guard.isEcho('noteOn', { fixed: 1 }, token), true);
  guard.consumeEcho(token.echoKey);
});

// ---- pitch arithmetic ------------------------------------------------------

test('recomputed bend error obeys endpoint width and centre rules', () => {
  const centre = recomputeBendError(0.5, { bits: 14 });
  assert.equal(centre.code, 8192, 'the 14-bit centre code is emitted');
  assert.equal(centre.intendedCents, 0, 'the intended offset is zero');
  // 8192/16383 sits a tiny, measurable amount above the mathematical centre.
  assert.ok(centre.unitError > 0 && centre.unitError < 1 / 16383);
  assert.ok(centre.centsError < 0.1);
  const up = recomputeBendError(0.625, { bits: 14, semitoneRange: 2 });
  assert.ok(up.code > 8192);
  assert.ok(up.intendedCents > 0 && up.deliveredCents > 0);
  assert.ok(up.centsError >= 0);
  const finer = recomputeBendError(0.625, { bits: 32, semitoneRange: 2 });
  assert.ok(finer.unitError <= up.unitError);
});

test('quantiseField endpoints map to 0 and full scale with monotone codes', () => {
  assert.equal(quantiseField(0, 7).code, 0);
  assert.equal(quantiseField(1, 7).code, 127);
  let previous = -1;
  for (let i = 0; i <= 20; i++) {
    const q = quantiseField(i / 20, 7);
    assert.ok(q.code >= previous);
    previous = q.code;
  }
});
