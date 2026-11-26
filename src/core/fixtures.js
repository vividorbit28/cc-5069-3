// UMP wire fixtures: boundary values, several groups playing at once, and
// deliberately mixed streams (supported + unsupported + multi-word).
//
// Every fixture is an array of 32-bit words so the same bytes can be fed to the
// decoder, round-tripped through the encoder, and rendered by the test
// processor.

import { encodeUmp } from './ump.js';

const on = (m, g = 0) => ({ group: g, words: encodeUmp({ type: 'noteOn', ...m }, { group: g }) });
const off = (m, g = 0) => ({ group: g, words: encodeUmp({ type: 'noteOff', ...m }, { group: g }) });
const ctl = (m, g = 0) => ({ group: g, words: encodeUmp(m, { group: g }) });

// Two simultaneous presses of the same key, distinguished only by the 16-bit
// note identity carried in Attribute Data.
export function duplicateNoteFixture() {
  return [
    on({ channel: 0, note: 60, velocity: 0xffff, noteId: 1 }),
    on({ channel: 0, note: 60, velocity: 0x8000, noteId: 2 }),
  ];
}

// Boundary velocities (0 acts as Note Off at the wire level, so use 1 / max),
// boundary controllers on one group, and several groups playing together.
export function boundaryAndGroupsFixture() {
  return [
    on({ channel: 0, note: 36, velocity: 0x0001, noteId: 1 }, 0),
    on({ channel: 0, note: 37, velocity: 0xffff, noteId: 2 }, 0),
    ctl({ type: 'controlChange', channel: 0, controller: 7, value: 0x00000000 }, 0),
    ctl({ type: 'controlChange', channel: 0, controller: 7, value: 0xffffffff }, 0),
    ctl({ type: 'pitchBend', channel: 0, value: 0 }, 0),
    ctl({ type: 'pitchBend', channel: 0, value: 0xffffffff }, 0),
    // Group 1, different channel, its own notes.
    on({ channel: 1, note: 64, velocity: 0x4000, noteId: 10 }, 1),
    ctl({ type: 'controlChange', channel: 1, controller: 1, value: 0x00008000 }, 1),
    // Group 5, per-note pitch bend on an identity-capable sink.
    on({ channel: 2, note: 70, velocity: 0x2000, noteId: 20 }, 5),
    ctl({ type: 'perNotePitchBend', channel: 2, note: 70, value: 0x80000000 }, 5),
  ];
}

// A stream where the supported subset is interleaved with messages the bridge
// must reject diagnosably rather than reinterpret.
export function mixedUnsupportedFixture() {
  return {
    words: [
      // supported identity note
      ...on({ channel: 0, note: 60, velocity: 0xffff, noteId: 1 }).words,
      // MT 0x1 System: rejected, 32-bit
      0x10f80000,
      // MT 0x5 message group? actually 0x5 = MIDI 2.0 System, 128-bit
      0x50f80000, 0x00000000, 0x00000000, 0x00000000,
      // supported controller
      ...encodeUmp({ type: 'controlChange', channel: 0, controller: 10, value: 0x12345678 }),
      // MT 0xE = 128-bit, but env/session, should reject, 4 words
      0xe0f80000, 1, 2, 3,
      // supported note off
      ...off({ channel: 0, note: 60, velocity: 0, noteId: 1 }).words,
      // malformed trailing word claiming 128-bit with only one word present
      0x40f80000,
    ],
    notes: [
      'a 128-bit message must be consumed as one event, not four',
      'unsupported message types must be reported, not guessed',
      'the stream must resynchronise after each rejected message',
    ],
  };
}

// Two groups pressing the same note number at the same time: identity is
// scoped to (group, note id), so group 0 and group 1 are independent.
export function crossGroupSameNoteFixture() {
  return [
    on({ channel: 0, note: 60, velocity: 0x7fff, noteId: 3 }, 0),
    on({ channel: 0, note: 60, velocity: 0x7fff, noteId: 3 }, 1),
  ];
}

// A fine controller sweep whose steps are ~one 14-bit code each: they move the
// split (CC n / n+32) output by a step while every 7-bit-only sink rounds all
// the middle values to the same code. Controller defaults to 1, inside the
// 0..31 range the MSB/LSB pairing is defined for.
export function fineControllerSweepFixture(controller = 1) {
  const base = 0x80000000;
  const step14 = 0x00040000; // ≈ 2^32 / 16383
  const values = [0x00000000, base, base + step14, base + 2 * step14, base + 3 * step14, 0xffffffff];
  return values.map((value) => ({ group: 0, words: encodeUmp({ type: 'controlChange', channel: 0, controller, value }) }));
}

export function allFixtures() {
  return {
    duplicateNote: duplicateNoteFixture(),
    boundaryAndGroups: boundaryAndGroupsFixture(),
    crossGroupSameNote: crossGroupSameNoteFixture(),
    mixedUnsupported: mixedUnsupportedFixture(),
    fineControllerSweep: fineControllerSweepFixture(),
  };
}
