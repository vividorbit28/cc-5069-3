# High-precision music event bridge

A bridge between a deliberately chosen subset of UMP (Universal MIDI Packet /
MIDI 2.0) messages and an internal, identity-preserving event representation,
which is then executed against a configurable sink port and a test processor
that records what would actually sound.

The point of the project is the *decision* a bridge has to make when the
receiver is less capable than the source: keep independent note identity, split
onto another channel, fold two voices into one, or refuse the takeover. The
bridge does that with real arithmetic and reports, per event, which precision
loss is merely quantisable and which one has destroyed independent release.

## Graphical entry point (primary)

The high-precision event control panel is the main interface:

```sh
npm start            # zero-dependency static server, same code the tests use
# open http://127.0.0.1:5173
```

In the panel you can:

- choose the **protocol mode** of the source (UMP/MIDI 2.0 with 16/32-bit
  fields, or UMP/MIDI 1.0 with 7-bit fields) and send note, controller,
  pitch-bend and fine-sweep events;
- choose the **sink protocol** and its **available channels**, and switch the
  sink while notes are sounding — the bridge takes over every sounding voice;
- pick the **fallback policy** when no channel is free (fold or refuse) and how
  wide controls are carried on a 7-bit sink (split to 14-bit or quantise);
- read the **bridge decisions** log and the **sound timeline**, which are
  computed from the same engine the tests use — and hear the result, because the
  panel feeds the emitted messages to a Web Audio instrument;
- see the **precision report** comparing intended and delivered control codes;
- load the boundary / multi-group / mixed fixtures, with unsupported messages
  surfaced as inline diagnostics.

## Command-line helper (auxiliary)

The CLI exists to script the same high-precision engine; it is not a substitute
for decoding.

```sh
node src/cli.js decode 0x40903C01 0xFFFF0001 0x00000000 0x00000000
node src/cli.js encode --type noteOn --channel 0 --note 60 --velocity 65535 --note-id 7
node src/cli.js map --value 2147483648 --from 32 --to 16,14,7
node src/cli.js scenario [--channels 0,1,2,3] [--note-conflict fold|refuse] [--json]
node src/cli.js fixtures
node src/cli.js policy
node src/cli.js serve        # prints the graphical entry point
```

Every value is printed with the integer code it represents at its field width,
so `0.996109 (65280/65535)` rather than a bare decimal.

## Supported UMP subset

Packet length is taken from the message-type nibble, and a multi-word message is
never split into independent 32-bit events.

| MT | Message | Words | Notes |
|----|---------|-------|-------|
| `0x0` | Utility: JR Clock `0x1`, JR Timestamp `0x2` | 32-bit | other utility status rejected |
| `0x2` | MIDI 1.0 Channel Voice | 32-bit | Note On/Off, CC, Pitch Bend, Channel Pressure |
| `0x3` | SysEx7 | 64-bit | single-packet (complete) only |
| `0x4` | MIDI 2.0 Channel Voice | 128-bit | Note On/Off, Poly Pressure, CC, Channel Pressure, Pitch Bend, Per-Note Pitch Bend, Per-Note Management |
| `0xD` | Flex Data | 128-bit | Tempo, Time Signature |

Everything else — `0x1, 0x5, 0x6, 0x7, 0x8, 0x9, 0xA, 0xB, 0xC, 0xE, 0xF`,
unknown status bytes, multi-packet SysEx, and non-zero note attribute types — is
rejected with a machine-readable reason. It is never guessed into a different
control.

### Note identity on the wire

Two simultaneous presses of the same key on the same channel must be two
distinct events. The only carrier for that inside the subset is MIDI 2.0 Note
On/Off **Attribute Type `0x01`**, whose 16-bit Attribute Data field holds a
voice id. The bridge treats that as the source note identity; Attribute Type
`0x00` means "no identity supplied", and a release without identity settles
FIFO on the oldest matching sounding note.

## Internal representation and precision

- Values are held as unit doubles plus the raw wire integer. Nothing is
  truncated to a legacy width and widened again: a 32-bit controller stays a
  32-bit code until a final encoder boundary quantises it.
- The fixed mapping policy is inspectable at runtime (`cli policy`, the panel
  footer): unit form is `value / (2^bits - 1)`, denormalisation is
  `round(value * (2^bits - 1))` with halves rounding up, and 32-bit widths use
  arithmetic `2 ** bits` rather than a bit shift (which would wrap in JS).
- Every routed event reports a loss list. A loss is either `quantisable: true`
  (the control is delivered, at a coarser code, with a measured error) or
  `quantisable: false` (something real was destroyed, e.g. note identity).

The effective resolution is measurable: `map --value N --to 16,14,7` shows the
delivered code and error at each width, and the tests assert that a step below
one 7-bit code changes the 14-bit output but not the 7-bit one.

## Bridge decisions on a channel-only sink

A channel-only sink addresses a voice by `(channel, note)`, so two presses of
the same note need two channels.

- **split** — a channel free of that note exists; keep the independent voice and
  its independent release.
- **fold** — no channel is free and `noteConflict: 'fold'`; merge into the
  existing same-note wire voice with a reference count. The wire voice stops only
  when the last internal key is released, so one key's release leaves a
  **residue** (it keeps sounding). This is the loss that destroys independent
  release.
- **refuse** — no channel is free and `noteConflict: 'refuse'`; the new voice is
  not taken over, and the existing voice is untouched.

Termination is traceable: every wire Note On the bridge emits has exactly one
matching wire Note Off (or is closed by a port switch), and extra events per
input are bounded by `maxExtraEventsPerInput` (used only by 14-bit controller
splitting).

Note that a legacy channel is polyphonic: different notes share one channel
freely. Contention only arises for **the same note**, which is the case that
needs a second channel (or a fold). A fold chain of any length closes on the
last release — three same-note presses on one channel produce one wire Note On
and one wire Note Off, with two suppressed releases in between.

## Acceptance scenario

`runSwitchScenario` (`src/core/scenario.js`) is the review scenario, and
`cli scenario` prints it:

1. two simultaneous presses of one key arrive on the UMP/MIDI 2.0 port with
   distinct identities;
2. mid-performance the sink switches to a legacy channel-only port;
3. each key is released in turn.

Results (from `node src/cli.js scenario`):

| sink setting | decisions | independent release | residue after one release | loss |
|---|---|---|---|---|
| 4 channels free | 2 × split | **preserved** | 1 voice (the other key) | velocity re-quantised – quantifiable |
| 1 channel, fold | 1 × split, 1 × fold | **destroyed** | 1 voice (the folded voice keeps sounding) | note identity – destructive |
| 1 channel, refuse | 1 × split, 1 × refuse | **destroyed** | 0 (voice never taken over) | voice refused – destructive |

All three keep the wire Note On/Off accounting balanced.

## Layout

```
src/core/ump.js        UMP subset codec (length from message type, diagnostics)
src/core/precision.js  fixed numeric mapping + capability table
src/core/internal.js   internal event representation and formatting
src/core/bridge.js     routing, identity, split/fold/refuse, loss reporting
src/core/render.js     test processor: replays emitted messages, times voices
src/core/fixtures.js   boundary, multi-group, mixed and sweep fixtures
src/core/scenario.js   the duplicate-key switch acceptance scenario
src/cli.js             auxiliary command-line helper
public/                graphical control panel (HTML/CSS + ES modules)
scripts/serve.js       zero-dependency static server for the panel
test/                  node:test suites (codec, bridge, scenario, cli)
```

## Tests

```sh
npm test
```

Covers packet-length grouping, unsupported-message rejection and resync, exact
16/32-bit round trips, quantisation measurement, identity preservation, split /
fold / refuse behaviour, bounded extra events, all fixtures, and the three
acceptance settings.
