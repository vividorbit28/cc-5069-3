// Loop guard for a bidirectional bridge.
//
// Two bridges wired back to back must not re-emit the same musical event
// forever: an event converted A -> B and handed back as B -> A is an echo of
// something this bridge already sent. Every output is stamped with a stable
// echo key derived from its musical content and instance identity, and the
// guard remembers a bounded window of recently emitted keys. An inbound event
// whose key matches is recognised as a returning echo and dropped *once* —
// genuinely new presses, releases and controls (different instance, value or
// channel) still pass.
//
// Note releases carry the same instance identity as their Note On, so a
// converted release always settles the exact voice the converted press opened:
// channel re-allocation changes the wire channel inside the key payload, but
// the bridge-internal instance id does not, which is what the guard matches.

export const ECHO_MARK = Symbol.for('high-precision-bridge.echo');

export function createLoopGuard({ bridgeId, window = 256 } = {}) {
  if (!bridgeId) throw new Error('createLoopGuard: a bridgeId is required');
  const emitted = new Map(); // echoKey -> seq
  const observedEchoes = new Set(); // keys currently mid round-trip, consumed once
  let seq = 0;

  function keyFor(kind, payload) {
    return `${bridgeId}|${kind}|${canonical(payload)}`;
  }

  function canonical(payload) {
    if (payload == null) return '';
    if (typeof payload !== 'object') return String(payload);
    return `{${Object.keys(payload).sort().map((k) => `${k}=${canonical(payload[k])}`).join(',')}}`;
  }

  // Stamps an output the bridge is about to emit.
  function stamp(output, kind, payload) {
    const echoKey = keyFor(kind, payload);
    const token = { bridgeId, echoKey, seq: ++seq, kind };
    Object.defineProperty(output, ECHO_MARK, { value: token, enumerable: false, configurable: true, writable: false });
    emitted.set(echoKey, token.seq);
    if (emitted.size > window) {
      const oldest = emitted.keys().next().value;
      emitted.delete(oldest);
    }
    return token;
  }

  // True when an inbound event is an echo of something this bridge emitted.
  // An explicit token carrying this bridge's id is authoritative; otherwise a
  // content-derived key still catches a round trip whose token was stripped.
  function isEcho(kind, payload, remoteMark = null) {
    if (remoteMark && remoteMark.bridgeId === bridgeId && emitted.has(remoteMark.echoKey)) {
      observedEchoes.add(remoteMark.echoKey);
      return true;
    }
    const echoKey = keyFor(kind, payload);
    if (emitted.has(echoKey)) {
      observedEchoes.add(echoKey);
      return true;
    }
    return false;
  }

  // Consumes a one-shot echo acknowledgement so a later, genuinely new event
  // with identical content is not mistaken for the returning echo.
  function consumeEcho(echoKey) {
    observedEchoes.delete(echoKey);
  }

  function stats() {
    return { bridgeId, emittedKeys: emitted.size, pendingEchoes: observedEchoes.size, totalStamped: seq };
  }

  return { stamp, isEcho, consumeEcho, stats, get bridgeId() { return bridgeId; } };
}
