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
 * A socket.io client socket, as the platform behaves.
 *
 * Answers through the shared `Responder`, so the connection this package opens
 * is driven by the same script as the two adapters. `'timeout'` means the ack
 * never comes (pass a small `timeoutMs` rather than waiting 30 seconds).
 */
export class FakeIoSocket {
  connected = false;
  /** Every `{ns, payload}` as it went on the wire — envelope included. */
  wire = [];
  /** @type {Map<string, Set<Function>>} */
  listeners = new Map();
  connects = 0;
  closed = false;

  constructor(responder, { url = '', options = {} } = {}) {
    this.responder = responder;
    this.url = url;
    this.options = options;
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return this;
  }

  off(event, handler) { this.listeners.get(event)?.delete(handler); return this; }

  removeAllListeners() { this.listeners.clear(); return this; }

  connect() { this.connects++; this.connected = true; return this; }

  close() { this.connected = false; this.closed = true; return this; }

  disconnect() { return this.close(); }

  emit(ns, payload, ack) {
    this.wire.push({ ns, payload });
    const answer = this.responder.answer(ns, payload?.data, undefined);
    // The scripted failures, in the shape the TRANSPORT reports them — a bare
    // error with no code, which is what `normalizeAck` exists to complete. Fast
    // on purpose: the shared suite emits with the policy's 30s timeout, so a
    // fake that really went quiet would make it wait that long.
    if (answer === 'timeout') {
      ack?.({ error: { status: true, message: `emit ${ns} timed out` } });
      return this;
    }
    if (answer === 'disconnect') {
      ack?.({ error: { status: true, message: 'socket not ready' } });
      return this;
    }
    // The ack that never comes — for a test driving the adapter's OWN timer,
    // which is the one thing the two above deliberately skip past.
    if (answer === 'no-ack') return this;
    if (answer === 'throw') throw new Error('socket is half torn down');
    ack?.(answer);
    return this;
  }

  /** Deliver a platform push. */
  push(event, payload) {
    for (const handler of [...(this.listeners.get(event) ?? [])]) handler(payload);
    return this;
  }

  /** The handshake's end: `user_info`, in the wrapped shape the platform sends. */
  ready({ userId = 'user-1', networkId = 'roomful', name = 'Ada Lovelace' } = {}) {
    return this.push('user_info', {
      data: { user: { id: userId, name }, network: { id: networkId, fullName: 'Roomful' } },
    });
  }

  /** The transport dropped; socket.io is retrying underneath. */
  drop(reason = 'transport close') {
    this.connected = false;
    return this.push('disconnect', reason);
  }

  /** It came back. The platform re-announces the user afterwards. */
  reopen() {
    this.connected = true;
    return this.push('connect');
  }
}

/**
 * An `io` factory over {@link FakeIoSocket}, recording what it was asked for.
 *
 * `onSocket` runs as soon as the socket exists — before `connect()` — which is
 * how a test can make `user_info` arrive on the same tick as the handshake.
 */
export function fakeIo(responder, { onSocket } = {}) {
  const factory = (url, options) => {
    const socket = new FakeIoSocket(responder, { url, options });
    factory.calls.push({ url, options });
    factory.sockets.push(socket);
    factory.last = socket;
    onSocket?.(socket);
    return socket;
  };
  factory.calls = [];
  factory.sockets = [];
  factory.last = null;
  return factory;
}

/**
 * An `io` whose socket answers the handshake: `user_info` lands as soon as the
 * caller connects. The common case, and what a connected platform looks like.
 */
export function readyIo(responder, userInfo = {}) {
  return fakeIo(responder, {
    onSocket: (socket) => {
      const connect = socket.connect.bind(socket);
      socket.connect = () => { connect(); socket.ready(userInfo); return socket; };
    },
  });
}

/** A `fetch` that answers the `init.client` bootstrap. */
export function fakeBootstrapFetch({ status = 200, data = {} } = {}) {
  const impl = async (url, options) => {
    impl.calls.push({ url, options });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ data }),
      text: async () => '',
    };
  };
  impl.calls = [];
  return impl;
}

/**
 * A window that carries postMessage traffic between an app and the Valu Social
 * application embedding it.
 *
 * `posted` is every `{name, message}` the SDK put on the wire — the wire
 * parity tests assert on it directly.
 */
export class FakeWindow {
  listeners = new Set();
  posted = [];

  addEventListener(type, listener) { if (type === 'message') this.listeners.add(listener); }
  removeEventListener(type, listener) { if (type === 'message') this.listeners.delete(listener); }

  /** The application's side: a source whose postMessage records what it got. */
  appSource() {
    return { postMessage: (data, origin) => this.posted.push({ ...data, origin }) };
  }

  /** Deliver a message as if it came from the Valu Social application. */
  deliver({ name, message, requestId, target = 'valuApi', source = this.appSource(), origin = 'https://valu.test' }) {
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

// ---------------------------------------------------------------------------
// Phase 2 fakes: application state, and the bucket.
// ---------------------------------------------------------------------------

/** Application state, as a runtime that holds it would supply it. */
export class FakeAppState {
  constructor(state = {}) { Object.assign(this, state); }
}

/**
 * A bucket that accepts a PUT and records it. The upload pipeline's only
 * non-socket step, faked so no test opens a connection.
 */
export function fakeFetch({ status = 200 } = {}) {
  const puts = [];
  const impl = async (url, options) => {
    puts.push({ url, method: options?.method, headers: options?.headers, body: options?.body });
    return { status, ok: status >= 200 && status < 300, text: async () => '' };
  };
  impl.puts = puts;
  return impl;
}
