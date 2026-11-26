import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../src/core/bridge.js';
import { eventFromUmp } from '../src/core/internal.js';
import { decodeUmpStream, encodeUmp } from '../src/core/ump.js';
import { createRenderer } from '../src/core/render.js';

const ev = (words, groupFromWire = true) => {
  const { events, errors } = decodeUmpStream(words);
  if (errors.length) throw new Error(JSON.stringify(errors));
  return eventFromUmp(groupFromWire ? events[0].group : 0, events[0].message);
};

const noteOn = (o = {}) => ev(encodeUmp({ type: 'noteOn', channel: 0, note: 60, velocity: 0xffff, noteId: 1, ...o }));
const noteOff = (o = {}) => ev(encodeUmp({ type: 'noteOff', channel: 0, note: 60, velocity: 0, noteId: 1, ...o }));

test('two same-note presses on an identity sink stay independent', () => {
  const b = createBridge({ sink: { protocol: 'ump-midi2' } });
  const r1 = b.handle(noteOn({ noteId: 1 }));
  const r2 = b.handle(noteOn({ noteId: 2 }));
  assert.equal(r1.decision, 'noteOn-identity');
  assert.equal(r2.decision, 'noteOn-identity');
  assert.notEqual(r1.outputs[0].hex, r2.outputs[0].hex);
  assert.equal(b.snapshot().sounding.length, 2);

  const off1 = b.handle(noteOff({ noteId: 1 }));
  assert.equal(off1.decision, 'noteOff-identity');
  assert.equal(b.snapshot().sounding.length, 1);
  assert.equal(b.snapshot().sounding[0].noteId, 2);
});

test('two same-note presses on a wide legacy port split onto two channels', () => {
  const b = createBridge({ sink: { protocol: 'legacy', availableChannels: [0, 1, 2, 3] } });
  const r1 = b.handle(noteOn({ noteId: 1 }));
  const r2 = b.handle(noteOn({ noteId: 2 }));
  assert.equal(r1.decision, 'noteOn');
  assert.equal(r2.decision, 'noteOn-split');
  assert.notEqual(r1.outputs[0].hex, r2.outputs[0].hex, 'different channels');
  assert.equal(b.snapshot().sounding.length, 2);
});

test('with no free channel, fold merges into one wire voice and suppresses a release', () => {
  const b = createBridge({ sink: { protocol: 'legacy', availableChannels: [0] }, policy: { noteConflict: 'fold' } });
  b.handle(noteOn({ noteId: 1 }));
  const r2 = b.handle(noteOn({ noteId: 2 }));
  assert.equal(r2.decision, 'noteOn-fold');
  assert.equal(r2.outputs.length, 0, 'fold emits no extra wire Note On');

  const off1 = b.handle(noteOff({ noteId: 1 }));
  assert.equal(off1.decision, 'noteOff-suppressed');
  assert.equal(off1.residue, true);
  assert.equal(off1.outputs.length, 0, 'wire voice keeps sounding');

  const off2 = b.handle(noteOff({ noteId: 2 }));
  assert.equal(off2.decision, 'noteOff-closes-folded');
  assert.equal(off2.outputs.length, 1, 'closing the wire voice emits exactly one Note Off');
});

test('with no free channel, refuse leaves the existing voice untouched', () => {
  const b = createBridge({ sink: { protocol: 'legacy', availableChannels: [0] }, policy: { noteConflict: 'refuse' } });
  b.handle(noteOn({ noteId: 1 }));
  const r2 = b.handle(noteOn({ noteId: 2 }));
  assert.equal(r2.decision, 'noteOn-refuse');
  assert.equal(r2.outputs.length, 0);
  assert.match(r2.reason, /no-free-channel/);

  const off2 = b.handle(noteOff({ noteId: 2 }));
  assert.equal(off2.decision, 'noteOff-rejected');
  assert.equal(off2.outputs.length, 0);

  const off1 = b.handle(noteOff({ noteId: 1 }));
  assert.equal(off1.decision, 'noteOff');
  assert.equal(off1.outputs.length, 1);
});

test('takeover prioritises earlier presses when channels are scarce', () => {
  const b = createBridge({ sink: { protocol: 'ump-midi2' } });
  b.handle(noteOn({ noteId: 1 }));
  b.handle(noteOn({ noteId: 2 }));
  const sw = b.setSink({ protocol: 'legacy', availableChannels: [0] });
  assert.equal(sw.decisions[0].decision, 'takeover-split');
  assert.equal(sw.decisions[1].decision, 'takeover-fold');
  assert.equal(sw.decisions[0].noteId, 1);
});

test('voice termination is traceable: every wire Note On closes exactly once', () => {
  const b = createBridge({ sink: { protocol: 'legacy', availableChannels: [0, 1] } });
  const on1 = b.handle(noteOn({ noteId: 1 }));
  const on2 = b.handle(noteOn({ noteId: 2 }));
  const r = createRenderer();
  r.feed(0, 'legacy', [...on1.outputs, ...on2.outputs]);
  const off1 = b.handle(noteOff({ noteId: 1 }));
  r.feed(10, 'legacy', off1.outputs);
  const off2 = b.handle(noteOff({ noteId: 2 }));
  r.feed(20, 'legacy', off2.outputs);
  const rep = r.report();
  assert.equal(rep.balanced, true);
  assert.equal(rep.voices.length, 2);
  for (const v of rep.voices) {
    assert.equal(v.endedBy, 'noteOff');
    assert.ok(v.endMs != null);
  }
});

test('wide controller reaches a wide sink without loss', () => {
  const b = createBridge({ sink: { protocol: 'ump-midi2' } });
  const r = b.handle(ev(encodeUmp({ type: 'controlChange', channel: 0, controller: 1, value: 0x89abcdef })));
  assert.equal(r.decision, 'controlChange-wide');
  assert.equal(r.losses.length, 0);
  const back = decodeUmpStream(r.outputs[0].words);
  assert.equal(back.events[0].message.value, 0x89abcdef);
});

test('wide controller on a 7-bit sink can split into a 14-bit pair', () => {
  const b = createBridge({ sink: { protocol: 'legacy', availableChannels: [0] }, policy: { controlResolution: 'split' } });
  const r = b.handle(ev(encodeUmp({ type: 'controlChange', channel: 0, controller: 1, value: 0x80040000 })));
  assert.equal(r.decision, 'controlChange-split-14bit');
  assert.equal(r.outputs.length, 2);
  assert.match(r.outputs[0].hex, /^0xB0 0x01 /);
  assert.match(r.outputs[1].hex, /^0xB0 0x21 /);
  assert.ok(r.losses[0].error < 1 / 8000, 'split keeps most of the fine step');
});

test('a 14-bit split preserves a control change a 7-bit quantise cannot', () => {
  const mk = (policy) => createBridge({ sink: { protocol: 'legacy', availableChannels: [0] }, policy: { controlResolution: policy } });
  const s = mk('split');
  const q = mk('quantise');
  const a = encodeUmp({ type: 'controlChange', channel: 0, controller: 1, value: 0x80000000 });
  const bval = encodeUmp({ type: 'controlChange', channel: 0, controller: 1, value: 0x80100000 });
  s.handle(ev(a)); q.handle(ev(a));
  const sb = s.handle(ev(bval));
  const qb = q.handle(ev(bval));
  assert.equal(qb.outputs.length, 1);
  assert.equal(qb.outputs[0].hex, mk('quantise').handle(ev(a)).outputs[0].hex, '7-bit output unchanged by the fine step');
  assert.notEqual(sb.outputs[1].hex, '0xB0 0x21 0x00', '14-bit LSB moves');
});

test('per-note controls on an identity-less sink are dropped with a preserved reason', () => {
  const b = createBridge({ sink: { protocol: 'legacy', availableChannels: [0] } });
  const r = b.handle(ev(encodeUmp({ type: 'perNotePitchBend', channel: 0, note: 60, value: 0x80000000 })));
  assert.equal(r.decision, 'perNotePitchBend-dropped');
  assert.equal(r.outputs.length, 0);
  assert.ok(r.losses.some((l) => l.quantisable === false && /per-note identity/.test(l.note)));
});

test('per-note pitch bend reaches an identity sink unchanged', () => {
  const b = createBridge({ sink: { protocol: 'ump-midi2' } });
  const r = b.handle(ev(encodeUmp({ type: 'perNotePitchBend', channel: 0, note: 60, value: 0x89abcdef })));
  assert.equal(r.decision, 'perNotePitchBend-wide');
  assert.equal(decodeUmpStream(r.outputs[0].words).events[0].message.value, 0x89abcdef);
});

test('extra events per input event stay bounded under split', () => {
  const b = createBridge({ sink: { protocol: 'legacy', availableChannels: [0] }, policy: { controlResolution: 'split', maxExtraEventsPerInput: 1 } });
  const r = b.handle(ev(encodeUmp({ type: 'controlChange', channel: 0, controller: 1, value: 0x80000000 })));
  assert.ok(r.extraEvents <= b.policy.maxExtraEventsPerInput);
});

test('cross-group same-note presses are independent identities', () => {
  const b = createBridge({ sink: { protocol: 'ump-midi2' } });
  b.handle(ev(encodeUmp({ type: 'noteOn', channel: 0, note: 60, velocity: 0xffff, noteId: 3 }, { group: 0 })));
  b.handle(ev(encodeUmp({ type: 'noteOn', channel: 0, note: 60, velocity: 0xffff, noteId: 3 }, { group: 1 })));
  assert.equal(b.snapshot().sounding.length, 2);
});

test('note off without wire identity releases the oldest matching sounding note (FIFO)', () => {
  const b = createBridge({ sink: { protocol: 'ump-midi2' } });
  b.handle(ev(encodeUmp({ type: 'noteOn', channel: 0, note: 60, velocity: 0xffff, noteId: 1 })));
  b.handle(ev(encodeUmp({ type: 'noteOn', channel: 0, note: 60, velocity: 0xffff, noteId: 2 })));
  const offNoId = ev(encodeUmp({ type: 'noteOff', channel: 0, note: 60, velocity: 0 }));
  const r = b.handle(offNoId);
  assert.equal(r.noteIds[0], 1);
  assert.equal(b.snapshot().sounding.length, 1);
});

test('three same-note voices fold with refcount and close on the last release', () => {
  const b = createBridge({ sink: { protocol: 'ump-midi2' }, policy: { noteConflict: 'fold' } });
  for (let i = 1; i <= 3; i++) b.handle(noteOn({ noteId: i }));
  const sw = b.setSink({ protocol: 'legacy', availableChannels: [0] });
  assert.deepEqual(sw.decisions.map((d) => d.decision), ['takeover-split', 'takeover-fold', 'takeover-fold']);
  const r1 = b.handle(noteOff({ noteId: 1 }));
  const r2 = b.handle(noteOff({ noteId: 2 }));
  assert.equal(r1.decision, 'noteOff-suppressed');
  assert.equal(r2.decision, 'noteOff-suppressed');
  const r3 = b.handle(noteOff({ noteId: 3 }));
  assert.equal(r3.decision, 'noteOff-closes-folded');
  assert.equal(r3.outputs.length, 1);
  assert.equal(b.snapshot().wireVoices.length, 0);
});

test('different notes share a legacy channel; only same-note presses contend', () => {
  const b = createBridge({ sink: { protocol: 'legacy', availableChannels: [0] } });
  b.handle(noteOn({ note: 40, noteId: 1 }));
  b.handle(noteOn({ note: 41, noteId: 2 }));
  b.handle(noteOn({ note: 42, noteId: 3 }));
  const snap = b.snapshot();
  assert.equal(snap.sounding.length, 3);
  assert.ok(snap.sounding.every((s) => s.channel === 0));
  // A same-note press now has no free channel -> fold.
  const dup = b.handle(noteOn({ note: 40, noteId: 4 }));
  assert.equal(dup.decision, 'noteOn-fold');
});
