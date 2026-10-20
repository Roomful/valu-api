// ===========================================================================
// The host's own WebSocket to Valu Guru.
//
// The host iframe runs `valuguru.*` data ops (Commerce, grants) over a socket
// of its own, opened with the connect path of `AiGuruService.js` and nothing
// else from it (spec §4.2):
//
//   mint   caller's `mintToken()` -> a one-time token (single use)
//   open   wss://valuguru.texpo.io/?token=<token>&client=host
//   send   {type:'data_request', requestId, op, params, networkId}
//          {type:'data_cancel', requestId}                 — and nothing else
//   read   {type:'data_response', requestId, ok, data | error:{code,message,details}}
//          {type:'data_progress', requestId, step}
//          {type:'commerce_event', ...}                    — and nothing else
//
// The server mirrors every other frame of the user's session (`tool_call`,
// `session_event`, chat and agent run frames) to every connection the user
// has. Those are not ours: they are dropped on receipt and never answered. The
// server pings at the protocol level, so there is no heartbeat here.
//
// What this class adds on top of the wire (spec §4.11):
//
//   - FRESH TOKEN PER ATTEMPT. A token works once, so every connect attempt —
//     the first, a retry after a failed handshake, a reconnect after a drop —
//     calls `mintToken()` again.
//   - NEVER GIVE UP. A drop, a failed handshake and a token that could not be
//     minted are all retried: 1 s, 2 s, 4 s … capped at 30 s, each ±20 %
//     (`backoffDelayMs`), for as long as the page lives. Nothing here rejects
//     because the network is down; `state` says so instead.
//   - OFFLINE PAUSE. While `onlineSource.onLine === false` it does not mint or
//     open anything, and it resumes on the `online` event. The listener exists
//     only while paused.
//   - HOLD. A request made while not connected waits, and goes out when the
//     socket opens; the wait comes out of the request's own `timeoutMs`, so a
//     call never outlasts the budget it was given.
//   - DROP. A request that was on the wire when the socket went away answers
//     `disconnected`: the server may have applied it, so whether to repeat it is
//     the caller's call. One that had not been sent stays held.
//
// Everything the platform provides is injectable — the socket constructor, the
// online flag and its event source, the ids — and nothing touches the DOM at
// import time. No error or detail built here carries the socket URL, which
// holds the token.
// ===========================================================================
import { HOST_ERRORS } from './protocol.js';

/** Where Valu Guru lives. */
export const DEFAULT_GURU_URL = 'wss://valuguru.texpo.io/';

/** How long a request may go unanswered — waiting for the socket included — before it times out. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** The reconnect delay: `initialMs`, doubling, capped at `maxMs`. */
export const DEFAULT_BACKOFF = Object.freeze({ initialMs: 1000, maxMs: 30_000 });

/** The code a request rejects with when its `signal` aborts. */
export const ABORTED = 'aborted';

/** The code of a server error that arrived without one. */
const UNKNOWN_ERROR = 'unknown';

/** `WebSocket.OPEN`, which the standard fixes. */
const WS_OPEN = 1;

/** The close code of a client that closes on purpose. */
const NORMAL_CLOSURE = 1000;

/** Every frame type on the wire, in either direction. */
const FRAME = Object.freeze({
  REQUEST: 'data_request',
  CANCEL: 'data_cancel',
  RESPONSE: 'data_response',
  PROGRESS: 'data_progress',
  COMMERCE_EVENT: 'commerce_event',
});

/**
 * @typedef {'idle'|'connecting'|'ready'|'reconnecting'|'offline'|'closed'} GuruState
 *
 * `idle` before the first `connect()` or request; `connecting` during the
 * first attempt; `ready` while the socket is open; `reconnecting` after a drop
 * or a failed attempt, until the next socket opens; `offline` while that
 * reconnect is paused for want of a network; `closed` after `close()`, for good.
 */

/**
 * What a request rejects with, whatever the cause: the server answered
 * `ok:false` (its `code`, `message` and `details`, as sent), or the client
 * gave up — `'timeout'`, `'aborted'`, `'disconnected'`.
 *
 * A timeout's `details.sent` says whether the request ever reached the wire:
 * `false` means the server never saw it, `true` means it may have been applied.
 */
export class GuruError extends Error {
  /** @type {string} */
  code;

  /** @type {any} */
  details;

  /**
   * @param {string} code
   * @param {string} [message] Defaults to the code.
   * @param {any} [details]
   */
  constructor(code, message = code, details = undefined) {
    super(message);
    this.name = 'GuruError';
    this.code = code;
    this.details = details;
  }
}

/**
 * How long to wait before reconnect attempt number `attempt` (0 for the
 * first retry): `min(maxMs, initialMs * 2^attempt) * (0.8 + 0.4 * random)`.
 * @param {number} attempt Consecutive failures so far.
 * @param {{initialMs: number, maxMs: number}} backoff
 * @param {() => number} [random] In [0, 1); `Math.random`.
 */
export function backoffDelayMs(attempt, { initialMs, maxMs }, random = Math.random) {
  return Math.min(maxMs, initialMs * 2 ** attempt) * (0.8 + 0.4 * random());
}

const closedError = () => new GuruError(HOST_ERRORS.DISCONNECTED, 'the Valu Guru client is closed');

/**
 * @typedef {object} Pending One request, from the call to its answer.
 * @property {string} requestId
 * @property {string} op
 * @property {object} params
 * @property {number} timeoutMs
 * @property {(value: any) => void} resolve
 * @property {(error: Error) => void} reject
 * @property {any} timer The timeout, which a `data_progress` re-arms.
 * @property {boolean} sent Whether it went out on a socket.
 * @property {AbortSignal|undefined} signal
 * @property {(() => void)|null} onAbort
 */

export class GuruClient {
  #url;
  #mintToken;
  #getNetworkId;
  #WebSocket;
  #onlineSource;
  #listen;
  #backoff;
  #randomId;

  /** @type {GuruState} */
  #state = 'idle';
  /** The live socket, from the moment it is made until it closes; `null` between. */
  #socket = null;
  /** Whether an attempt was ever made: the first is `connecting`, every later one `reconnecting`. */
  #started = false;
  /** Consecutive failed attempts: the backoff exponent. A socket that opens starts it over. */
  #failures = 0;
  #retryTimer = null;
  /** Aborts the `online` listener. It exists exactly while the state is `offline`. */
  #onlineAbort = null;
  /** @type {{promise: Promise<void>, resolve: () => void}|null} What `connect()` waits on. */
  #gate = null;
  /** @type {Map<string, Pending>} */
  #pending = new Map();

  #stateHandlers = new Set();
  #commerceHandlers = new Set();

  /**
   * @param {object} options
   * @param {() => Promise<string>} options.mintToken A fresh one-time token
   *   (`POST …/auth/getOneTimeAuthToken`); called once per connect attempt.
   * @param {() => (string|null|undefined)} options.getNetworkId The network the
   *   host runs in; read when each request goes out.
   * @param {string} [options.url]
   * @param {typeof WebSocket} [options.WebSocketImpl]
   * @param {{onLine?: boolean}} [options.onlineSource] `navigator`: only a strict
   *   `onLine === false` pauses.
   * @param {(type: string, listener: Function, options?: object) => void} [options.addEventListener]
   *   Where `online` is heard, as `window.addEventListener`; called bare (not as
   *   a method), with an `AbortSignal` that removes the listener, so no removal
   *   function is needed.
   * @param {{initialMs?: number, maxMs?: number}} [options.backoff]
   * @param {() => string} [options.randomId] A request id; `crypto.randomUUID()`.
   */
  constructor({
    url = DEFAULT_GURU_URL,
    mintToken,
    getNetworkId,
    WebSocketImpl = globalThis.WebSocket,
    onlineSource = globalThis.navigator,
    addEventListener = globalThis.addEventListener,
    backoff = DEFAULT_BACKOFF,
    randomId = () => crypto.randomUUID(),
  } = {}) {
    if (typeof mintToken !== 'function') throw new TypeError('GuruClient needs a mintToken function.');
    if (typeof getNetworkId !== 'function') throw new TypeError('GuruClient needs a getNetworkId function.');
    if (typeof WebSocketImpl !== 'function') throw new TypeError('GuruClient needs a WebSocket implementation.');
    this.#url = url;
    this.#mintToken = mintToken;
    this.#getNetworkId = getNetworkId;
    this.#WebSocket = WebSocketImpl;
    this.#onlineSource = onlineSource;
    this.#listen = addEventListener;
    this.#backoff = { ...DEFAULT_BACKOFF, ...backoff };
    this.#randomId = randomId;
  }

  // --- what the host reads -------------------------------------------------

  /** @returns {GuruState} */
  get state() { return this.#state; }

  /**
   * @param {(state: GuruState, previous: GuruState) => void} handler
   * @returns {() => void} unsubscribe
   */
  onStateChange(handler) {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  /**
   * Every `commerce_event` frame, exactly as the server sent it. The server
   * sends them to every connection of the user, so there is nothing to
   * register server side and nothing to redo after a reconnect.
   * @param {(frame: object) => void} handler
   * @returns {() => void} unsubscribe
   */
  onCommerceEvent(handler) {
    this.#commerceHandlers.add(handler);
    return () => this.#commerceHandlers.delete(handler);
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Open the connection. Resolves once the socket is open, however many
   * attempts that takes: a failure is retried, never thrown. Idempotent —
   * concurrent callers share the attempt in progress, and a client that is
   * already `ready` resolves at once. Rejects only because the client was
   * closed.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.#state === 'closed') throw closedError();
    if (this.#state === 'ready') return;
    const settled = this.#whenSettled();
    if (this.#state === 'idle') this.#begin();
    await settled;
    if (this.#state === 'closed') throw closedError();
  }

  /**
   * Run one `valuguru.*` op.
   *
   * Opens the connection if nothing has yet. While the socket is not open the
   * request waits, and is sent when it opens; the wait counts against
   * `timeoutMs`. The silence timer restarts on every `data_progress`. A request
   * that times out is not cancelled on the wire; only an abort sends `data_cancel`.
   *
   * Rejects with a {@link GuruError}: the server's own (`ok:false`),
   * `'timeout'`, `'aborted'` (after sending a `data_cancel`, if it was on the
   * wire), or `'disconnected'` when the socket dropped under it or the client
   * was closed. A request that cannot even be built (a bad op, circular
   * params, a `timeoutMs` that is not a positive number) rejects with the
   * `TypeError` or `RangeError` instead.
   * @param {string} op
   * @param {object} [params]
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<any>} The response's `data`.
   */
  request(op, params = {}, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (typeof op !== 'string' || !op) return reject(new TypeError('request needs an op name.'));
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return reject(new RangeError('request needs a positive timeoutMs.'));
      }
      if (this.#state === 'closed') return reject(closedError());
      if (signal?.aborted) return reject(new GuruError(ABORTED, `${op} was aborted`));

      /** @type {Pending} */
      const entry = {
        requestId: this.#randomId(), op, params, timeoutMs, resolve, reject, timer: null, sent: false, signal, onAbort: null,
      };
      this.#pending.set(entry.requestId, entry);
      this.#armTimeout(entry);
      if (signal) {
        entry.onAbort = () => this.#abort(entry);
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }

      if (this.#state === 'idle') this.#begin();
      else if (this.#state === 'ready') this.#transmit(entry);
    });
  }

  /**
   * Close the socket, answer every pending request `disconnected`, stop
   * reconnecting and let go of every subscriber. For good: the client is not
   * reopened (a new session gets a new client). Idempotent; never throws.
   */
  close() {
    if (this.#state === 'closed') return;
    const socket = this.#socket;
    this.#socket = null;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#onlineAbort?.abort();
    this.#onlineAbort = null;
    this.#setState('closed');
    for (const entry of [...this.#pending.values()]) {
      if (this.#finish(entry)) entry.reject(closedError());
    }
    this.#openGate();
    this.#stateHandlers.clear();
    this.#commerceHandlers.clear();
    try { socket?.close(NORMAL_CLOSURE, 'closed'); } catch { /* a socket that is gone is closed enough */ }
  }

  // --- connecting ----------------------------------------------------------

  /** The first attempt, from `idle`. */
  #begin() {
    if (this.#paused()) this.#goOffline();
    else void this.#attempt();
  }

  /**
   * One connect attempt: a fresh token, then a socket. It never rejects — a
   * failure ends in `#scheduleRetry` — and it is the only attempt in flight:
   * the next one is scheduled by this one's end.
   */
  async #attempt() {
    this.#setState(this.#started ? 'reconnecting' : 'connecting');
    this.#started = true;
    if (this.#state === 'closed') return;
    let socket;
    try {
      const token = await this.#mintToken();
      if (this.#state === 'closed') return;
      if (typeof token !== 'string' || !token) throw new TypeError('mintToken resolved without a token.');
      socket = new this.#WebSocket(`${this.#url}?token=${encodeURIComponent(token)}&client=host`);
    } catch {
      // The state, which stays `reconnecting`, is how a caller sees it.
      if (this.#state !== 'closed') this.#scheduleRetry();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => this.#onOpen(socket);
    socket.onmessage = (event) => this.#onMessage(socket, event?.data);
    socket.onclose = (event) => this.#onClose(socket, event);
  }

  /** Wait out the backoff, then try again — or wait for the network, if there is none. */
  #scheduleRetry() {
    if (this.#state === 'closed') return;
    if (this.#paused()) {
      this.#goOffline();
      return;
    }
    const delay = backoffDelayMs(this.#failures, this.#backoff);
    this.#failures += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.#paused()) this.#goOffline();
      else void this.#attempt();
    }, delay);
    this.#setState('reconnecting');
  }

  /** Whether the network is known to be down, and we would hear it come back. */
  #paused() {
    return typeof this.#listen === 'function' && this.#onlineSource?.onLine === false;
  }

  #goOffline() {
    if (!this.#onlineAbort) {
      const controller = new AbortController();
      this.#onlineAbort = controller;
      const listen = this.#listen;                          // called bare, as `window.addEventListener` is
      listen('online', () => this.#onOnline(controller), { once: true, signal: controller.signal });
    }
    this.#setState('offline');
  }

  #onOnline(controller) {
    if (this.#onlineAbort !== controller) return;
    controller.abort();
    this.#onlineAbort = null;
    if (this.#state === 'offline') void this.#attempt();
  }

  // --- the socket ----------------------------------------------------------

  #onOpen(socket) {
    if (this.#socket !== socket) return;
    this.#failures = 0;
    this.#setState('ready');
    if (this.#state !== 'ready') return;                    // a subscriber closed it
    this.#openGate();
    for (const entry of [...this.#pending.values()]) {
      if (!entry.sent) this.#transmit(entry);
    }
  }

  #onClose(socket, event) {
    if (this.#socket !== socket) return;
    this.#socket = null;
    for (const entry of [...this.#pending.values()]) {
      if (!entry.sent || !this.#finish(entry)) continue;
      entry.reject(new GuruError(
        HOST_ERRORS.DISCONNECTED,
        `the connection to Valu Guru dropped during ${entry.op}`,
        { closeCode: event?.code },
      ));
    }
    this.#scheduleRetry();
  }

  /** Read one frame. Only three kinds are ours; the rest are the server mirroring the user's session. */
  #onMessage(socket, data) {
    if (this.#socket !== socket || typeof data !== 'string') return;
    let frame;
    try { frame = JSON.parse(data); } catch { return; }
    switch (frame?.type) {
      case FRAME.RESPONSE: {
        const entry = this.#pending.get(frame.requestId);
        if (!entry?.sent || !this.#finish(entry)) return;
        if (frame.ok === true) entry.resolve(frame.data);
        else {
          const error = frame.error && typeof frame.error === 'object' ? frame.error : {};
          entry.reject(new GuruError(error.code ?? UNKNOWN_ERROR, error.message, error.details));
        }
        return;
      }
      case FRAME.PROGRESS: {
        const entry = this.#pending.get(frame.requestId);
        if (entry?.sent) this.#armTimeout(entry);
        return;
      }
      case FRAME.COMMERCE_EVENT:
        for (const handler of [...this.#commerceHandlers]) {
          try { handler(frame); } catch (error) { console.error('commerce_event handler threw:', error); }
        }
        return;
      default:
        break;                                              // mirrored session traffic: not ours
    }
  }

  // --- requests ------------------------------------------------------------

  /** Put a request on the socket. A request that cannot be built is rejected alone. */
  #transmit(entry) {
    try {
      const frame = {
        type: FRAME.REQUEST, requestId: entry.requestId, op: entry.op, params: entry.params, networkId: this.#getNetworkId(),
      };
      this.#socket.send(JSON.stringify(frame));
    } catch (error) {
      if (this.#finish(entry)) entry.reject(error);
      return;
    }
    entry.sent = true;
  }

  #armTimeout(entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (!this.#finish(entry)) return;
      entry.reject(new GuruError(
        HOST_ERRORS.TIMEOUT,
        `${entry.op} timed out after ${entry.timeoutMs} ms${entry.sent ? '' : ' waiting for the connection'}`,
        { sent: entry.sent },
      ));
    }, entry.timeoutMs);
  }

  #abort(entry) {
    if (!this.#finish(entry)) return;
    if (entry.sent && this.#socket?.readyState === WS_OPEN) {
      this.#socket.send(JSON.stringify({ type: FRAME.CANCEL, requestId: entry.requestId }));
    }
    entry.reject(new GuruError(ABORTED, `${entry.op} was aborted`));
  }

  /**
   * End a request's bookkeeping: its timer, its abort listener and its place
   * in the map. `false` when it had already ended, so whoever settles it
   * second does nothing.
   * @param {Pending} entry
   */
  #finish(entry) {
    if (this.#pending.get(entry.requestId) !== entry) return false;
    this.#pending.delete(entry.requestId);
    clearTimeout(entry.timer);
    if (entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    return true;
  }

  // --- state ---------------------------------------------------------------

  #setState(next) {
    const previous = this.#state;
    if (previous === next) return;
    this.#state = next;
    for (const handler of [...this.#stateHandlers]) {
      try { handler(next, previous); } catch (error) { console.error('state handler threw:', error); }
    }
  }

  /** What a `connect()` waits on: resolves when the client is `ready` or `closed`. */
  #whenSettled() {
    if (!this.#gate) {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      this.#gate = { promise, resolve };
    }
    return this.#gate.promise;
  }

  /** Let every `connect()` waiter go: the client is ready, or closed. */
  #openGate() {
    const gate = this.#gate;
    this.#gate = null;
    gate?.resolve();
  }
}
