// Diagnostic store for the bridge.
//
// Quantisation and state merging leave a durable record here. The point of the
// store is that a loss is auditable after the fact: several distinct input
// values may legitimately map to the same output code, and the store keeps each
// one together with the endpoint rule it met. Each merged record is checked
// against the fixed mapping contract — endpoints must round to the nearest code
// (half step up) and the delivered codes must be monotone in the intended
// units — so a regression that breaks the mapping surfaces as a diagnostic
// failure instead of a silent wrong note.

import { unitToUint, maxForBits, clamp01 } from './precision.js';

const MAX_RECORDS = 4096;

export function createDiagnostics() {
  const records = [];
  const seq = (() => {
    let n = 0;
    return () => ++n;
  })();

  function push(kind, entry) {
    const record = { seq: seq(), at: records.length ? records[records.length - 1].at + 1 : 0, kind, ...entry };
    records.push(record);
    if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
    return record;
  }

  // One quantisation decision: an intended unit, the endpoint width it met,
  // the delivered code, and whether distinct inputs collapsed together.
  function quantisation(entry) {
    const { valueUnit, bits, field, noteId = null, channel = null, carrier = null } = entry;
    const intended = clamp01(valueUnit);
    const code = unitToUint(intended, bits);
    const deliveredUnit = code / maxForBits(bits);
    const error = Math.abs(deliveredUnit - intended);
    const violations = verifyQuantisation(field ?? 'value', intended, code, bits);
    return push('quantisation', {
      field, noteId, channel, carrier, bits,
      intendedUnit: intended, code, maxCode: maxForBits(bits), deliveredUnit, error,
      collapsed: false, // filled in by markCollapsed when a later input shares the code
      violations,
    });
  }

  // Two (or more) intended values mapped to one code: the store records both
  // inputs so the resolution loss is measurable rather than invisible.
  function merge(entry) {
    const { field, bits, intendedUnits, code, noteIds = [], reason } = entry;
    const deliveredUnit = code / maxForBits(bits);
    const spread = intendedUnits.length ? Math.max(...intendedUnits) - Math.min(...intendedUnits) : 0;
    return push('state-merge', {
      field, bits, noteIds, reason,
      intendedUnits: intendedUnits.map(clamp01),
      code, maxCode: maxForBits(bits), deliveredUnit,
      inputSpread: spread,
      distinctInputs: intendedUnits.length,
      violations: verifyMerge(field, intendedUnits, code, bits),
    });
  }

  function migration(entry) {
    return push('migration', entry);
  }

  function deferred(entry) {
    return push('deferred-expression', entry);
  }

  function loop(event) {
    return push('loop-guard', event);
  }

  function refusal(entry) {
    return push('refusal', entry);
  }

  function all() {
    return records.map((r) => ({ ...r }));
  }

  function byKind(kind) {
    return records.filter((r) => r.kind === kind).map((r) => ({ ...r }));
  }

  // Every stored record must satisfy the endpoint and monotonicity rules.
  function violations() {
    const out = [];
    for (const r of records) {
      for (const v of r.violations ?? []) out.push({ seq: r.seq, kind: r.kind, ...v });
    }
    // Monotonicity across successive quantisations of the same field.
    const last = new Map();
    for (const r of records) {
      if (r.kind !== 'quantisation') continue;
      const key = `${r.field}:${r.channel ?? '-'}:${r.noteId ?? '-'}`;
      const prev = last.get(key);
      if (prev) {
        const sameDirection = (r.intendedUnit - prev.intendedUnit) * (r.code - prev.code) >= 0;
        if (!sameDirection) {
          out.push({ seq: r.seq, kind: r.kind, rule: 'monotonicity', field: r.field, message: `code moved ${r.code < prev.code ? 'down' : 'up'} while intended unit moved the other way` });
        }
      }
      last.set(key, r);
    }
    return out;
  }

  function clear() {
    records.splice(0, records.length);
  }

  return { quantisation, merge, migration, deferred, loop, refusal, all, byKind, violations, clear, get size() { return records.length; } };
}

function verifyQuantisation(field, intendedUnit, code, bits) {
  const violations = [];
  if (!Number.isInteger(code) || code < 0 || code > maxForBits(bits)) {
    violations.push({ rule: 'endpoint', field, message: `code ${code} outside [0, ${maxForBits(bits)}] at ${bits} bits` });
  }
  // Nearest-code rule: the delivered code must be within half a step.
  const step = 1 / maxForBits(bits);
  const nearest = unitToUint(intendedUnit, bits);
  if (nearest !== code) {
    violations.push({ rule: 'endpoint', field, message: `delivered code ${code} is not the nearest code ${nearest}` });
  }
  if (Math.abs(code / maxForBits(bits) - intendedUnit) > step / 2 + 1e-15) {
    violations.push({ rule: 'endpoint', field, message: 'quantisation error exceeds half a code step' });
  }
  return violations;
}

function verifyMerge(field, intendedUnits, code, bits) {
  const violations = [];
  for (const u of intendedUnits) {
    if (unitToUint(u, bits) !== code) {
      violations.push({ rule: 'endpoint', field, message: `merged code ${code} is not the nearest code for intended ${u}` });
    }
  }
  const units = [...intendedUnits].sort((a, b) => a - b);
  for (let i = 1; i < units.length; i++) {
    if (units[i] < units[i - 1]) {
      violations.push({ rule: 'monotonicity', field, message: 'merged inputs are not ordered' });
      break;
    }
  }
  return violations;
}
