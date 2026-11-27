// Minimal Web Audio voice engine for the control panel.
//
// The panel is not only a model: pressing a note actually sounds it, so the
// "sound timing" shown next to the bridge decisions is backed by the same
// messages that were scheduled for playback. On a bridge switch the old port's
// oscillators are stopped exactly where the renderer closes those voices.

const keyOf = (msg) => (
  msg.port === 'ump-midi2' && Number.isInteger(msg.noteId)
    ? `id:${msg.group}:${msg.noteId}`
    : `ch:${msg.port}:${msg.group}:${msg.channel}:${msg.note}`
);

export function createAudioEngine() {
  let ctx = null;
  let master = null;
  const voices = new Map();
  let muted = false;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext ?? window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.18;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function frequency(note) {
    return 440 * 2 ** ((note - 69) / 12);
  }

  function noteOn(msg, levelUnit, whenOffset = 0.02) {
    if (muted) return;
    const c = ensure();
    if (!c) return;
    const key = keyOf(msg);
    if (voices.has(key)) noteOff(msg, 0);
    const now = c.currentTime + whenOffset;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'triangle';
    osc.frequency.value = frequency(msg.note);
    const peak = Math.max(0.0005, Math.min(1, levelUnit)) * 0.9;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.012);
    osc.connect(gain).connect(master);
    osc.start(now);
    voices.set(key, { osc, gain, startedAt: now, note: msg.note, noteId: msg.noteId, channel: msg.channel, basePeak: peak });
  }

  // Applies a bend given its signed normalised offset (-1 .. +1 around centre).
  // A noteId targets a single identity voice (wide per-note bend); otherwise
  // every voice on the channel bends, so a migrated per-note bend on an
  // identity-less endpoint is heard exactly where the renderer placed it.
  function pitchBend(msg, offsetUnit, semitoneRange = 2) {
    const c = ctx;
    if (!c) return;
    const cents = offsetUnit * semitoneRange * 100;
    for (const v of voices.values()) {
      if (v.channel !== msg.channel) continue;
      if (Number.isInteger(msg.noteId) && v.noteId !== msg.noteId) continue;
      try { v.osc.detune.setTargetAtTime(cents, c.currentTime, 0.01); } catch { /* stopped */ }
    }
  }

  // Polyphonic pressure reshapes the loudness of the addressed (channel, note),
  // given a normalised 0..1 pressure level.
  function polyPressure(msg, levelUnit) {
    const c = ctx;
    if (!c) return;
    const level = Math.max(0, Math.min(1, levelUnit));
    for (const v of voices.values()) {
      if (v.channel !== msg.channel || v.note !== msg.note) continue;
      try { v.gain.setTargetAtTime(Math.max(0.0005, v.basePeak * (0.35 + 0.65 * level)), c.currentTime, 0.02); } catch { /* stopped */ }
    }
  }

  function noteOff(msg, whenOffset = 0.02) {
    const c = ctx;
    if (!c) return;
    const key = keyOf(msg);
    const v = voices.get(key);
    if (!v) return;
    voices.delete(key);
    const now = c.currentTime + whenOffset;
    try {
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(Math.max(0.0001, v.gain.gain.value), now);
      v.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
      v.osc.stop(now + 0.11);
    } catch { /* already stopped */ }
  }

  function stopKey(key, whenOffset = 0.02) {
    const c = ctx;
    if (!c) return;
    const v = voices.get(key);
    if (!v) return;
    voices.delete(key);
    const now = c.currentTime + whenOffset;
    try {
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(Math.max(0.0001, v.gain.gain.value), now);
      v.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
      v.osc.stop(now + 0.09);
    } catch { /* already stopped */ }
  }

  function closePort(port) {
    for (const [key, v] of [...voices.entries()]) {
      if (key.startsWith('ch:') && key.split(':')[1] === port) stopKey(key);
      else if (port === 'ump-midi2' && key.startsWith('id:')) stopKey(key);
    }
  }

  function allOff() {
    for (const key of [...voices.keys()]) stopKey(key);
  }

  return {
    noteOn,
    noteOff,
    pitchBend,
    polyPressure,
    closePort,
    allOff,
    setMuted(v) { muted = v; if (v) allOff(); },
    get muted() { return muted; },
    get ready() { return ctx != null; },
  };
}
