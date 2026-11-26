// Fixed numeric-mapping policy shared by every layer of the bridge.
//
// External integers are unsigned bit fields. Inbound values map to [0, 1] by
// dividing by 2^bits - 1 ("unit" form) and are held as IEEE-754 doubles.
// Outbound values are denormalised with round-half-up (towards +infinity on a
// tie) into the fixed width of the wire the message targets. Nothing in the
// pipeline truncates a value to a legacy width and widens it again:
// quantisation only ever happens at a final encoder boundary.
//
// 32-bit depths use arithmetic (2 ** bits), never bit shifts: `1 << 32` is 0
// in JavaScript and would silently destroy the full-resolution path.

export const POLICY = Object.freeze({
  unitMapping: 'value / (2^bits - 1)',
  integerInput: 'round to nearest integer, clamp to [0, 2^bits - 1]',
  denormalise: 'round(value * (2^bits - 1)), halves round up, then clamp',
  velocityNoteOnFloor: 'after quantising a Note On, raise velocity 0 to 1 so the note still sounds',
  cc14Split: 'controller n carries the 7-bit MSB, controller n+32 carries the 7-bit LSB',
  pitchBend: '32-bit/14-bit unsigned, centre = 2^31 on 32-bit and 8192 on 14-bit',
});

export const maxForBits = (bits) => 2 ** bits - 1;
export const quantizeStep = (bits) => 1 / maxForBits(bits);

export const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

export function uintToUnit(value, bits) {
  const max = maxForBits(bits);
  const clamped = Math.min(max, Math.max(0, Math.round(value)));
  return clamped / max;
}

// Round-half-up denormalisation. Math.round rounds .5 towards +infinity.
export function unitToUint(value, bits) {
  return Math.round(clamp01(value) * maxForBits(bits));
}

// Quantisation report for one mapped field. `error` is the absolute unit-space
// difference between what the source asked for and what the sink will hear.
export function compareLevel(intendedUnit, bits) {
  const code = unitToUint(intendedUnit, bits);
  const delivered = code / maxForBits(bits);
  const target = clamp01(intendedUnit);
  const error = Math.abs(delivered - target);
  return {
    bits,
    code,
    delivered,
    error,
    exact: error < 1e-15,
    withinHalfStep: error <= quantizeStep(bits) / 2 + 1e-15,
    step: quantizeStep(bits),
  };
}

// Changes smaller than this cannot be expressed on a 7-bit / 16-step control.
export const AUDIBLE_THRESHOLD_UNIT = 0.015;

export function hex(value, bits = 32) {
  return '0x' + (value >>> 0).toString(16).toUpperCase().padStart(bits / 4, '0');
}

// Machine-readable summary of the fixed mapping policy, surfaced in the UI and
// in `cli policy` output so the contract is inspectable at runtime.
export function policySummary() {
  return Object.freeze({ ...POLICY });
}

// Capability description of each port protocol. "Resolution" here is the width
// of the wire field; the internal representation holds the same value as a
// double, so a high-resolution source keeps its full code until the sink's
// encoder quantises it.
export const PROTOCOLS = Object.freeze({
  'ump-midi2': {
    id: 'ump-midi2',
    label: 'UMP / MIDI 2.0 (16- and 32-bit fields)',
    velocityBits: 16,
    controllerBits: 32,
    pitchBendBits: 32,
    pressureBits: 32,
    perNotePitchBend: true,
    perNoteController: false,
    noteIdentity: 'wire only (Attribute Type 0x01, 16-bit voice id)',
    highResolution: true,
    channelCapable: true,
  },
  'ump-midi1': {
    id: 'ump-midi1',
    label: 'UMP / MIDI 1.0 packets (7-bit fields)',
    velocityBits: 7,
    controllerBits: 7,
    pitchBendBits: 14,
    pressureBits: 7,
    perNotePitchBend: false,
    perNoteController: false,
    noteIdentity: 'none on wire',
    highResolution: false,
    channelCapable: true,
  },
  legacy: {
    id: 'legacy',
    label: 'Legacy channel port (7-bit, no per-note identity)',
    velocityBits: 7,
    controllerBits: 7,
    pitchBendBits: 14,
    pressureBits: 7,
    perNotePitchBend: false,
    perNoteController: false,
    noteIdentity: 'none',
    highResolution: false,
    channelCapable: true,
  },
});

export function protocol(id) {
  const p = PROTOCOLS[id];
  if (!p) throw new Error(`unknown protocol: ${id}`);
  return p;
}

