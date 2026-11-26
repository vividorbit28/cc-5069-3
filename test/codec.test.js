import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeUmp, decodeUmpStream, encodeUmp, toHex, messageLengthWords, UMP_MT,
} from '../src/core/ump.js';
import {
  uintToUnit, unitToUint, maxForBits, compareLevel, AUDIBLE_THRESHOLD_UNIT, PROTOCOLS,
} from '../src/core/precision.js';
import { eventFromUmp } from '../src/core/internal.js';

test('message length is derived from the message type, not assumed uniform', () => {
  assert.equal(messageLengthWords([0x40903c01]), 4); // MIDI 2.0 channel = 128-bit
  assert.equal(messageLengthWords([0x20903c40]), 1); // MIDI 1.0 channel = 32-bit
  assert.equal(messageLengthWords([0x00f80000]), 1); // utility = 32-bit
  assert.equal(messageLengthWords([0xd0000000]), 4); // flex = 128-bit
  assert.equal(messageLengthWords([0x30f80000]), 2); // data 64 = 64-bit
});

test('a 128-bit message is one event, not four independent 32-bit events', () => {
  const words = encodeUmp({ type: 'noteOn', channel: 0, note: 60, velocity: 0xabcd }, { group: 0 });
  assert.equal(words.length, 4);
  const { events, errors } = decodeUmpStream(words);
  assert.equal(errors.length, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].message.type, 'noteOn');
  assert.equal(events[0].message.velocity, 0xabcd);
});

test('MIDI 2.0 note on/off attribute type 0x01 round-trips identity', () => {
  const words = encodeUmp({ type: 'noteOn', channel: 3, note: 72, velocity: 0x1234, noteId: 0xbeef }, { group: 5 });
  const { message, group } = decodeUmp(words);
  assert.equal(group, 5);
  assert.equal(message.channel, 3);
  assert.equal(message.note, 72);
  assert.equal(message.velocity, 0x1234);
  assert.equal(message.noteId, 0xbeef);
  assert.equal(message.attributeType, 0x01);
});

test('note on with velocity 0 decodes as note off at the wire level', () => {
  const words = encodeUmp({ type: 'noteOn', channel: 0, note: 60, velocity: 0 }, { group: 0 });
  const { message } = decodeUmp(words);
  assert.equal(message.type, 'noteOff');
});

test('mixed stream resynchronises after unsupported messages', () => {
  const words = [
    ...encodeUmp({ type: 'noteOn', channel: 0, note: 60, velocity: 0xffff, noteId: 1 }),
    0x10f80000, // MT 0x1 unsupported, 1 word
    0x50f80000, 0, 0, 0, // MT 0x5 unsupported, 4 words
    ...encodeUmp({ type: 'controlChange', channel: 0, controller: 10, value: 0x12345678 }),
    0xe0f80000, 1, 2, 3, // MT 0xE unsupported, 4 words
    ...encodeUmp({ type: 'noteOff', channel: 0, note: 60, velocity: 0 }),
  ];
  const { events, errors } = decodeUmpStream(words);
  assert.deepEqual(events.map((e) => e.message.type), ['noteOn', 'controlChange', 'noteOff']);
  assert.equal(errors.length, 3);
  for (const err of errors) {
    assert.equal(err.code, 'unsupported');
    assert.match(err.detail.messageType, /^0x[0-9A-F]$/);
  }
});

test('truncated 128-bit message is reported malformed, not partially decoded', () => {
  const words = [0x40903c01, 0xffff0000]; // claims 4 words, only 2 present
  const { events, errors } = decodeUmpStream(words);
  assert.equal(events.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'malformed');
});

test('unknown attribute type is rejected rather than reinterpreted', () => {
  const words = encodeUmp({ type: 'noteOn', channel: 0, note: 60, velocity: 0xffff });
  words[0] = (words[0] | 0x02) >>> 0; // attribute type 0x02
  assert.throws(() => decodeUmp(words), /not in the supported UMP subset/);
});

test('multi-packet SysEx is rejected', () => {
  // MT 0x3, status nibble 0x2 (continue), count 6
  const words = [0x30260000, 0x00000000];
  assert.throws(() => decodeUmp(words), /multi-packet or short SysEx7/);
});

test('unit mapping is value/(2^bits-1) with exact endpoints', () => {
  assert.equal(uintToUnit(0, 7), 0);
  assert.equal(uintToUnit(127, 7), 1);
  assert.equal(uintToUnit(65535, 16), 1);
  assert.equal(uintToUnit(0xffffffff, 32), 1);
  assert.equal(unitToUint(0.5, 7), Math.round(0.5 * 127));
  assert.equal(unitToUint(1, 32), 0xffffffff);
});

test('32-bit mapping never silently wraps through a bit shift', () => {
  // A 16-bit value widened to "unit" must not be truncated to 32-bit signed.
  assert.equal(maxForBits(32), 4294967295);
  const unit = uintToUnit(0xffffffff, 32);
  assert.equal(unitToUint(unit, 32), 0xffffffff);
});

test('quantisation reports the actual delivered error', () => {
  const intended = 0.5;
  const r7 = compareLevel(intended, 7);
  assert.ok(r7.error > 0);
  assert.ok(r7.withinHalfStep);
  const r16 = compareLevel(intended, 16);
  assert.ok(r16.error <= r7.error);
  const r32 = compareLevel(intended, 32);
  assert.ok(r32.error <= r16.error);
});

test('a change smaller than a 7-bit step is not expressible but is measurable', () => {
  const a = 0.5000;
  const b = 0.5020; // < 1/127 ≈ 0.00787
  const ra = compareLevel(a, 7);
  const rb = compareLevel(b, 7);
  assert.equal(ra.code, rb.code, '7-bit sink cannot distinguish the two');
  const r14 = compareLevel(b, 14);
  const r14a = compareLevel(a, 14);
  assert.notEqual(r14.code, r14a.code, '14-bit sink can distinguish the two');
});

test('internal representation never truncates 32-bit controllers to 16 bits', () => {
  const words = encodeUmp({ type: 'controlChange', channel: 0, controller: 1, value: 0x89abcdef });
  const { message } = decodeUmp(words);
  const ev = eventFromUmp(0, message);
  assert.equal(ev.valueRaw, 0x89abcdef);
  assert.equal(unitToUint(ev.valueUnit, 32), 0x89abcdef);
});

test('protocol capability table drives resolution, not assumptions', () => {
  assert.equal(PROTOCOLS['ump-midi2'].velocityBits, 16);
  assert.equal(PROTOCOLS['ump-midi2'].controllerBits, 32);
  assert.equal(PROTOCOLS.legacy.controllerBits, 7);
  assert.equal(PROTOCOLS.legacy.perNotePitchBend, false);
});

test('encoder output is diagnosable hex, not a bare decimal dump', () => {
  const words = encodeUmp({ type: 'noteOn', channel: 0, note: 60, velocity: 0xffff, noteId: 1 });
  assert.match(toHex(words), /^0x40903C01 0xFFFF0001 0x00000000 0x00000000$/);
});
