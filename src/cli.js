#!/usr/bin/env node
// Command-line helper for the high-precision event bridge.
//
// This CLI is deliberately auxiliary: the graphical control panel (npm start)
// is the primary high-precision-event entry point. The CLI exposes the same
// engine for scripted checks: decoding, mapping, the switch scenario, fixture
// round-trips, and policy inspection.
//
//   node src/cli.js decode <hex words...>
//   node src/cli.js encode --type noteOn --channel 0 --note 60 --velocity 65535 [--note-id 1] [--group 0]
//   node src/cli.js map --value 123456 [--from 32] [--to 7] [--to 14]
//   node src/cli.js scenario [--channels 0,1,2,3] [--note-conflict fold|refuse]
//   node src/cli.js fixtures
//   node src/cli.js policy
//   node src/cli.js serve            # prints the graphical entry point
//
// It does not print raw decimals as a substitute for decoding: every value is
// shown with the integer code it represents at its field width.

import {
  decodeUmpStream, encodeUmp, toHex,
} from './core/ump.js';
import { eventFromUmp, describeEvent } from './core/internal.js';
import { uintToUnit, unitToUint, compareLevel, policySummary, PROTOCOLS, maxForBits } from './core/precision.js';
import { runSwitchScenario } from './core/scenario.js';
import { allFixtures } from './core/fixtures.js';
import { decodeUmp } from './core/ump.js';

const BOOLEAN_FLAGS = new Set(['json']);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) { args[key] = true; continue; }
      const next = argv[i + 1];
      if (next != null && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const num = (v, d) => (v == null ? d : Number.parseInt(v, 10));

function parseHexWords(tokens) {
  const words = [];
  for (const token of tokens) {
    for (const part of token.split(',')) {
      const t = part.trim();
      if (!t) continue;
      const clean = t.startsWith('0x') || t.startsWith('0X') ? t.slice(2) : t;
      const value = Number.parseInt(clean, 16);
      if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) {
        throw new Error(`not a 32-bit hex word: ${part}`);
      }
      words.push(value >>> 0);
    }
  }
  return words;
}

function cmdDecode(args) {
  const words = parseHexWords(args._.slice(1));
  if (!words.length) throw new Error('decode needs at least one 32-bit hex word');
  const { events, errors } = decodeUmpStream(words);
  if (args.json) {
    console.log(JSON.stringify({
      words, hex: toHex(words),
      events: events.map((e) => ({ index: e.index, group: e.group, message: e.message, words: e.words })),
      errors,
    }, null, 2));
    return;
  }
  console.log(`words: ${toHex(words)}`);
  for (const e of events) {
    const ev = eventFromUmp(e.group, e.message);
    console.log(`  @${e.index} ${describeEvent(ev)}`);
    console.log(`      wire: ${toHex(e.words)}`);
  }
  if (errors.length) {
    console.log('rejections:');
    for (const err of errors) {
      console.log(`  @${err.index} [${err.code}] ${err.message}${err.detail ? ' ' + JSON.stringify(err.detail) : ''}`);
    }
  }
  console.log(`decoded ${events.length} event(s), ${errors.length} rejection(s)`);
}

function cmdEncode(args) {
  const type = args.type;
  if (!type) throw new Error('encode needs --type');
  const packet = { type };
  for (const key of ['channel', 'note', 'velocity', 'controller', 'value', 'noteId']) {
    if (args[key] != null) packet[key] = num(args[key]);
  }
  if (args['note-id'] != null) packet.noteId = num(args['note-id']);
  const words = encodeUmp(packet, { group: num(args.group, 0) });
  console.log(toHex(words));
  const back = decodeUmp(words);
  console.log(`re-decoded: ${describeEvent(eventFromUmp(back.group, back.message))}`);
}

function cmdMap(args) {
  const value = num(args.value, 0);
  const fromBits = num(args.from, 16);
  const unit = uintToUnit(value, fromBits);
  console.log(`input ${value}/${maxForBits(fromBits)} at ${fromBits}-bit -> unit ${unit.toFixed(9)}`);
  const targets = (args.to ? String(args.to).split(',') : ['16', '14', '7']).map(Number);
  for (const bits of targets) {
    const cmp = compareLevel(unit, bits);
    console.log(`  -> ${bits}-bit code ${cmp.code}/${maxForBits(bits)}, error ${cmp.error.toExponential(3)} unit (${cmp.withinHalfStep ? 'within half step' : 'OUTSIDE half step'})`);
  }
}

function channelsFrom(args) {
  if (!args.channels) return [0, 1, 2, 3];
  return String(args.channels).split(',').map((x) => Number.parseInt(x.trim(), 10));
}

function printScenario(label, r) {
  console.log(`\n=== ${label} ===`);
  console.log(`sink channels: [${r.params.availableChannels.join(', ')}]  policy noteConflict=${r.params.noteConflict}`);
  for (const step of r.steps) {
    const out = step.outputs.length ? step.outputs.map((o) => o.hex).join(' | ') : '(no wire output)';
    console.log(`  t=${step.atMs}ms ${step.label} -> ${step.decision}`);
    if (step.decisions) {
      for (const d of step.decisions) console.log(`      voice #${d.noteId} (n${d.note}) -> ${d.decision}${d.reason ? ' — ' + d.reason : ''}`);
    }
    console.log(`      wire: ${out}`);
    const residue = step.residue ? '  RESIDUE: release suppressed' : '';
    console.log(`      sounding after: [${step.soundingAfter.map((v) => `v${v.voiceId}@ch${v.channel}n${v.note}`).join(', ')}]${residue}`);
  }
  console.log(`  decision summary: ${JSON.stringify(r.decisionSummary)}`);
  console.log(`  independent release preserved: ${r.independentRelease}`);
  console.log(`  voices still sounding after releasing key #1 only: ${r.residueAfterSingleRelease}`);
  console.log(`  quantifiable loss: ${r.quantifiableLoss.map((l) => `${l.field} err=${l.error.toExponential(3)} @${l.bits}bit`).join('; ') || 'none'}`);
  console.log(`  destructive loss:  ${r.destructiveLoss.map((l) => `${l.field} (${l.note})`).join('; ') || 'none'}`);
  console.log(`  wire Note On/Off balanced: ${r.renderer.balanced}`);
}

function cmdScenario(args) {
  const channels = channelsFrom(args);
  const noteConflict = args['note-conflict'] ?? 'fold';
  const settings = [
    { label: 'free channel available', availableChannels: channels.length ? channels : [0, 1, 2, 3] },
    { label: 'all channels occupied (fold)', availableChannels: [channels[0] ?? 0], noteConflict: 'fold' },
    { label: 'all channels occupied (refuse)', availableChannels: [channels[0] ?? 0], noteConflict: 'refuse' },
  ];
  const results = settings.map((s) => runSwitchScenario({ availableChannels: s.availableChannels, noteConflict: s.noteConflict ?? noteConflict }));
  if (args.json) {
    console.log(JSON.stringify(settings.map((s, i) => ({ label: s.label, result: results[i] })), null, 2));
    return;
  }
  settings.forEach((s, i) => printScenario(s.label, results[i]));
}

function cmdFixtures() {
  const fx = allFixtures();
  for (const [name, value] of Object.entries(fx)) {
    console.log(`\n--- fixture: ${name} ---`);
    if (!Array.isArray(value)) {
      // A raw mixed stream: decode it whole so 128-bit messages stay one event.
      const { events, errors } = decodeUmpStream(value.words);
      for (const e of events) {
        console.log(`  @${e.index} ${toHex(e.words)} -> ${describeEvent(eventFromUmp(e.group, e.message))}`);
      }
      for (const err of errors) {
        console.log(`  @${err.index} [${err.code}] ${err.message}${err.detail ? ' ' + JSON.stringify(err.detail) : ''}`);
      }
      for (const note of value.notes) console.log(`  * ${note}`);
      continue;
    }
    for (const item of value) {
      const { events, errors } = decodeUmpStream(item.words);
      const shown = events.map((e) => describeEvent(eventFromUmp(e.group ?? item.group ?? 0, e.message)));
      const errs = errors.map((e) => `[${e.code}] ${e.message}`);
      console.log(`  ${toHex(item.words)} -> ${shown.join('; ') || '(no event)'}${errs.length ? '  !! ' + errs.join('; ') : ''}`);
    }
  }
}

function cmdPolicy() {
  console.log('numeric mapping policy:');
  for (const [k, v] of Object.entries(policySummary())) console.log(`  ${k}: ${v}`);
  console.log('\nprotocol capability:');
  for (const p of Object.values(PROTOCOLS)) {
    console.log(`  ${p.id}: velocity ${p.velocityBits}bit, controller ${p.controllerBits}bit, pitchbend ${p.pitchBendBits}bit, per-note bend ${p.perNotePitchBend}, identity: ${p.noteIdentity}`);
  }
}

function cmdServe() {
  console.log('Graphical entry point for high-precision events:');
  console.log('  npm start');
  console.log('  then open http://localhost:5173  (the high-precision event control panel)');
  console.log('The CLI is an auxiliary path for scripted checks; the panel is the primary interface.');
}

function usage() {
  console.log(`high-precision event bridge CLI (auxiliary; graphical panel is via "npm start")

  decode <hex words...>            decode a UMP stream and show events + rejections
  encode --type T [fields...]      encode one message to hex and re-decode it
  map --value N [--from B] [--to B[,B]]   show quantisation error at target widths
  scenario [--channels a,b] [--note-conflict fold|refuse]
                                   run the duplicate-key switch acceptance scenarios
  fixtures                         decode the boundary / multi-group / mixed fixtures
  policy                           print the fixed mapping policy and capabilities
  serve                            print the graphical entry point

Fields for encode: --channel --note --velocity --controller --value --note-id --group
Hex words may be written 0x40903C01 or 40903C01, space or comma separated.`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? 'help';
  try {
    switch (cmd) {
      case 'decode': return cmdDecode(args);
      case 'encode': return cmdEncode(args);
      case 'map': return cmdMap(args);
      case 'scenario': return cmdScenario(args);
      case 'fixtures': return cmdFixtures();
      case 'policy': return cmdPolicy();
      case 'serve': return cmdServe();
      case 'help': case '--help': case '-h': return usage();
      default:
        console.error(`unknown command: ${cmd}`);
        usage();
        process.exitCode = 2;
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
