// High-precision event control panel — browser entry point.
//
// Builds real UMP words from the controls, decodes them with the shared codec,
// routes them with the shared bridge, and feeds the bridge's actual output to
// both the shared renderer (for the sound timeline) and the Web Audio engine
// (for audible sound). Nothing here prints raw decimals in place of decoding:
// every control value is shown with the integer code it represents.

import { encodeUmp, decodeUmpStream } from '/src/core/ump.js';
import { eventFromUmp } from '/src/core/internal.js';
import { createBridge } from '/src/core/bridge.js';
import { createRenderer } from '/src/core/render.js';
import { uintToUnit, compareLevel, maxForBits, policySummary, PROTOCOLS } from '/src/core/precision.js';
import { degradationCatalogue, DISPOSITION } from '/src/core/degradation.js';
import { compareDegradationStrategies } from '/src/core/comparison.js';
import {
  duplicateNoteFixture, boundaryAndGroupsFixture, crossGroupSameNoteFixture, mixedUnsupportedFixture,
} from '/src/core/fixtures.js';
import { createAudioEngine } from '/public/audio.js';

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status-pill'),
  log: $('decision-log'),
  alerts: $('alert-area'),
  timeline: $('timeline'),
  wire: $('wire-out'),
  precision: $('precision'),
  degradation: $('degradation'),
  policyLine: $('policy-line'),
  velReadout: $('vel-readout'),
  ccReadout: $('cc-readout'),
};

const mode = () => document.querySelector('input[name="mode"]:checked').value;

let bridge;
let renderer;
const audio = createAudioEngine();
let clock = 0; // monotonic ms, advanced per emitted batch
let wireLines = [];

function sinkConfig() {
  return {
    protocol: $('sink-protocol').value,
    availableChannels: $('sink-channels').value
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 15),
    policy: {
      noteConflict: $('policy-note-conflict').value,
      controlResolution: $('policy-control').value,
      perNoteControl: $('policy-per-note').value,
    },
  };
}

function ensureBridge(force = false) {
  if (!bridge || force) {
    const cfg = sinkConfig();
    bridge = createBridge({ sink: { protocol: cfg.protocol, availableChannels: cfg.availableChannels }, policy: cfg.policy });
    renderer = createRenderer();
    clock = 0;
    wireLines = [];
    el.log.innerHTML = '';
    el.alerts.innerHTML = '';
    el.wire.textContent = '';
    el.timeline.innerHTML = '';
    el.precision.innerHTML = '';
    el.degradation.innerHTML = '';
    audio.allOff();
  }
  return bridge;
}

function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.className = 'status ' + kind;
}

function showAlert(message, kind = 'error') {
  const node = document.createElement('div');
  node.className = 'alert' + (kind === 'warn' ? ' warn' : '');
  node.textContent = message;
  el.alerts.appendChild(node);
  while (el.alerts.children.length > 4) el.alerts.firstChild.remove();
}

function clearAlerts() { el.alerts.innerHTML = ''; }

// ---- input construction ---------------------------------------------------

function noteVelocity() {
  return Math.max(1, Math.min(65535, Number.parseInt($('note-velocity-exact').value, 10) || 1));
}

function buildNotePacket(type) {
  const m = mode();
  const group = Number.parseInt($('note-group').value, 10) || 0;
  const channel = Number.parseInt($('note-channel').value, 10) || 0;
  const note = Number.parseInt($('note-number').value, 10) || 0;
  const velocity = noteVelocity();
  if (m === 'ump-midi1') {
    // Legacy mode quantises to 7 bits, then re-expands via the shared mapping so
    // the panel can show the exact resolution the source actually delivered.
    const v7 = Math.round(uintToUnit(velocity, 16) * 127);
    return { group, packet: { type, channel, note, velocity: v7 }, displayBits: 7, source16: velocity };
  }
  return { group, packet: { type, channel, note, velocity }, displayBits: 16, source16: velocity };
}

function nextIdentity() {
  // 16-bit wire identity; -1 sentinel is fine, we keep a counter.
  return (window.__nextNodeId = (window.__nextNodeId ?? 0) % 65534 + 1);
}

// ---- routing through the bridge -------------------------------------------

function processEvent(ev, label) {
  const b = ensureBridge();
  let result;
  try {
    result = b.handle(ev);
  } catch (err) {
    showAlert(`bridge error on ${label}: ${err.message}`);
    setStatus('error', 'error');
    return null;
  }
  renderer.feed(clock, b.sinkProtocol, result.outputs);
  emitAudio(result);
  logDecision(clock, label, result);
  recordWire(result.outputs);
  if (result.losses.some((l) => l.quantisable === false)) {
    const l = result.losses.find((x) => x.quantisable === false);
    showAlert(`${label}: ${l.field} — ${l.note}`, 'warn');
  }
  renderAll();
  clock += 1;
  return result;
}

function bendOffset(msg) {
  // Signed normalised offset around centre for the field width the sink used.
  const wide = msg.port === 'ump-midi2';
  const max = wide ? 4294967295 : 16383;
  return (msg.value / max) * 2 - 1;
}

function emitAudio(result) {
  for (const output of result.outputs) {
    if (output.encoding === 'ump') {
      const { message } = decodeUmpStream(output.words);
      const msg = { ...message, group: output.group, port: output.protocol };
      if (msg.type === 'noteOn') {
        const level = msg.port === 'ump-midi2' ? msg.velocity / 65535 : msg.velocity / 127;
        audio.noteOn(msg, level);
      } else if (msg.type === 'noteOff') {
        audio.noteOff(msg);
      } else if (msg.type === 'pitchBend' || msg.type === 'perNotePitchBend') {
        audio.pitchBend(msg, bendOffset(msg));
      } else if (msg.type === 'polyPressure') {
        const max = msg.port === 'ump-midi2' ? 4294967295 : 127;
        audio.polyPressure(msg, msg.value / max);
      }
    } else if (output.encoding === 'midi1-bytes') {
      const b = output.bytes;
      const kind = b[0] & 0xf0;
      const channel = b[0] & 0x0f;
      if (kind === 0x90 && b[2] > 0) audio.noteOn({ group: output.group, port: output.protocol, channel, note: b[1], velocity: b[2] }, b[2] / 127);
      else if (kind === 0x80 || (kind === 0x90 && b[2] === 0)) audio.noteOff({ group: output.group, port: output.protocol, channel, note: b[1] });
      else if (kind === 0xe0) audio.pitchBend({ group: output.group, port: output.protocol, channel }, (((b[2] << 7) | b[1]) / 16383) * 2 - 1);
      else if (kind === 0xa0) audio.polyPressure({ group: output.group, port: output.protocol, channel, note: b[1] }, b[2] / 127);
    }
  }
}

// ---- logging & rendering --------------------------------------------------

function tagClass(decision) {
  if (/refus|reject|unmatched|dropped/.test(decision)) return 'refuse';
  if (/fold|suppress|residue/.test(decision)) return 'fold';
  if (/split/.test(decision)) return 'split';
  if (/identity|wide/.test(decision)) return 'identity';
  return 'info';
}

function logDecision(atMs, label, result) {
  const li = document.createElement('li');
  const tag = document.createElement('span');
  tag.className = 'tag ' + tagClass(result.decision);
  tag.textContent = result.decision;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = `${atMs}ms`;
  const msg = document.createElement('span');
  msg.textContent = `${label}${result.reason ? ' — ' + result.reason : ''}`;
  li.append(t, tag, msg);
  el.log.appendChild(li);
  el.log.scrollTop = el.log.scrollHeight;
}

function recordWire(outputs) {
  for (const o of outputs) wireLines.push(`t=${clock}ms [${o.protocol}] ${o.hex}   ${o.description}`);
  el.wire.textContent = wireLines.slice(-40).join('\n');
  el.wire.scrollTop = el.wire.scrollHeight;
}

function renderAll() {
  renderTimeline();
  renderPrecision();
  renderDegradation();
}

// Renders which class of expression was lost, deferred, approximated or merely
// quantised, plus the stored quantisation / merge / loop diagnostics. Every row
// comes from the bridge's real diagnostic store, not a static fixture.
function renderDegradation() {
  if (!bridge) return;
  const snap = bridge.snapshot();
  const diag = bridge.diagnostics();
  const rows = [];

  const dispositionLabel = (d) => ({
    [DISPOSITION.CHANNEL]: 'channel carrier (quantised)',
    [DISPOSITION.APPROXIMATE]: 'approximation — moves other voices',
    [DISPOSITION.EXTRA_CHANNEL]: 'extra channel required',
    [DISPOSITION.REFUSE]: 'refused — reason preserved',
  })[d] ?? d;

  rows.push('<div class="diag-block"><h3>Loss ledger (this session)</h3>');
  const losses = snap.diagnostics.filter((d) => d.kind === 'quantisation' || d.kind === 'refusal' || d.kind === 'deferred-expression' || d.kind === 'state-merge' || d.kind === 'loop-guard' || d.kind === 'migration');
  if (!losses.length) {
    rows.push('<p class="hint">No degradation recorded yet.</p>');
  } else {
    rows.push('<table><thead><tr><th>kind</th><th>field</th><th>detail</th><th>class</th></tr></thead><tbody>');
    for (const d of losses.slice(-40)) {
      let detail;
      let cls = '';
      if (d.kind === 'quantisation') detail = `${d.bits}-bit code ${d.code}/${d.maxCode}, err ${d.error.toExponential(2)}`;
      else if (d.kind === 'state-merge') detail = `${d.distinctInputs} inputs -> code ${d.code}, spread ${d.inputSpread.toExponential(2)}`;
      else if (d.kind === 'refusal') { detail = d.reason; cls = 'loss-destructive'; }
      else if (d.kind === 'deferred-expression') { detail = `withheld bend ${d.valueUnit.toFixed(4)}`; cls = 'loss-approx'; }
      else if (d.kind === 'migration') detail = `ch${d.fromChannel} -> ch${d.toChannel}: ${d.reason}`;
      else if (d.kind === 'loop-guard') detail = d.action;
      const disposition = d.violations?.length ? 'rule violation' : (cls ? dispositionLabel(cls === 'loss-destructive' ? DISPOSITION.REFUSE : DISPOSITION.APPROXIMATE) : 'quantisable');
      rows.push(`<tr class="${cls}"><td>${d.kind}</td><td>${d.field ?? '—'}</td><td>${detail ?? '—'}</td><td>${d.kind === 'quantisation' || d.kind === 'state-merge' ? 'quantisable' : disposition}</td></tr>`);
    }
    rows.push('</tbody></table>');
  }
  rows.push('</div>');

  rows.push('<div class="diag-block"><h3>Deferred per-note expression</h3>');
  if (!snap.deferred.length) rows.push('<p class="hint">Nothing held back.</p>');
  else {
    rows.push('<table><thead><tr><th>note</th><th>channel</th><th>intended bend unit</th></tr></thead><tbody>');
    for (const d of snap.deferred) rows.push(`<tr><td>${d.note}</td><td>${d.channel ?? '—'}</td><td>${d.valueUnit.toFixed(6)}</td></tr>`);
    rows.push('</tbody></table>');
  }
  rows.push('</div>');

  rows.push('<div class="diag-block"><h3>Endpoint capability (static matrix)</h3>');
  rows.push('<table><thead><tr><th>control</th><th>endpoint</th><th>carrier</th><th>disposition</th></tr></thead><tbody>');
  for (const c of degradationCatalogue()) {
    rows.push(`<tr><td>${c.type}${c.perNote ? ' *' : ''}</td><td>${c.endpoint}</td><td>${c.carrier} (${c.bits}bit)</td><td>${c.staticDisposition ?? 'live: extra-channel / approximate / refuse'}</td></tr>`);
  }
  rows.push('</tbody></table><p class="hint">* per-note control. No information is hidden in private fields the endpoint cannot parse.</p></div>');

  const violations = diag.violations();
  rows.push(`<p class="hint ${violations.length ? 'loss-destructive' : ''}">Diagnostic rule check: ${violations.length ? violations.length + ' violation(s)' : 'endpoint and monotonicity rules hold'} · loop guard: ${snap.loopGuard.totalStamped} stamped, ${snap.loopGuard.pendingEchoes} pending echoes</p>`);

  el.degradation.innerHTML = rows.join('');
}

function slimVoice(v) {
  return { voiceId: v.voiceId, port: v.port, channel: v.channel, note: v.note, velocity: v.velocity, wireIdentity: v.wireIdentity };
}

function renderTimeline() {
  if (!renderer) return;
  const rep = renderer.report();
  const end = Math.max(clock, ...rep.voices.map((v) => v.endMs ?? clock), 1);
  const span = Math.max(1, end);
  el.timeline.innerHTML = '';
  if (!rep.voices.length) {
    el.timeline.innerHTML = '<p class="hint">No wire voices yet. Press a note.</p>';
    return;
  }
  for (const v of rep.voices) {
    const row = document.createElement('div');
    row.className = 'voice-row' + (v.endMs == null ? ' residue' : '');
    const meta = document.createElement('div');
    meta.className = 'voice-meta';
    const id = v.wireIdentity != null ? `#${v.wireIdentity}` : 'ch';
    meta.textContent = `v${v.voiceId} ${v.port === 'legacy' ? 'leg' : v.port === 'ump-midi1' ? 'm1' : 'm2'} ch${v.channel} n${v.note} ${id}`;
    const bar = document.createElement('div');
    bar.className = 'voice-bar' + (v.endMs == null ? ' folded' : '');
    const fill = document.createElement('div');
    fill.className = 'fill' + (v.endMs == null ? ' open' : '');
    const left = (v.startMs / span) * 100;
    const width = Math.max(1.2, ((Math.min(v.endMs ?? clock, span) - v.startMs) / span) * 100);
    fill.style.left = `${left}%`;
    fill.style.width = `${width}%`;
    bar.appendChild(fill);
    const dur = document.createElement('div');
    dur.className = 'voice-dur';
    dur.textContent = v.endMs == null ? 'sounding' : `${(v.endMs - v.startMs).toFixed(0)}ms`;
    row.append(meta, bar, dur);
    el.timeline.appendChild(row);
  }
  const stillSounding = rep.stillSounding.length;
  if (stillSounding) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = `${stillSounding} wire voice(s) still sounding.`;
    el.timeline.appendChild(note);
  }
}

function renderPrecision() {
  if (!bridge) return;
  const snap = bridge.snapshot();
  const rows = [];
  rows.push(['<table><thead><tr><th>field</th><th>source</th><th>sink</th><th>delivered code</th><th>abs error</th><th>kind</th></tr></thead><tbody>']);
  for (const note of snap.sounding) {
    const sinkBits = bridge.sinkProtocol === 'ump-midi2' ? 16 : 7;
    const cmp = compareLevel(note.velocityUnit, sinkBits);
    const kind = cmp.exact ? 'exact' : 'quantised';
    rows.push(`<tr><td>velocity n${note.note} #${note.noteId}</td><td>${note.sourcePrecision?.velocityBits ?? 16}‑bit</td><td>${sinkBits}‑bit</td><td>${cmp.code}/${maxForBits(sinkBits)}</td><td class="${kind === 'exact' ? '' : 'loss-quant'}">${cmp.error.toExponential(2)}</td><td class="${kind === 'exact' ? '' : 'loss-quant'}">${kind}</td></tr>`);
  }
  rows.push('</tbody></table>');
  el.precision.innerHTML = rows.join('');
  if (!snap.sounding.length) el.precision.innerHTML = '<p class="hint">No sounding voices to report on.</p>';
}

// ---- public actions -------------------------------------------------------

function pressNote() {
  const { group, packet } = buildNotePacket('noteOn');
  packet.noteId = nextIdentity();
  const words = encodeUmp(packet, { group });
  const { events, errors } = decodeUmpStream(words);
  if (errors.length) { showAlert(`decode rejected our own message: ${errors[0].message}`); return; }
  const ev = eventFromUmp(events[0].group, events[0].message);
  processEvent(ev, `press n${packet.note} vel ${packet.velocity} ${mode() === 'ump-midi2' ? '#' + packet.noteId : '(7-bit)'}`);
}

function releaseByIdentity() {
  // Release the most recent still-sounding note via its source identity.
  const snap = bridge?.snapshot();
  if (!snap || !snap.sounding.length) { showAlert('no sounding note to release', 'warn'); return; }
  const target = snap.sounding[snap.sounding.length - 1];
  const group = target.group;
  const m = mode();
  const channel = target.channel ?? (Number.parseInt($('note-channel').value, 10) || 0);
  const note = target.note;
  const packet = { type: 'noteOff', channel, note, velocity: 0 };
  if (m === 'ump-midi2') {
    if (target.sourceNoteId != null) packet.noteId = target.sourceNoteId;
  }
  const words = encodeUmp(packet, { group });
  const { events } = decodeUmpStream(words);
  processEvent(eventFromUmp(events[0].group, events[0].message), `release by identity n${note} #${target.noteId}`);
}

function releaseByChannelNote() {
  const group = Number.parseInt($('note-group').value, 10) || 0;
  const channel = Number.parseInt($('note-channel').value, 10) || 0;
  const note = Number.parseInt($('note-number').value, 10) || 0;
  const packet = { type: 'noteOff', channel, note, velocity: 0 };
  const words = encodeUmp(packet, { group });
  const { events } = decodeUmpStream(words);
  processEvent(eventFromUmp(events[0].group, events[0].message), `release by channel+note ch${channel} n${note}`);
}

function sendController() {
  const group = 0;
  const channel = Number.parseInt($('note-channel').value, 10) || 0;
  const controller = Math.max(0, Math.min(127, Number.parseInt($('cc-number').value, 10) || 0));
  const value = Math.max(0, Math.min(0xffffffff, Number($('cc-value-exact').value)) >>> 0);
  const m = mode();
  if (m === 'ump-midi1') {
    const v7 = Math.round((value / 0xffffffff) * 127);
    const words = encodeUmp({ type: 'midi1ControlChange', channel, controller, value: v7 }, { group });
    const { events } = decodeUmpStream(words);
    processEvent(eventFromUmp(group, events[0].message), `CC${controller} = ${v7}/127 (7-bit mode)`);
  } else {
    const words = encodeUmp({ type: 'controlChange', channel, controller, value }, { group });
    const { events } = decodeUmpStream(words);
    processEvent(eventFromUmp(group, events[0].message), `CC${controller} = ${value}/${maxForBits(32)}`);
  }
}

function sendSweep() {
  const group = 0;
  const channel = Number.parseInt($('note-channel').value, 10) || 0;
  const controller = Math.max(0, Math.min(31, Number.parseInt($('cc-number').value, 10) || 1));
  const base = 0x80000000;
  const step = Math.floor(0xffffffff / 16383);
  for (let i = 0; i < 5; i++) {
    const value = (base + i * step) >>> 0;
    const words = encodeUmp({ type: 'controlChange', channel, controller, value }, { group });
    const { events } = decodeUmpStream(words);
    processEvent(eventFromUmp(group, events[0].message), `fine step ${i} CC${controller} = ${value}`);
  }
}

function sendBend() {
  const group = 0;
  const channel = Number.parseInt($('note-channel').value, 10) || 0;
  const value = Math.max(0, Math.min(0xffffffff, Number($('bend-value').value)) >>> 0);
  const words = encodeUmp({ type: 'pitchBend', channel, value }, { group });
  const { events } = decodeUmpStream(words);
  processEvent(eventFromUmp(group, events[0].message), `pitch bend = ${value}/${maxForBits(32)}`);
}

// Resolves the most recent matching sounding note so the per-note event carries
// the same source identity the bridge allocated on its Note On.
function targetSoundingNote(noteNumber) {
  const snap = bridge?.snapshot();
  if (!snap) return null;
  const matches = snap.sounding.filter((s) => s.note === noteNumber);
  return matches[matches.length - 1] ?? null;
}

function sendPerNoteBend() {
  const group = 0;
  const channel = Number.parseInt($('note-channel').value, 10) || 0;
  const note = Math.max(0, Math.min(127, Number.parseInt($('expr-note').value, 10) || 60));
  const value = Math.max(0, Math.min(0xffffffff, Number($('expr-bend').value)) >>> 0);
  const target = targetSoundingNote(note);
  if (!target) { showAlert('no sounding note matches the per-note bend target', 'warn'); return; }
  const packet = { type: 'perNotePitchBend', channel, note, value };
  if (target.sourceNoteId != null) packet.noteId = target.sourceNoteId;
  const words = encodeUmp(packet, { group });
  const { events, errors } = decodeUmpStream(words);
  if (errors.length) { showAlert(`decode rejected our own message: ${errors[0].message}`); return; }
  const result = processEvent(eventFromUmp(events[0].group, events[0].message), `per-note bend n${note} = ${value}`);
  if (result?.pitchErrors?.length) {
    const e = result.pitchErrors[0];
    showAlert(`bend delivered on ch${e.channel ?? '?'}: ${e.centsError.toFixed(3)} cents error at ${e.bits}-bit`, 'warn');
  }
}

function sendPolyPressure() {
  const group = 0;
  const channel = Number.parseInt($('note-channel').value, 10) || 0;
  const note = Math.max(0, Math.min(127, Number.parseInt($('expr-note').value, 10) || 60));
  const value = Math.max(0, Math.min(0xffffffff, Number($('expr-pressure').value)) >>> 0);
  const target = targetSoundingNote(note);
  if (!target) { showAlert('no sounding note matches the poly pressure target', 'warn'); return; }
  const packet = { type: 'polyPressure', channel, note, value };
  if (target.sourceNoteId != null) packet.noteId = target.sourceNoteId;
  const words = encodeUmp(packet, { group });
  const { events } = decodeUmpStream(words);
  processEvent(eventFromUmp(events[0].group, events[0].message), `poly pressure n${note} = ${value}`);
}

// Runs the real two-strategy comparison engine and renders its measured table.
function runComparison() {
  const channels = sinkConfig().availableChannels;
  const bendUnit = (Number($('expr-bend').value) >>> 0) / maxForBits(32);
  const r = compareDegradationStrategies({ channels, bendUnit });
  const box = document.createElement('div');
  box.className = 'compare-box';
  const title = document.createElement('h3');
  title.textContent = `migrate-note vs staged-degrade (bend ${bendUnit.toFixed(4)}, channels [${channels.join(',')}])`;
  box.appendChild(title);
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>axis</th><th>migrate-note</th><th>staged-degrade</th></tr></thead><tbody></tbody>';
  const body = table.querySelector('tbody');
  for (const row of r.contrast) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.axis}</td><td>${row.migrateNote}</td><td>${row.stagedDegrade}</td>`;
    body.appendChild(tr);
  }
  box.appendChild(table);
  el.degradation.prepend(box);
  showAlert('strategy comparison rendered from the shared bridge + renderer engine', 'warn');
}

function applySink() {
  const b = ensureBridge();
  const cfg = sinkConfig();
  if (!cfg.availableChannels.length) { showAlert('sink needs at least one valid channel (0–15)'); return; }
  b.setPolicy(cfg.policy);
  const switched = b.setSink(cfg);
  const changed = switched.from !== switched.to;
  renderer.closePort(switched.from, clock);
  audio.closePort(switched.from);
  renderer.feed(clock, cfg.protocol, switched.outputs);
  emitAudio({ outputs: switched.outputs });
  recordWire(switched.outputs);
  const li = document.createElement('li');
  const tag = document.createElement('span');
  tag.className = 'tag ' + (switched.decisions.some((d) => /refus/.test(d.decision)) ? 'refuse' : switched.decisions.some((d) => /fold/.test(d.decision)) ? 'fold' : 'split');
  tag.textContent = `sink → ${cfg.protocol}`;
  const t = document.createElement('span'); t.className = 't'; t.textContent = `${clock}ms`;
  const msg = document.createElement('span');
  const counts = switched.decisions.reduce((acc, d) => ((acc[d.decision] = (acc[d.decision] ?? 0) + 1), acc), {});
  msg.textContent = Object.entries(counts).map(([k, n]) => `${n}×${k}`).join(', ') || 'no sounding notes to move';
  li.append(t, tag, msg);
  el.log.appendChild(li);
  for (const d of switched.decisions) {
    if (/fold|refus/.test(d.decision)) {
      showAlert(`takeover #${d.noteId} n${d.note}: ${d.decision} — ${d.reason}`, 'warn');
    }
  }
  if (changed) setStatus(`sink: ${cfg.protocol}`, '');
  renderAll();
  clock += 1;
}

// ---- fixtures -------------------------------------------------------------

function runFixture(name) {
  const b = ensureBridge();
  const items = {
    duplicate: duplicateNoteFixture(),
    boundary: boundaryAndGroupsFixture(),
    crossGroup: crossGroupSameNoteFixture(),
  }[name];
  if (name === 'mixed') {
    const fx = mixedUnsupportedFixture();
    const { events, errors } = decodeUmpStream(fx.words);
    for (const e of events) {
      processEvent(eventFromUmp(e.group, e.message), `mixed: ${e.message.type}`);
    }
    for (const err of errors) {
      showAlert(`rejected @${err.index}: ${err.message}${err.detail ? ' [' + JSON.stringify(err.detail) + ']' : ''}`, 'warn');
    }
    setStatus('mixed fixture loaded', '');
    return;
  }
  if (!items) return;
  for (const item of items) {
    const { events, errors } = decodeUmpStream(item.words);
    if (errors.length) { showAlert(`fixture decode error: ${errors[0].message}`); continue; }
    for (const e of events) processEvent(eventFromUmp(e.group, e.message), `fixture ${name}: ${e.message.type}`);
  }
  setStatus(`fixture ${name} loaded`, '');
}

function reset() {
  ensureBridge(true);
  setStatus('idle', '');
  clearAlerts();
}

// ---- wiring ---------------------------------------------------------------

function syncRange(rangeId, numberId, readoutId, bits) {
  const range = $(rangeId);
  const number = $(numberId);
  const readout = $(readoutId);
  const update = (value) => {
    const v = Math.max(Number(range.min), Math.min(Number(range.max), Number(value) || 0));
    range.value = v;
    number.value = v;
    const unit = bits === 16 ? uintToUnit(v, 16) : v / maxForBits(32);
    readout.textContent = bits === 16
      ? `${(unit * 100).toFixed(2)}% (${v}/${maxForBits(16)})`
      : `code ${v}/${maxForBits(32)}`;
  };
  range.addEventListener('input', () => update(range.value));
  number.addEventListener('input', () => update(number.value));
  update(number.value);
}

function init() {
  ensureBridge();
  syncRange('note-velocity', 'note-velocity-exact', 'vel-readout', 16);
  syncRange('cc-value', 'cc-value-exact', 'cc-readout', 32);

  $('btn-note-on').addEventListener('click', pressNote);
  $('btn-note-on-duplicate').addEventListener('click', pressNote);
  $('btn-note-off').addEventListener('click', releaseByIdentity);
  $('btn-release-note').addEventListener('click', releaseByChannelNote);
  $('btn-cc').addEventListener('click', sendController);
  $('btn-sweep').addEventListener('click', sendSweep);
  $('btn-bend').addEventListener('click', sendBend);
  $('btn-per-note-bend').addEventListener('click', sendPerNoteBend);
  $('btn-poly-pressure').addEventListener('click', sendPolyPressure);
  $('btn-compare').addEventListener('click', runComparison);
  $('btn-apply-sink').addEventListener('click', applySink);
  $('btn-clear').addEventListener('click', () => { el.log.innerHTML = ''; el.wire.textContent = ''; wireLines = []; });
  $('btn-reset').addEventListener('click', reset);
  for (const btn of document.querySelectorAll('[data-fixture]')) {
    btn.addEventListener('click', () => runFixture(btn.dataset.fixture));
  }

  const policy = policySummary();
  const caps = PROTOCOLS['ump-midi2'];
  el.policyLine.textContent = `policy: ${policy.unitMapping}, ${policy.denormalise} · source ${caps.velocityBits}/${caps.controllerBits}-bit`;

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'z') pressNote();
    if (e.key === 'x') releaseByIdentity();
  });

  setStatus('ready', '');
}

init();
