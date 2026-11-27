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
- send **per-note expression** (per-note pitch bend and polyphonic pressure)
  and pick the degradation policy an identity-less sink must use — refuse,
  channel-wide approximation, note migration onto a dedicated channel, or
  staged deferral until the note can be isolated;
- choose the **sink protocol** and its **available channels**, and switch the
  sink or shrink its channel list while notes are sounding — the bridge takes
  over every sounding voice, closes the old wire voices first, migrates the
  ones still held, and recomputes the realised pitch error;
- pick the **fallback policy** when no channel is free (fold or refuse) and how
  wide controls are carried on a 7-bit sink (split to 14-bit or quantise);
- read the **bridge decisions** log and the **sound timeline**, which are
  computed from the same engine the tests use — and hear the result, because the
  panel feeds the emitted messages to a Web Audio instrument;
- see the **precision report** comparing intended and delivered control codes,
  and the **expression degradation & diagnostics** panel: which per-note
  controls mapped to a real channel carrier, which were approximated, deferred,
  or refused, the stored quantisation / state-merge / loop-guard records, and
  any endpoint or monotonicity rule violation;
- run the **migrate-note vs staged-degrade comparison** against the real
  renderer, and load the boundary / multi-group / mixed fixtures, with
  unsupported messages surfaced as inline diagnostics.

Every panel button calls the shared high-precision engine (`src/core/*`); no
button prints a fixed canned result in place of a bridge decision or a sound
time.

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
node src/cli.js degrade
node src/cli.js compare [--channels 0,1,2] [--bend 0.625]
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

## Endpoint degradation for per-note expression

A high-precision source carries expression addressed to one note. A lower
capability endpoint cannot always address that note, so the bridge never throws
the semantics away silently. Each per-note control is classified into one of
four dispositions (`src/core/degradation.js`, shown live in the panel and via
`cli degrade`):

| disposition | meaning | loss class |
|---|---|---|
| `channel` | a real channel-level carrier exists; delivered after quantisation | quantisable |
| `approximate` | a channel-wide message stands in, but moves every other voice on the channel too | destructive |
| `extra-channel` | only recoverable by moving the note onto its own channel first | quantisable after the move |
| `refuse` | no carrier can express it without altering other notes; rejected with a machine-readable reason | destructive, but explicit |

Concrete mappings, using only carriers the endpoint actually parses:

- **polyphonic pressure** — MIDI 1 has a native `(channel, note)` poly-pressure
  message, so it maps to a real channel carrier and only loses width (32→7 bit).
- **per-note pitch bend** — needs note identity. On an identity-less port it is
  either an isolated-channel bend, an `extra-channel` migration, a destructive
  channel-wide approximation, a staged deferral, or a refusal. It is never
  packed into a vendor/private field the endpoint would ignore.
- **channel CC / bend / pressure** — channel carriers exist; the only loss is
  quantisation (7/14-bit), measured per event.

### The two strategies, compared

For a per-note bend arriving while other notes share the channel
(`src/core/comparison.js`, panel **Compare migration vs staged**, or
`cli compare`):

- **migrate-note** — the note is re-homed onto a free channel immediately
  (Note Off then Note On, same internal instance), then a channel bend reaches
  only it. The expression is heard during the overlap and the pitch error is
  just the endpoint's 14-bit quantisation, but it costs a retrigger and a
  channel. With no free channel it **refuses** rather than bending the
  neighbour.
- **staged-degrade** — the note stays put and the bend is **withheld** until a
  release/renegotiation isolates it, at which point it is applied; if the note
  ends first the withheld bend is closed as a documented loss. No retrigger and
  no extra channel, but the bend is silent during the overlap.

Both run through the real bridge and the real renderer, so the comparison
reports actual wire events, retrigger counts, measured cents error, and wire
balance — not intent.

### Capability renegotiation while playing

`setSink` now covers a same-protocol channel shrink, not only a protocol switch.
Before re-routing it emits an explicit Note Off for every wire voice on the
endpoint being left, so a removed channel cannot leave a dangling note. The
still-sounding notes are then migrated in press order, any stored per-note bend
or pressure is re-applied on the new channel, and the realised pitch error is
recomputed against the new endpoint width. The returned `renegotiation` block
names the removed channels.

### Quantisation diagnostics and the loop guard

- The diagnostic store (`src/core/diagnostics.js`) keeps every quantisation,
  state-merge, migration, deferral, refusal and loop event. Distinct inputs that
  collapse onto one code are recorded together with their spread; each record is
  checked against the nearest-code endpoint rule, and successive codes of one
  field must stay monotone. Any breach surfaces in `diagnostics.violations()` and
  the panel instead of corrupting a note quietly.
- A bidirectional pair of bridges uses `src/core/loopguard.js`: outputs carry a
  non-enumerable echo token, and an event recognised as this bridge's own
  returning echo is suppressed once (`loop-echo-suppressed`) and recorded.
  Releases carry the same instance id as their press, so after a channel
  migration the Note Off still settles the exact voice — no hanging note.

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
src/core/ump.js          UMP subset codec (length from message type, diagnostics)
src/core/precision.js    fixed numeric mapping + capability table
src/core/internal.js     internal event representation and formatting
src/core/bridge.js       routing, identity, split/fold/refuse, loss reporting,
                         renegotiation, per-note expression migration/deferral
src/core/degradation.js  endpoint disposition matrix + per-note bend pitch maths
src/core/diagnostics.js  quantisation / state-merge / refusal diagnostic store
src/core/loopguard.js    bidirectional echo suppression (no event loops)
src/core/comparison.js   migrate-note vs staged-degrade strategy comparison
src/core/render.js       test processor: replays emitted messages, times voices
src/core/fixtures.js     boundary, multi-group, mixed and sweep fixtures
src/core/scenario.js     the duplicate-key switch acceptance scenario
src/cli.js               auxiliary command-line helper
public/                  graphical control panel (HTML/CSS + ES modules)
scripts/serve.js         zero-dependency static server for the panel
test/                    node:test suites (codec, bridge, scenario, cli, degradation)
```

## Tests

```sh
npm test
```

Covers packet-length grouping, unsupported-message rejection and resync, exact
16/32-bit round trips, quantisation measurement, identity preservation, split /
fold / refuse behaviour, bounded extra events, all fixtures, and the three
acceptance settings. The `degradation` suite additionally pins:

- the static disposition matrix and live per-note-bend resolution;
- high-resolution controller gradients (fine steps kept wide, collapsed and
  recorded on a 7-bit sink, with endpoint + monotonicity rule checks);
- poly-pressure mapping to its native MIDI 1 carrier;
- multi-voice independent bends under migration, channel approximation (with
  measured cents error), and staged deferral / expiry;
- capability renegotiation mid-performance, including same-protocol channel
  shrink with no dangling voice and recomputed pitch error;
- the migrate-note vs staged-degrade comparison rendered from real wire events;
- bidirectional loop-guard echo suppression and instance-correct release after
  a channel move.

## Running it

The graphical control panel is the primary entry point for high-precision
events; the command line is only an auxiliary path.

1. `npm start` (or `node scripts/serve.js`) and open
   `http://127.0.0.1:5173`.
2. In **Event source** pick the protocol mode, then use **Per-note expression**
   to send a per-note pitch bend or poly pressure; choose the per-note policy
   (refuse / approximate / migrate / stage) and press **Compare migration vs
   staged** to render the strategy table.
3. Under **Sink (receiver) port** change the protocol or reduce the available
   channels and press **Apply sink change** while notes are sounding to trigger
   renegotiation; watch the **Sound timeline**, **Wire messages**, and the
   **Expression degradation & diagnostics** panel for what was lost and why.
4. Auxiliary checks: `node src/cli.js degrade`, `node src/cli.js compare`,
   `node src/cli.js scenario`, and `npm test`.
