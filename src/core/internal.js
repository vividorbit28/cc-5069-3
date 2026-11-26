// Internal high-precision event representation.
//
// Every message decoded from a UMP stream becomes an internal event carrying
// its source precision and — for note messages — a note identity allocated by
// the bridge. Values are kept as unit doubles plus the raw wire integer so no
// resolution is lost when the source is 16- or 32-bit and the sink is wide.
//
// A note identity is never derived from (channel, note): two simultaneous
// presses of the same key on one port are two identities. That is what makes
// independent release possible when a channel-only sink is later asked to
// carry both.

import { PROTOCOLS, uintToUnit, maxForBits } from './precision.js';

let nextNoteId = 1;
export function resetNoteIds() { nextNoteId = 1; }
export function allocateNoteId() { return nextNoteId++; }

// Builds an internal event from a decoded UMP message plus its group.
// `sourceNoteId` is the identity the wire supplied (Attribute Type 0x01),
// or null when the sender supplied none. It is kept separate from the
// bridge-allocated `noteId` so tests can tell provenance from allocation.
export function eventFromUmp(group, message, { protocolId = 'ump-midi2' } = {}) {
  const protocol = PROTOCOLS[protocolId];
  const base = {
    group,
    channel: message.channel ?? null,
    note: message.note ?? null,
    noteId: null,
    sourceNoteId: message.noteId ?? null,
    sourceProtocol: protocolId,
    sourcePrecision: {
      velocityBits: protocol.velocityBits,
      controllerBits: protocol.controllerBits,
      pitchBendBits: protocol.pitchBendBits,
      pressureBits: protocol.pressureBits,
    },
    raw: message,
  };

  switch (message.type) {
    case 'noteOn':
      return {
        ...base,
        type: 'noteOn',
        velocity: uintToUnit(message.velocity, protocol.velocityBits),
        velocityRaw: message.velocity,
      };
    case 'noteOff':
      return {
        ...base,
        type: 'noteOff',
        velocity: uintToUnit(message.velocity, protocol.velocityBits),
        velocityRaw: message.velocity,
      };
    case 'controlChange':
      return {
        ...base,
        type: 'controlChange',
        controller: message.controller,
        valueUnit: uintToUnit(message.value, protocol.controllerBits),
        valueRaw: message.value,
      };
    case 'pitchBend':
      return {
        ...base,
        type: 'pitchBend',
        valueRaw: message.value,
        // Signed offset from centre and a unit position, both kept exactly.
        value: message.value - (((1 << protocol.pitchBendBits) - 1) / 2),
        valueUnit: message.value / ((1 << protocol.pitchBendBits) - 1),
      };
    case 'channelPressure':
      return {
        ...base,
        type: 'channelPressure',
        valueRaw: message.value,
        valueUnit: uintToUnit(message.value, protocol.pressureBits),
      };
    case 'polyPressure':
      return {
        ...base,
        type: 'polyPressure',
        valueRaw: message.value,
        valueUnit: message.value / 0xffffffff,
      };
    case 'perNotePitchBend':
      return {
        ...base,
        type: 'perNotePitchBend',
        valueRaw: message.value,
        valueUnit: message.value / 0xffffffff,
        value: message.value - 0x7fffffff,
      };
    case 'noteManagement':
      return { ...base, type: 'noteManagement', detach: message.detach, reset: message.reset };
    case 'sysex':
      return { ...base, type: 'sysex', data: message.data };
    case 'tempo':
      return { ...base, type: 'tempo', tenthsOfBpm: message.tenthsOfBpm };
    case 'timeSignature':
      return { ...base, type: 'timeSignature', numerator: message.numerator, denominator: message.denominator };
    case 'jrClock':
      return { ...base, type: 'jrClock', valueRaw: message.value };
    case 'jrTimestamp':
      return { ...base, type: 'jrTimestamp', valueRaw: message.value };
    default:
      throw new Error(`eventFromUmp: unsupported message type ${message.type}`);
  }
}

const fmt = (unit, bits) => {
  const max = maxForBits(bits);
  const code = Math.round(Math.min(1, Math.max(0, unit)) * max);
  return `${unit.toFixed(6)} (${code}/${max})`;
};

// Human-readable one-line summary used by CLI output and the UI log.
export function describeEvent(event) {
  if (!event) return 'none';
  const parts = [event.type];
  if (event.group != null) parts.push(`G${event.group}`);
  if (event.channel != null) parts.push(`ch${event.channel}`);
  if (event.note != null) parts.push(`n${event.note}`);
  if (event.noteId != null) parts.push(`#${event.noteId}`);
  if (event.velocity != null) parts.push(`vel=${fmt(event.velocity, event.sourcePrecision.velocityBits)}`);
  if (event.type === 'controlChange') parts.push(`=${fmt(event.valueUnit, event.sourcePrecision.controllerBits)}`);
  if (event.type === 'perNotePitchBend') parts.push(`bend=${fmt(event.valueUnit, 32)}`);
  if (event.type === 'noteManagement') parts.push(`detach=${event.detach} reset=${event.reset}`);
  return parts.join(' ');
}
