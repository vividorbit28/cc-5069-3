// Endpoint degradation rules.
//
// A high-precision source (UMP / MIDI 2.0) carries per-note expression that a
// lower-capability endpoint simply cannot address. The bridge is not allowed to
// throw that music semantics away silently: every per-note control is classified
// into one of four dispositions, each with a machine-readable reason:
//
//   channel       a real channel-level carrier exists on the endpoint, so the
//                 control is delivered (possibly after quantisation);
//   approximate   no identity carrier exists, but a channel-wide message can
//                 stand in — it necessarily moves every other voice on that
//                 channel too, so it is always reported as destructive;
//   extra-channel the meaning is only recoverable by moving the addressed note
//                 onto its own channel and using a channel carrier there;
//   refuse        nothing on the endpoint can carry the meaning without
//                 changing other notes; the event is rejected with a reason,
//                 never encoded into a private field the endpoint cannot parse.
//
// Quantisation (same field, coarser code) is always `channel`-class and
// quantisable. Identity loss (per-note addressing on an identity-less port) is
// never quantisable.

import { PROTOCOLS, compareLevel, maxForBits, unitToUint, clamp01 } from './precision.js';
export const DISPOSITION = Object.freeze({
  CHANNEL: 'channel',
  APPROXIMATE: 'approximate',
  EXTRA_CHANNEL: 'extra-channel',
  REFUSE: 'refuse',
});

// Static capability matrix: for every routable control, what each endpoint can
// actually do with it. `carrier` names the real wire message the endpoint
// understands; there are no private / vendor fields.
const CONTROL_RULES = Object.freeze({
  controlChange: {
    label: 'channel controller (CC)',
    perNote: false,
    rules: {
      'ump-midi2': { disposition: DISPOSITION.CHANNEL, carrier: 'midi2-cc', bits: 32 },
      'ump-midi1': { disposition: DISPOSITION.CHANNEL, carrier: 'midi1-cc-7bit', bits: 7, altCarrier: 'midi1-cc-14bit-pair', altBits: 14 },
      legacy: { disposition: DISPOSITION.CHANNEL, carrier: 'midi1-cc-7bit', bits: 7, altCarrier: 'midi1-cc-14bit-pair', altBits: 14 },    },
  },
  pitchBend: {
    label: 'channel pitch bend',
    perNote: false,
    rules: {
      'ump-midi2': { disposition: DISPOSITION.CHANNEL, carrier: 'midi2-pitchbend', bits: 32 },
      'ump-midi1': { disposition: DISPOSITION.CHANNEL, carrier: 'midi1-pitchbend-14bit', bits: 14 },
      legacy: { disposition: DISPOSITION.CHANNEL, carrier: 'midi1-pitchbend-14bit', bits: 14 },
    },
  },
  channelPressure: {
    label: 'channel pressure',
    perNote: false,
    rules: {
      'ump-midi2': { disposition: DISPOSITION.CHANNEL, carrier: 'midi2-channel-pressure', bits: 32 },
      'ump-midi1': { disposition: DISPOSITION.CHANNEL, carrier: 'midi1-channel-pressure-7bit', bits: 7 },
      legacy: { disposition: DISPOSITION.CHANNEL, carrier: 'midi1-channel-pressure-7bit', bits: 7 },
    },
  },
  polyPressure: {
    // Polyphonic key pressure is addressed by (channel, note). A MIDI 1 port
    // has exactly that message, so per-note pressure maps cleanly — at 7 bits.
    label: 'per-note (polyphonic) pressure',
    perNote: true,
    rules: {
      'ump-midi2': { disposition: DISPOSITION.CHANNEL, carrier: 'midi2-poly-pressure', bits: 32 },
      'ump-midi1': { disposition: DISPOSITION.CHANNEL, carrier: 'midi1-poly-pressure-7bit', bits: 7 },
      legacy: { disposition: DISPOSITION.CHANNEL, carrier: 'midi1-poly-pressure-7bit', bits: 7 },
    },
  },
  perNotePitchBend: {
    // A per-note bend needs note identity. On an identity-less port no single
    // channel message can bend just one note: the exact disposition depends on
    // whether the note can be isolated onto its own channel.
    label: 'per-note pitch bend',
    perNote: true,
    rules: {
      'ump-midi2': { disposition: DISPOSITION.CHANNEL, carrier: 'midi2-per-note-pitchbend', bits: 32 },
      'ump-midi1': { disposition: EXTRA_CHANNEL_RULE, carrier: 'midi1-pitchbend-14bit', bits: 14 },
      legacy: { disposition: EXTRA_CHANNEL_RULE, carrier: 'midi1-pitchbend-14bit', bits: 14 },
    },
  },
});

function EXTRA_CHANNEL_RULE() { return DISPOSITION.EXTRA_CHANNEL; }

export function controlRule(type, protocolId) {
  const entry = CONTROL_RULES[type];
  if (!entry) return null;
  const rule = entry.rules[protocolId];
  if (!rule) return null;
  return {
    type,
    label: entry.label,
    perNote: entry.perNote,
    carrier: rule.carrier,
    bits: rule.bits,
    altCarrier: rule.altCarrier ?? null,
    altBits: rule.altBits ?? null,
    staticDisposition: typeof rule.disposition === 'function' ? null : rule.disposition,
  };
}

// The static (policy-independent) disposition of a control on an endpoint.
// Per-note bend on an identity-less port has no static answer and returns null:
// resolvePerNoteDisposition() decides from live channel availability.
export function staticDisposition(type, protocolId) {
  const entry = CONTROL_RULES[type];
  if (!entry) return null;
  const rule = entry.rules[protocolId];
  if (!rule) return null;
  return typeof rule.disposition === 'function' ? null : rule.disposition;
}

// Resolves what must happen to one per-note control given the live state.
//
//   policy: 'drop' | 'channel-approximate' | 'migrate-note' | 'staged-degrade'
//   isolated: the addressed note already has a channel on the endpoint that no
//             other sounding note shares (a channel carrier would bend only it)
//   freeChannelAvailable: a migration target channel exists
//
// Returns { disposition, strategy, requiresMigration, reason }.
export function resolvePerNoteDisposition(type, protocolId, {
  policy,
  isolated = false,
  freeChannelAvailable = false,
} = {}) {
  const wide = protocolId === 'ump-midi2';
  if (wide) {
    return { disposition: DISPOSITION.CHANNEL, strategy: policy, requiresMigration: false, reason: 'identity-capable endpoint addresses the note directly' };
  }
  const rule = controlRule(type, protocolId);
  if (!rule || !rule.perNote) {
    return { disposition: DISPOSITION.REFUSE, strategy: policy, requiresMigration: false, reason: `no endpoint rule for ${type}` };
  }

  // Poly pressure has a native (channel, note) carrier on every endpoint.
  if (type === 'polyPressure') {
    return { disposition: DISPOSITION.CHANNEL, strategy: policy, requiresMigration: false, reason: 'MIDI 1 polyphonic key pressure addresses (channel, note) natively' };
  }

  // Per-note pitch bend on an identity-less endpoint.
  if (isolated) {
    return { disposition: DISPOSITION.CHANNEL, strategy: policy, requiresMigration: false, reason: 'note already isolated on its own channel; a channel bend reaches only this note' };
  }
  switch (policy) {
    case 'migrate-note':
      if (freeChannelAvailable) {
        return { disposition: DISPOSITION.EXTRA_CHANNEL, strategy: policy, requiresMigration: true, reason: 'note moved to a dedicated channel so a channel bend preserves its independent pitch' };
      }
      return { disposition: DISPOSITION.REFUSE, strategy: policy, requiresMigration: false, reason: 'migration requested but no channel is free; per-note bend cannot be delivered without bending other notes' };
    case 'staged-degrade':
      // The note stays where it is until its natural release; the bend is held
      // back and re-evaluated then. While overlapping voices exist the exact
      // expression is not delivered, which is recorded rather than hidden.
      return { disposition: DISPOSITION.APPROXIMATE, strategy: policy, requiresMigration: false, deferred: true, reason: 'staged policy: bend withheld until the note can be isolated at release; expression is deferred, not folded into another voice' };
    case 'channel-approximate':
      return { disposition: DISPOSITION.APPROXIMATE, strategy: policy, requiresMigration: false, reason: 'per-note bend approximated as a channel bend; every other voice on the channel is bent too' };
    case 'drop':
    default:
      return { disposition: DISPOSITION.REFUSE, strategy: policy, requiresMigration: false, reason: 'endpoint has no note identity; the per-note bend is refused with its reason preserved' };
  }
}

// ---- pitch arithmetic -----------------------------------------------------

// Recomputes the actual pitch a 32-bit per-note bend becomes on the endpoint.
// MIDI bend is an unsigned unit around a centre; `semitoneRange` is the
// endpoint's configured bend range in semitones. Returns intended vs delivered
// unit, the 14-bit code the endpoint actually receives, and the realised error
// in both unit and cents terms.
export function recomputeBendError(valueUnit, { semitoneRange = 2, bits = 14 } = {}) {
  const cmp = compareLevel(clamp01(valueUnit), bits);
  const centreUnit = 0.5;
  const intendedOffset = clamp01(valueUnit) - centreUnit;
  const deliveredOffset = cmp.delivered - centreUnit;
  // A full offset of +/- 0.5 unit spans the configured +/- semitone range.
  const centsPerHalfUnit = semitoneRange * 100;
  return {
    bits,
    intendedUnit: clamp01(valueUnit),
    deliveredUnit: cmp.delivered,
    code: cmp.code,
    maxCode: maxForBits(bits),
    unitError: Math.abs(deliveredOffset - intendedOffset),
    centsError: Math.abs(deliveredOffset - intendedOffset) * 2 * centsPerHalfUnit,
    intendedCents: intendedOffset * 2 * centsPerHalfUnit,
    deliveredCents: deliveredOffset * 2 * centsPerHalfUnit,
    quantisable: true,
  };
}

// Quantisation report for any single field. `context` is carried into the
// diagnostic store so a merged record keeps its provenance.
export function quantiseField(valueUnit, bits) {
  const cmp = compareLevel(clamp01(valueUnit), bits);
  return {
    bits,
    intendedUnit: clamp01(valueUnit),
    deliveredUnit: cmp.delivered,
    code: cmp.code,
    maxCode: maxForBits(bits),
    error: cmp.error,
    exact: cmp.exact,
    withinHalfStep: cmp.withinHalfStep,
  };
}

// Human-readable catalogue of every rule, surfaced by the panel and `cli`.
export function degradationCatalogue() {
  const out = [];
  for (const [type, entry] of Object.entries(CONTROL_RULES)) {
    for (const protocolId of Object.keys(PROTOCOLS)) {
      const rule = entry.rules[protocolId];
      if (!rule) continue;
      out.push({
        type,
        label: entry.label,
        perNote: entry.perNote,
        endpoint: protocolId,
        carrier: rule.carrier,
        bits: rule.bits,
        altCarrier: rule.altCarrier ?? null,
        altBits: rule.altBits ?? null,
        staticDisposition: typeof rule.disposition === 'function' ? null : rule.disposition,
      });
    }
  }
  return out;
}
