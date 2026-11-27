// Minimal UMP codec. It does not implement every message type in the
// specification; it implements exactly the deliberately chosen subset below,
// and reports everything else as an unsupported, diagnosable rejection rather
// than guessing a meaning.
//
// Packet length is derived from the message type nibble. 32-bit words are
// never scanned independently: a 128-bit message is four words that form one
// event, and reading word 1 or word 2 as a standalone event would misclassify
// data bytes as message types.
//
// Supported subset
//   MT 0x0 Utility        32-bit: JR Clock (0x1) / JR Timestamp (0x2)
//   MT 0x2 MIDI 1.0 Ch   32-bit: Note On 0x90, Note Off 0x80, CC 0xB0,
//                                 Pitch Bend 0xE0, Channel Pressure 0xD0
//   MT 0x3 SysEx7         64-bit: single-packet (complete) SysEx only
//   MT 0x4 MIDI 2.0 Ch  128-bit: Note On 0x9, Note Off 0x8, Poly Pressure 0xA,
//                                 CC 0xB, Channel Pressure 0xD,
//                                 Pitch Bend 0xE, Per-Note Pitch Bend 0x6,
//                                 Per-Note Management 0xF
//   MT 0xD Flex Data    128-bit: Tempo (0x00:0x00) and Time Signature (0x00:0x06)
//
// Rejected (diagnosable, never reinterpreted): 0x1, 0x5, 0x6, 0x7, 0x8, 0x9,
// 0xA, 0xB, 0xC, 0xE, 0xF, unknown status bytes, multi-packet SysEx,
// attribute types other than none, and per-note registered/assignable CC.

export const UMP_MT = Object.freeze({
  UTILITY: 0x0,
  MIDI1_CHANNEL: 0x2,
  DATA_64: 0x3,
  MIDI2_CHANNEL: 0x4,
  FLEX: 0xd,
});

// Duration in 32-bit words for every message type nibble defined by UMP v1.1.
const UMP_LENGTH_BY_MT = Object.freeze({
  0x0: 1, 0x1: 1, 0x2: 1, 0x3: 2, 0x4: 4, 0x5: 4,
  0x6: 1, 0x7: 1, 0x8: 2, 0x9: 2, 0xa: 2, 0xb: 3, 0xc: 3,
  0xd: 4, 0xe: 4, 0xf: 4,
});

export function messageLengthWords(words, start = 0) {
  const mt = (words[start] >>> 28) & 0xf;
  const len = UMP_LENGTH_BY_MT[mt];
  if (!len) throw new Error(`unknown UMP message type 0x${mt.toString(16)}`);
  return len;
}

const u32 = (hi, lo) => hi * 0x100000000 + lo;

export class UnsupportedUmpError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'UnsupportedUmpError';
    this.code = 'unsupported';
    this.detail = detail;
  }
}

function reject(what, words, index) {
  const mt = (words[index] >>> 28) & 0xf;
  return new UnsupportedUmpError(
    `${what} is not in the supported UMP subset`,
    { messageType: `0x${mt.toString(16).toUpperCase()}`, wordIndex: index },
  );
}

// Decodes exactly one message starting at `index`; returns { message, nextIndex }.
export function decodeUmp(words, index = 0) {
  if (!Array.isArray(words)) throw new Error('decodeUmp expects an array of 32-bit words');
  if (index >= words.length) throw new Error('decodeUmp: index past end of stream');
  for (let i = index; i < words.length; i++) {
    if (!Number.isInteger(words[i]) || words[i] < 0 || words[i] > 0xffffffff) {
      throw new Error(`decodeUmp: word ${i} is not a valid unsigned 32-bit integer`);
    }
  }
  const length = messageLengthWords(words, index);
  if (index + length > words.length) {
    throw new Error(`decodeUmp: need ${length} word(s) at index ${index}, stream ends early`);
  }
  const mt = (words[index] >>> 28) & 0xf;
  const group = (words[index] >>> 24) & 0xf;
  let message;

  switch (mt) {
    case UMP_MT.UTILITY: {
      const status = (words[index] >>> 16) & 0xf;
      if (status === 0x1) message = { type: 'jrClock', value: words[index] & 0xffff };
      else if (status === 0x2) message = { type: 'jrTimestamp', value: words[index] & 0xffff };
      else throw reject(`Utility status 0x${status.toString(16)}`, words, index);
      break;
    }
    case UMP_MT.MIDI1_CHANNEL: {
      const statusByte = (words[index] >>> 16) & 0xff;
      const channel = statusByte & 0x0f;
      const kind = statusByte & 0xf0;
      const d1 = (words[index] >>> 8) & 0x7f;
      const d2 = words[index] & 0x7f;
      if (kind === 0x90) message = d2 > 0
        ? { type: 'noteOn', channel, note: d1, velocity: d2 }
        : { type: 'noteOff', channel, note: d1, velocity: 0 };
      else if (kind === 0x80) message = { type: 'noteOff', channel, note: d1, velocity: d2 };
      else if (kind === 0xb0) message = { type: 'controlChange', channel, controller: d1, value: d2 };
      else if (kind === 0xa0) message = { type: 'polyPressure', channel, note: d1, value: d2 };
      else if (kind === 0xe0) message = { type: 'pitchBend', channel, value: (d2 << 7) | d1 };
      else if (kind === 0xd0) message = { type: 'channelPressure', channel, value: d1 };
      else throw reject(`MIDI 1.0 status 0x${kind.toString(16)}`, words, index);
      break;
    }
    case UMP_MT.DATA_64: {
      const statusNibble = (words[index] >>> 20) & 0xf;
      const count = (words[index] >>> 16) & 0xf;
      if (statusNibble !== 0x0 || count !== 0x6) throw reject('multi-packet or short SysEx7', words, index);
      const bytes = [];
      for (let bi = 0; bi < 6; bi++) {
        const word = words[index + 1 + (bi >> 2)];
        bytes.push((word >>> (8 * (bi & 3))) & 0xff);
      }
      message = { type: 'sysex', data: bytes };
      break;
    }
    case UMP_MT.MIDI2_CHANNEL: {
      const parsed = decodeMidi2Channel(words, index);
      if (parsed.reject) throw reject(parsed.reject, words, index);
      message = parsed.message;
      break;
    }
    case UMP_MT.FLEX: {
      const statusBank = (words[index] >>> 8) & 0xff;
      const status = words[index] & 0xff;
      if (statusBank === 0x00 && status === 0x00) {
        message = { type: 'tempo', tenthsOfBpm: u32(words[index + 2], words[index + 3]) };
      } else if (statusBank === 0x00 && status === 0x06) {
        message = { type: 'timeSignature', numerator: words[index + 2], denominator: words[index + 3] };
      } else {
        throw reject(`Flex Data status 0x${statusBank.toString(16)}:0x${status.toString(16)}`, words, index);
      }
      break;
    }
    default:
      throw reject(`Message type 0x${mt.toString(16).toUpperCase()}`, words, index);
  }

  return { group, message, nextIndex: index + length };
}

// MIDI 2.0 channel-voice word 0 layout:
//   [31:28] MT=4  [27:24] Group  [23:16] Status byte  [15:8] Note/Index
//   [7:0] Attribute Type
// Word 1 carries the 32-bit value for CC / pressure / bend, or for note
// messages: [31:16] velocity, [15:0] attribute data.
//
// This subset defines Attribute Type 0x01 = "note identity": Attribute Data
// carries a 16-bit voice id, and both Note On and Note Off repeat it. That is
// the only wire mechanism in the subset that distinguishes two simultaneous
// presses of the same key on the same channel. Attribute Type 0x00 means the
// sender supplied no identity and the receiver matches FIFO per (ch, note).
function decodeMidi2Channel(words, index) {
  const statusByte = (words[index] >>> 16) & 0xff;
  const kind = statusByte & 0xf0;
  const channel = statusByte & 0x0f;
  const note = (words[index] >>> 8) & 0x7f;
  const attributeType = words[index] & 0xff;
  const word1 = words[index + 1];

  if (kind === 0x90 || kind === 0x80) {
    if (attributeType !== 0x00 && attributeType !== 0x01) {
      return { reject: `attribute type 0x${attributeType.toString(16)}` };
    }
    const velocity = (word1 >>> 16) & 0xffff;
    const attributeData = word1 & 0xffff;
    const noteIdentity = attributeType === 0x01
      ? { attributeType: 0x01, noteId: attributeData === 0xffff ? null : attributeData }
      : { attributeType: 0x00, noteId: null };
    if (kind === 0x90 && velocity > 0) {
      return { message: { type: 'noteOn', channel, note, velocity, ...noteIdentity } };
    }
    return { message: { type: 'noteOff', channel, note, velocity, ...noteIdentity } };
  }

  switch (kind) {
    case 0xb0:
      return { message: { type: 'controlChange', channel, controller: note, value: word1 } };
    case 0xa0:
      return { message: { type: 'polyPressure', channel, note, value: word1 } };
    case 0xd0:
      return { message: { type: 'channelPressure', channel, value: word1 } };
    case 0xe0:
      return { message: { type: 'pitchBend', channel, value: word1 } };
    case 0x60:
      return { message: { type: 'perNotePitchBend', channel, note, value: word1 } };
    case 0xf0: {
      // Byte 3 (attribute-type position) holds flags: bit0 detach, bit1 reset.
      const detach = (words[index] & 0x1) === 1;
      const reset = ((words[index] >>> 1) & 0x1) === 1;
      return { message: { type: 'noteManagement', channel, note, detach, reset } };
    }
    default:
      return { reject: `MIDI 2.0 channel status 0x${kind.toString(16)}` };
  }
}

// Decodes a whole stream, returning events plus per-message decoding failures.
export function decodeUmpStream(words) {
  const events = [];
  const errors = [];
  let index = 0;
  while (index < words.length) {
    try {
      const { group, message, nextIndex } = decodeUmp(words, index);
      events.push({ group, message, words: words.slice(index, nextIndex), index });
      index = nextIndex;
    } catch (err) {
      errors.push({ index, code: err.code ?? 'malformed', message: err.message, detail: err.detail ?? null });
      let length;
      try {
        length = messageLengthWords(words, index);
      } catch {
        break;
      }
      index += Math.max(1, length);
    }
  }
  return { events, errors };
}

// ---- Encoders -------------------------------------------------------------

const m2status = (kind, channel) => ((kind | (channel & 0xf)) << 16) >>> 0;
const word16 = (v) => v & 0xffff;

// Note identity rides on Attribute Type 0x01 / Attribute Data (16 bits).
const noteAttrType = (packet) => (Number.isInteger(packet.noteId) ? 0x01 : 0x00);
const noteAttrData = (packet) => (Number.isInteger(packet.noteId) ? packet.noteId & 0xffff : 0);

export function encodeUmp(packet, { group = 0 } = {}) {
  const g = ((group & 0xf) * 0x01000000) >>> 0;
  const base = 0x40000000 | g;
  switch (packet.type) {
    case 'noteOn':
      return [
        (base | m2status(0x90, packet.channel) | ((packet.note & 0x7f) << 8) | noteAttrType(packet)) >>> 0,
        ((word16(packet.velocity) << 16) | noteAttrData(packet)) >>> 0,
        0, 0,
      ];
    case 'noteOff':
      return [
        (base | m2status(0x80, packet.channel) | ((packet.note & 0x7f) << 8) | noteAttrType(packet)) >>> 0,
        ((word16(packet.velocity) << 16) | noteAttrData(packet)) >>> 0,
        0, 0,
      ];
    case 'controlChange':
      return [
        (base | m2status(0xb0, packet.channel) | ((packet.controller & 0x7f) << 8)) >>> 0,
        packet.value >>> 0, 0, 0,
      ];
    case 'polyPressure':
      return [
        (base | m2status(0xa0, packet.channel) | ((packet.note & 0x7f) << 8)) >>> 0,
        packet.value >>> 0, 0, 0,
      ];
    case 'channelPressure':
      return [(base | m2status(0xd0, packet.channel)) >>> 0, packet.value >>> 0, 0, 0];
    case 'pitchBend':
      return [(base | m2status(0xe0, packet.channel)) >>> 0, packet.value >>> 0, 0, 0];
    case 'perNotePitchBend':
      return [
        (base | m2status(0x60, packet.channel) | ((packet.note & 0x7f) << 8)) >>> 0,
        packet.value >>> 0, 0, 0,
      ];
    case 'midi1NoteOn':
      return [((0x2 << 28) | g | (((0x90 | (packet.channel & 0xf)) & 0xff) << 16)
        | ((packet.note & 0x7f) << 8) | (packet.velocity & 0x7f)) >>> 0];
    case 'midi1NoteOff':
      return [((0x2 << 28) | g | (((0x80 | (packet.channel & 0xf)) & 0xff) << 16)
        | ((packet.note & 0x7f) << 8) | (packet.velocity & 0x7f)) >>> 0];
    case 'midi1ControlChange':
      return [((0x2 << 28) | g | (((0xb0 | (packet.channel & 0xf)) & 0xff) << 16)
        | ((packet.controller & 0x7f) << 8) | (packet.value & 0x7f)) >>> 0];
    case 'midi1PolyPressure':
      return [((0x2 << 28) | g | (((0xa0 | (packet.channel & 0xf)) & 0xff) << 16)
        | ((packet.note & 0x7f) << 8) | (packet.value & 0x7f)) >>> 0];
    case 'midi1PitchBend': {
      const v = packet.value & 0x3fff;
      return [((0x2 << 28) | g | (((0xe0 | (packet.channel & 0xf)) & 0xff) << 16)
        | ((v & 0x7f) << 8) | ((v >> 7) & 0x7f)) >>> 0];
    }
    case 'jrClock':
      return [((0x0 << 28) | g | (0x1 << 16) | (packet.value & 0xffff)) >>> 0];
    case 'jrTimestamp':
      return [((0x0 << 28) | g | (0x2 << 16) | (packet.value & 0xffff)) >>> 0];
    default:
      throw new Error(`encodeUmp: cannot encode message type ${packet.type}`);
  }
}

export function toHex(words) {
  return words.map((w) => '0x' + (w >>> 0).toString(16).toUpperCase().padStart(8, '0')).join(' ');
}
