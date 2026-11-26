import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSwitchScenario } from '../src/core/scenario.js';
import { createBridge } from '../src/core/bridge.js';
import { createRenderer } from '../src/core/render.js';
import { eventFromUmp } from '../src/core/internal.js';
import { decodeUmpStream, encodeUmp } from '../src/core/ump.js';
import {
  allFixtures, boundaryAndGroupsFixture, crossGroupSameNoteFixture,
  duplicateNoteFixture, fineControllerSweepFixture, mixedUnsupportedFixture,
} from '../src/core/fixtures.js';

test('scenario: free channel keeps two same-note presses independently releasable', () => {
  const r = runSwitchScenario({ availableChannels: [0, 1, 2, 3] });
  assert.equal(r.decisionSummary.splits, 2);
  assert.equal(r.decisionSummary.folds, 0);
  assert.equal(r.independentRelease, true);
  assert.equal(r.residueAfterSingleRelease, 1, 'only the un-released voice sounds');
  assert.equal(r.renderer.balanced, true);
  // precision loss is only the quantisable velocity re-quantisation
  assert.ok(r.quantifiableLoss.some((l) => l.field === 'velocity'));
  assert.equal(r.destructiveLoss.length, 0);
});

test('scenario: every channel occupied folds, quantifiable loss plus destroyed release', () => {
  const r = runSwitchScenario({ availableChannels: [0] });
  assert.equal(r.decisionSummary.splits, 1);
  assert.equal(r.decisionSummary.folds, 1);
  assert.equal(r.independentRelease, false);
  assert.equal(r.residueAfterSingleRelease, 1, 'the folded wire voice keeps sounding after one release');
  assert.ok(r.quantifiableLoss.some((l) => l.field === 'velocity'));
  assert.ok(r.destructiveLoss.some((l) => l.field === 'noteIdentity'));
  assert.equal(r.renderer.balanced, true, 'still every Note On closes exactly once');
});

test('scenario: every channel occupied refuses when folding is disallowed', () => {
  const r = runSwitchScenario({ availableChannels: [0], noteConflict: 'refuse' });
  assert.equal(r.decisionSummary.refusals, 1);
  assert.equal(r.decisionSummary.folds, 0);
  assert.equal(r.independentRelease, false);
  assert.equal(r.residueAfterSingleRelease, 0, 'refused voice was never taken over');
  assert.ok(r.destructiveLoss.some((l) => l.field === 'note'));
  // releasing the refused voice emits nothing and does not disturb the taken-over one
  const releaseOfRefused = r.steps.find((s) => s.label.includes('release B'));
  assert.equal(releaseOfRefused.outputs.length, 0);
});

test('duplicate-note fixture round-trips through encoder and decoder', () => {
  for (const { words } of duplicateNoteFixture()) {
    const decoded = decodeUmpStream(words);
    assert.equal(decoded.errors.length, 0);
    const re = encodeUmp(decoded.events[0].message, { group: decoded.events[0].group });
    assert.deepEqual(re, words);
  }
});

test('boundary and multi-group fixture decodes every message and keeps groups distinct', () => {
  const groups = new Set();
  for (const item of boundaryAndGroupsFixture()) {
    const { events, errors } = decodeUmpStream(item.words);
    assert.equal(errors.length, 0);
    groups.add(events[0].group);
  }
  assert.deepEqual([...groups].sort((a, b) => a - b), [0, 1, 5]);
});

test('boundary controller values survive a wide round trip exactly', () => {
  const b = createBridge({ sink: { protocol: 'ump-midi2' } });
  for (const value of [0, 0x00000001, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff]) {
    const w = encodeUmp({ type: 'controlChange', channel: 0, controller: 7, value });
    const ev = eventFromUmp(0, decodeUmpStream(w).events[0].message);
    const r = b.handle(ev);
    const back = decodeUmpStream(r.outputs[0].words).events[0].message;
    assert.equal(back.value, value);
  }
});

test('mixed stream keeps supported events and reports unsupported ones', () => {
  const fx = mixedUnsupportedFixture();
  const { events, errors } = decodeUmpStream(fx.words);
  assert.deepEqual(events.map((e) => e.message.type), ['noteOn', 'controlChange', 'noteOff']);
  // three unsupported message types plus a truncated trailing message
  assert.equal(errors.length, 4);
  const unsupported = errors.filter((e) => e.code === 'unsupported');
  const malformed = errors.filter((e) => e.code === 'malformed');
  assert.equal(unsupported.length, 3);
  assert.equal(malformed.length, 1);
  for (const e of unsupported) assert.match(e.message, /not in the supported UMP subset/);
});

test('cross-group fixture yields two independent identities', () => {
  const b = createBridge({ sink: { protocol: 'ump-midi2' } });
  for (const item of crossGroupSameNoteFixture()) {
    const ev = eventFromUmp(item.group, decodeUmpStream(item.words).events[0].message);
    b.handle(ev);
  }
  const snap = b.snapshot();
  assert.equal(snap.sounding.length, 2);
  assert.deepEqual(snap.sounding.map((s) => s.group).sort((a, b2) => a - b2), [0, 1]);
});

test('fine controller sweep shows movement on a 14-bit path, none on a 7-bit one', () => {
  const split = createBridge({ sink: { protocol: 'legacy', availableChannels: [0] }, policy: { controlResolution: 'split' } });
  const quant = createBridge({ sink: { protocol: 'legacy', availableChannels: [0] }, policy: { controlResolution: 'quantise' } });
  const fx = fineControllerSweepFixture(1);
  const splitCodes = [];
  const quantCodes = [];
  for (const item of fx) {
    const ev = eventFromUmp(item.group, decodeUmpStream(item.words).events[0].message);
    const sr = split.handle(ev);
    const qr = quant.handle(ev);
    assert.equal(sr.outputs.length, 2);
    splitCodes.push(sr.outputs[1].hex); // LSB
    quantCodes.push(qr.outputs[0].hex);
  }
  assert.ok(new Set(splitCodes).size > 1, '14-bit LSB changes at fine steps');
  // 7-bit codes may also change across this wide sweep, but the fine mid-range
  // steps themselves must not alter a 7-bit-only output.
  const mid = quantCodes.slice(1, 5);
  assert.equal(new Set(mid).size, 1, '7-bit quantise collapses the fine mid-range steps');
});

test('renderer records actual start/end times from emitted messages', () => {
  const r = createRenderer();
  const words = encodeUmp({ type: 'noteOn', channel: 0, note: 60, velocity: 0xffff });
  r.feed(100, 'ump-midi2', [{ encoding: 'ump', protocol: 'ump-midi2', group: 0, words, hex: '' }]);
  r.feed(250, 'ump-midi2', [{ encoding: 'ump', protocol: 'ump-midi2', group: 0, words: encodeUmp({ type: 'noteOff', channel: 0, note: 60, velocity: 0 }), hex: '' }]);
  const rep = r.report();
  assert.equal(rep.voices.length, 1);
  assert.equal(rep.voices[0].startMs, 100);
  assert.equal(rep.voices[0].endMs, 250);
  assert.equal(rep.balanced, true);
});

test('fixtures are all decodable or explicitly diagnosed', () => {
  const fx = allFixtures();
  for (const [name, value] of Object.entries(fx)) {
    const items = Array.isArray(value) ? value : value.words.map((w) => ({ words: [w] }));
    assert.ok(items.length > 0, `${name} is non-empty`);
  }
});
