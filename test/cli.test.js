import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const run = (args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('cli decode prints events with codes, not bare decimals', () => {
  const out = run(['decode', '0x40903C01', '0xFFFF0001', '0', '0']);
  assert.match(out, /noteOn/);
  assert.match(out, /65535\/65535/);
});

test('cli decode --json emits structured events', () => {
  const out = run(['decode', '--json', '0x40903C01', '0xFFFF0001', '0', '0']);
  const parsed = JSON.parse(out);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].message.noteId, 1);
  assert.equal(parsed.errors.length, 0);
});

test('cli map shows quantisation error and widths', () => {
  const out = run(['map', '--value', '2147483648', '--from', '32', '--to', '7']);
  assert.match(out, /7-bit code/);
  assert.match(out, /error/);
});

test('cli scenario runs the three settings and reports residue', () => {
  const out = run(['scenario', '--channels', '0,1,2,3']);
  assert.match(out, /free channel available/);
  assert.match(out, /all channels occupied \(fold\)/);
  assert.match(out, /all channels occupied \(refuse\)/);
  assert.match(out, /independent release preserved: true/);
  assert.match(out, /independent release preserved: false/);
  assert.match(out, /wire Note On\/Off balanced: true/);
});

test('cli policy prints the fixed mapping contract', () => {
  const out = run(['policy']);
  assert.match(out, /value \/ \(2\^bits - 1\)/);
  assert.match(out, /round\(value \* \(2\^bits - 1\)\)/);
});

test('cli decode reports unsupported message types as rejections', () => {
  const out = run(['decode', '0x10F80000']);
  assert.match(out, /unsupported/);
  assert.match(out, /Message type 0x1/);
});

test('cli degrade prints the per-control disposition matrix', () => {
  const out = run(['degrade']);
  assert.match(out, /endpoint degradation matrix/);
  assert.match(out, /perNotePitchBend/);
  assert.match(out, /midi1-poly-pressure-7bit/);
  assert.match(out, /extra-channel/);
  assert.match(out, /refuse/);
});

test('cli compare reports both strategies and their measured trade-off', () => {
  const out = run(['compare', '--channels', '0,1,2']);
  assert.match(out, /migrate-note/);
  assert.match(out, /staged-degrade/);
  assert.match(out, /retriggers/);
  assert.match(out, /wire balance/);
});
