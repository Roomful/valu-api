// ===========================================================================
// Fakes for the two worlds the SDK runs in.
//
// `Responder` is shared: both fakes answer through it, so the conformance
// suite drives a browser socket and a headless connection with one script and
// any difference it sees is a real difference between the adapters.
// ===========================================================================

/**
 * Scripted answers, keyed by RPC namespace.
 * A handler returns an ack, or the string 'timeout' / 'disconnect' to make the
 * underlying transport fail the way that transport fails.
 */
export class Responder {
  constructor(handlers = {}) {
    this.handlers = new Map(Object.entries(handlers));
    this.calls = [];
  }

  on(ns, handler) { this.handlers.set(ns, handler); return this; }

  answer(ns, data, timeoutMs) {
    this.calls.push({ ns, data, timeoutMs });
    const handler = this.handlers.get(ns);
    if (!handler) return { error: { status: true, code: 404, message: `no fake for ${ns}` } };
    return typeof handler === 'function' ? handler(data, this.calls.length) : handler;
  }

  callsTo(ns) { return this.calls.filter((c) => c.ns === ns); }
}

/** The app's WebSocket service: emitAsync, which REJECTS on timeout/disconnect. */
export class FakeWebSocketService {
  constructor(responder) { this.responder = responder; }

  async emitAsync(endpoint, data = {}, timeout = 30_000) {
    const answer = this.responder.answer(endpoint, data, timeout);
    if (answer === 'timeout') throw new Error('Timeout');
    if (answer === 'disconnect') throw new Error(`Socket not connected, "${endpoint}" dropped`);
    return answer;
  }
}

/** RoomfulConnectionManager: emit, which RESOLVES an error ack instead. */
export class FakeRoomfulConnection {
  #handlers = new Set();

  constructor(responder, { userId = 'user-1', selfUserId = 'user-1', networkId = 'roomful' } = {}) {
    this.responder = responder;
    this.userId = userId;
    this.selfUserId = selfUserId;
    this.networkId = networkId;
  }

  async emit(ns, data = {}, timeoutMs = 30_000) {
    const answer = this.responder.answer(ns, data, timeoutMs);
    if (answer === 'timeout') return { error: { status: true, message: `emit ${ns} timed out` } };
    if (answer === 'disconnect') return { error: { status: true, message: 'socket not ready' } };
    return answer;
  }

  onResourceUpdated(handler) {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /** Push, as the platform would. */
  pushResourceUpdated(payload) {
    for (const handler of this.#handlers) handler(payload);
  }
}

/**
 * A window that carries postMessage traffic between an app and a host.
 *
 * `posted` is every `{name, message}` the SDK put on the wire — the wire
 * parity tests assert on it directly.
 */
export class FakeWindow {
  listeners = new Set();
  posted = [];

  addEventListener(type, listener) { if (type === 'message') this.listeners.add(listener); }
  removeEventListener(type, listener) { if (type === 'message') this.listeners.delete(listener); }

  /** The host's side: a source object whose postMessage records what it got. */
  hostSource() {
    return { postMessage: (data, origin) => this.posted.push({ ...data, origin }) };
  }

  /** Deliver a message as if it came from the host. */
  deliver({ name, message, requestId, target = 'valuApi', source = this.hostSource(), origin = 'https://valu.test' }) {
    const event = { data: { target, name, message, requestId }, source, origin };
    for (const listener of [...this.listeners]) listener(event);
  }

  /** Complete the handshake, so posting is allowed. */
  ready({ applicationId = 'app-1', action = 'open', params = {} } = {}) {
    this.deliver({ name: 'api:ready', message: { applicationId, action, params } });
  }

  lastPost() { return this.posted[this.posted.length - 1]; }
}

/** Deterministic clock, for TTL and backoff. */
export class FakeClock {
  constructor(start = 1_000_000) { this.time = start; this.slept = []; }
  now = () => this.time;
  advance(ms) { this.time += ms; return this.time; }
  /** A `sleep` that records instead of waiting. */
  sleep = async (ms) => { this.slept.push(ms); this.time += ms; };
}
