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
//   - BOUNDED ATTEMPTS. An attempt — mint plus handshake — that takes longer
//     than `connectTimeoutMs` is abandoned and counts as a failure, so a mint
//     that never settles or a socket stuck in CONNECTING cannot wedge the
//     client. Each attempt has an epoch: whatever a superseded attempt
//     produces late (a token, a socket, an error) is dropped.
//   - STABLE BEFORE FORGIVEN. The backoff starts over only once a connection
//     has stayed open for `stableMs` or has delivered a frame. A server that
//     accepts and closes at once is therefore backed off, not hammered.
//   - OFFLINE PAUSE. While `onlineSource.onLine === false` it does not mint or
//     open anything. The `online` event — heard from the moment a client is
//     not `ready` until it is — ends any wait at once: the backoff, the pause,
//     or an attempt that started on the old network.
//   - HOLD. A request made while not connected waits, and goes out when the
//     socket opens. The wait has its own `timeoutMs` bound; the silence timer
//     starts when the request is sent, with the full `timeoutMs` again.
//   - DROP. A request that was on the wire when the socket went away answers
//     `disconnected`: the server may have applied it, so whether to repeat it is
//     the caller's call. One that had not been sent stays held.
//   - SESSION ERRORS. A `mintToken()` that rejects with a `sign_in_required` or
//     `session_expired` code means no token can be had until the user signs
//     in: held requests (and new ones) answer with that code at once instead of
//     timing out. The retries go on, so a renewed session recovers.
//
// Everything the platform provides is injectable — the socket constructor, the
// online flag and its event source, the ids — and nothing touches the DOM at
// import time. No error, detail or `lastError` built here carries the socket
// URL, which holds the token.
// ===========================================================================
import { HOST_ERRORS } from './protocol.js';

/** Where Valu Guru lives. */
export const DEFAULT_GURU_URL = 'wss://valuguru.texpo.io/';

/** How long a request may go unanswered — and, separately, may wait for the socket — before it times out. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** The reconnect delay: `initialMs`, doubling, capped at `maxMs`. */
export const DEFAULT_BACKOFF = Object.freeze({ initialMs: 1000, maxMs: 30_000 });

/** How long one connect attempt (token and handshake) may take. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/** How long a connection must stay open before the backoff forgets the failures before it. */
export const DEFAULT_STABLE_MS = 10_000;

/** The code a request rejects with when its `signal` aborts. */
export const ABORTED = 'aborted';

/** The code of a server error that arrived without one. */
const UNKNOWN_ERROR = 'unknown';

/** `lastError.code` when `mintToken()` rejected with no code of its own. */
const MINT_FAILED = 'mint_failed';

/** `lastError.code` when the socket could not even be constructed. */
const CONNECT_FAILED = 'connect_failed';

/** A `mintToken()` rejection with one of these codes means the user has to sign in again. */
const SESSION_ERRORS = new Set([HOST_ERRORS.SIGN_IN_REQUIRED, HOST_ERRORS.SESSION_EXPIRED]);

/** The longest a timer can be: `setTimeout` fires a longer one at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

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
 * @typedef {object} GuruFailure Why the last attempt or connection failed. Fixed
 *   text and a code, never the underlying error's message and never the token.
 * @property {string} code `'mint_failed'`, `'connect_failed'`, `'timeout'`
 *   (the attempt took too long), `'disconnected'` (the socket closed), or the
 *   `code` a rejected `mintToken()` carried (`'sign_in_required'`, …).
 * @property {string} message
 */

/**
 * What a request rejects with, whatever the cause: the server answered
 * `ok:false` (its `code`, `message` and `details`, as sent), or the client
 * gave up — `'timeout'`, `'aborted'`, `'disconnected'`, or the code of a
 * session error (`'sign_in_required'`, `'session_expired'`).
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

/** A usable timer length: a positive number, clamped to what `setTimeout` can hold; `fallback` otherwise. */
const timerMs = (value, fallback) => (typeof value === 'number' && value > 0 ? Math.min(value, MAX_TIMER_MS) : fallback);

const closedError = () => new GuruError(HOST_ERRORS.DISCONNECTED, 'the Valu Guru client is closed');

/**
 * @typedef {object} Pending One request, from the call to its answer.
 * @property {string} requestId
 * @property {string} op
 * @property {object} params
 * @property {number} timeoutMs
 * @property {(value: any) => void} resolve
 * @property {(error: Error) => void} reject
 * @property {any} timer While held, the bound on the wait for the socket; once
 *   sent, the silence timer, which a `data_progress` re-arms.
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
  #connectTimeoutMs;
  #stableMs;
  #randomId;

  /** @type {GuruState} */
  #state = 'idle';
  /** The live socket, from the moment it is made until it closes; `null` between. */
  #socket = null;
  /** Whether an attempt was ever made: the first is `connecting`, every later one `reconnecting`. */
  #started = false;
  /**
   * Which attempt is current. Every attempt takes the next number, and so does
   * abandoning one, closing, and the watchdog: an attempt whose number is no
   * longer current is superseded and must do nothing.
   */
  #epoch = 0;
  /** Consecutive failed attempts: the backoff exponent. Only a stable connection starts it over. */
  #failures = 0;
  #retryTimer = null;
  /** Bounds the attempt in flight, mint and handshake together. */
  #attemptTimer = null;
  /** Fires when the open connection has lasted long enough to forgive the failures before it. */
  #stableTimer = null;
  /** Aborts the `online` listener. It exists from the moment the client is not `ready` until it is. */
  #onlineAbort = null;
  /** @type {GuruFailure|null} */
  #lastError = null;
  /** @type {{promise: Promise<void>, resolve: () => void}|null} What `connect()` waits on. */
  #gate = null;
  /** @type {Map<string, Pending>} */
  #pending = new Map();

  #stateHandlers = new Set();
  #commerceHandlers = new Set();

  /**
   * @param {object} options
   * @param {() => Promise<string>} options.mintToken A fresh one-time token
   *   (`POST …/auth/getOneTimeAuthToken`); called once per connect attempt. A
   *   rejection with a `code` of `sign_in_required` or `session_expired` makes
   *   every request answer with it until a token can be had again.
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
   * @param {{initialMs?: number, maxMs?: number}} [options.backoff] Each a
   *   positive number of milliseconds (clamped to 2^31-1), else the default.
   * @param {number} [options.connectTimeoutMs] The longest one attempt, token and
   *   handshake together, may take before it is abandoned and retried.
   * @param {number} [options.stableMs] How long a connection must stay open, if
   *   it delivers no frame sooner, before the backoff starts over.
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
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    stableMs = DEFAULT_STABLE_MS,
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
    this.#backoff = {
      initialMs: timerMs(backoff?.initialMs, DEFAULT_BACKOFF.initialMs),
      maxMs: timerMs(backoff?.maxMs, DEFAULT_BACKOFF.maxMs),
    };
    this.#connectTimeoutMs = timerMs(connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this.#stableMs = timerMs(stableMs, DEFAULT_STABLE_MS);
    this.#randomId = randomId;
  }

  // --- what the host reads -------------------------------------------------

  /** @returns {GuruState} */
  get state() { return this.#state; }

  /**
   * Why the last attempt failed or the connection was lost, as a code and a
   * fixed message (never the token, and never the text of the error that
   * caused it); `null` while `ready`, and before anything failed. It is how a
   * caller sees a `mintToken()` that keeps failing, which is otherwise only a
   * state that stays `reconnecting`.
   * @returns {GuruFailure|null}
   */
  get lastError() { return this.#lastError; }

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
    else this.#resumeIfOnline();
    await settled;
    if (this.#state === 'closed') throw closedError();
  }

  /**
   * Run one `valuguru.*` op.
   *
   * Opens the connection if nothing has yet. While the socket is not open the
   * request waits, and is sent when it opens; that wait is bounded by
   * `timeoutMs` (a `'timeout'` with `details.sent: false`). Once sent, the
   * silence timer starts with the full `timeoutMs` and restarts on every
   * `data_progress` (a `'timeout'` with `details.sent: true`). A request that
   * times out is not cancelled on the wire; only an abort sends `data_cancel`.
   *
   * Rejects with a {@link GuruError}: the server's own (`ok:false`),
   * `'timeout'`, `'aborted'` (after sending a `data_cancel`, if it was on the
   * wire), `'disconnected'` when the socket dropped under it or the client
   * was closed, or `'sign_in_required'` / `'session_expired'` when no token can
   * be minted for want of a session. A request that cannot even be built (a bad
   * op, circular params, a `timeoutMs` that is not a positive number) rejects
   * with the `TypeError` or `RangeError` instead. A `timeoutMs` beyond 2^31-1
   * is clamped to it.
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
      if (typeof timeoutMs !== 'number' || !(timeoutMs > 0)) {
        return reject(new RangeError('request needs a positive timeoutMs.'));
      }
      if (this.#state === 'closed') return reject(closedError());
      if (signal?.aborted) return reject(new GuruError(ABORTED, `${op} was aborted`));
      if (this.#state !== 'ready' && SESSION_ERRORS.has(this.#lastError?.code)) {
        return reject(new GuruError(this.#lastError.code, `${op} cannot run: ${this.#lastError.message}`));
      }

      /** @type {Pending} */
      const entry = {
        requestId: this.#randomId(),
        op,
        params,
        timeoutMs: Math.min(timeoutMs, MAX_TIMER_MS),
        resolve,
        reject,
        timer: null,
        sent: false,
        signal,
        onAbort: null,
      };
      this.#pending.set(entry.requestId, entry);
      this.#armTimeout(entry);
      if (signal) {
        entry.onAbort = () => this.#abort(entry);
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }

      if (this.#state === 'idle') this.#begin();
      else if (this.#state === 'ready') this.#transmit(entry);
      else this.#resumeIfOnline();
    });
  }

  /**
   * Close the socket, answer every pending request `disconnected`, stop
   * reconnecting and let go of every subscriber. For good: the client is not
   * reopened (a new session gets a new client). Idempotent; never throws.
   */
  close() {
    if (this.#state === 'closed') return;
    this.#abandonAttempt('closed');
    this.#unwatchOnline();
    clearTimeout(this.#stableTimer);
    this.#stableTimer = null;
    this.#setState('closed');
    for (const entry of [...this.#pending.values()]) {
      if (this.#finish(entry)) entry.reject(closedError());
    }
    this.#openGate();
    this.#stateHandlers.clear();
    this.#commerceHandlers.clear();
  }

  // --- connecting ----------------------------------------------------------

  /** The first attempt, from `idle`. */
  #begin() {
    if (this.#paused()) this.#goOffline();
    else void this.#attempt();
  }

  /**
   * One connect attempt: a fresh token, then a socket, all inside
   * `connectTimeoutMs`. It never rejects — a failure ends in `#scheduleRetry`.
   * Only the current attempt (see `#epoch`) may act: one that was abandoned,
   * timed out or outlived a `close()` returns without opening or retrying
   * anything, whatever it was waiting for does.
   */
  async #attempt() {
    this.#epoch += 1;
    const epoch = this.#epoch;
    this.#setState(this.#started ? 'reconnecting' : 'connecting');
    this.#started = true;
    if (epoch !== this.#epoch) return;                      // a subscriber closed the client
    this.#watchOnline();
    clearTimeout(this.#attemptTimer);
    this.#attemptTimer = setTimeout(() => {
      this.#attemptTimer = null;
      if (epoch !== this.#epoch) return;
      this.#abandonAttempt('attempt timed out');
      this.#fail(HOST_ERRORS.TIMEOUT, 'the connection attempt timed out');
    }, this.#connectTimeoutMs);

    let token;
    try {
      token = await this.#mintToken();
      if (typeof token !== 'string' || !token) throw new TypeError('mintToken resolved without a token.');
    } catch (error) {
      if (epoch === this.#epoch) this.#mintFailed(error);
      return;
    }
    if (epoch !== this.#epoch) return;                      // superseded while minting: the token goes unused

    let socket;
    try {
      socket = new this.#WebSocket(`${this.#url}?token=${encodeURIComponent(token)}&client=host`);
    } catch {
      this.#fail(CONNECT_FAILED, 'could not open the connection');
      return;
    }
    this.#socket = socket;
    socket.onopen = () => this.#onOpen(socket);
    socket.onmessage = (event) => this.#onMessage(socket, event?.data);
    socket.onclose = (event) => this.#onClose(socket, event);
  }

  /**
   * Make the current attempt a past one: whatever it is waiting for no longer
   * matters. Stops its timers, detaches and closes its socket. Nothing is
   * scheduled in its place.
   * @param {string} reason Sent as the close reason.
   */
  #abandonAttempt(reason) {
    this.#epoch += 1;
    clearTimeout(this.#attemptTimer);
    this.#attemptTimer = null;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    try { socket.close(NORMAL_CLOSURE, reason); } catch { /* a socket that is gone is closed enough */ }
  }

  /** `mintToken()` rejected (or resolved nothing). A session error also answers what is held. */
  #mintFailed(error) {
    const code = typeof error?.code === 'string' && error.code ? error.code : MINT_FAILED;
    this.#lastError = Object.freeze({ code, message: 'could not mint a Valu Guru token' });
    if (SESSION_ERRORS.has(code)) {
      for (const entry of [...this.#pending.values()]) {
        if (!entry.sent && this.#finish(entry)) {
          entry.reject(new GuruError(code, `${entry.op} cannot run: ${this.#lastError.message}`));
        }
      }
    }
    this.#scheduleRetry();
  }

  #fail(code, message) {
    this.#lastError = Object.freeze({ code, message });
    this.#scheduleRetry();
  }

  /** Wait out the backoff, then try again — or wait for the network, if there is none. */
  #scheduleRetry() {
    clearTimeout(this.#attemptTimer);
    this.#attemptTimer = null;
    if (this.#state === 'closed') return;
    this.#watchOnline();
    if (this.#paused()) {
      this.#goOffline();
      return;
    }
    const delay = Math.min(backoffDelayMs(this.#failures, this.#backoff), MAX_TIMER_MS);
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
    this.#watchOnline();
    this.#setState('offline');
  }

  /** Listen for `online` until the client is `ready` or closed. Idempotent. */
  #watchOnline() {
    if (this.#onlineAbort || this.#state === 'closed' || typeof this.#listen !== 'function') return;
    const controller = new AbortController();
    this.#onlineAbort = controller;
    const listen = this.#listen;                            // called bare, as `window.addEventListener` is
    listen('online', () => { if (this.#onlineAbort === controller) this.#onOnline(); }, { signal: controller.signal });
  }

  #unwatchOnline() {
    this.#onlineAbort?.abort();
    this.#onlineAbort = null;
  }

  /**
   * The network is back, or changed: whatever was being waited for — the
   * backoff, the pause, an attempt that began on the old network — stops, and
   * a fresh attempt starts now with the failures forgiven.
   */
  #onOnline() {
    if (this.#state === 'idle' || this.#state === 'ready' || this.#state === 'closed') return;
    this.#failures = 0;
    this.#abandonAttempt('online');
    void this.#attempt();
  }

  /** The `online` event can be missed (iOS resume): a caller that arrives while `offline` looks at the flag itself. */
  #resumeIfOnline() {
    if (this.#state === 'offline' && !this.#paused()) this.#onOnline();
  }

  // --- the socket ----------------------------------------------------------

  #onOpen(socket) {
    if (this.#socket !== socket) return;
    clearTimeout(this.#attemptTimer);
    this.#attemptTimer = null;
    this.#unwatchOnline();
    this.#lastError = null;
    clearTimeout(this.#stableTimer);
    this.#stableTimer = setTimeout(() => this.#markStable(), this.#stableMs);
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
    clearTimeout(this.#stableTimer);
    this.#stableTimer = null;
    for (const entry of [...this.#pending.values()]) {
      if (!entry.sent || !this.#finish(entry)) continue;
      entry.reject(new GuruError(
        HOST_ERRORS.DISCONNECTED,
        `the connection to Valu Guru dropped during ${entry.op}`,
        { closeCode: event?.code },
      ));
    }
    const code = Number.isInteger(event?.code) ? ` (code ${event.code})` : '';
    this.#fail(HOST_ERRORS.DISCONNECTED, `the connection closed${code}`);
  }

  /** The connection has earned the trust the backoff withheld: the failures before it are forgiven. */
  #markStable() {
    clearTimeout(this.#stableTimer);
    this.#stableTimer = null;
    this.#failures = 0;
  }

  /** Read one frame. Only three kinds are ours; the rest are the server mirroring the user's session. */
  #onMessage(socket, data) {
    if (this.#socket !== socket) return;
    if (this.#stableTimer !== null) this.#markStable();     // the server is talking to us: this one is real
    if (typeof data !== 'string') return;
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

  /**
   * Put a request on the socket, if it is open: a socket that is closing, or
   * not there, leaves the request held for the next one. A request that
   * cannot be built is rejected alone. Once sent, the silence timer starts
   * over with the full `timeoutMs`.
   */
  #transmit(entry) {
    const socket = this.#socket;
    if (socket?.readyState !== WS_OPEN) return;
    try {
      const frame = {
        type: FRAME.REQUEST, requestId: entry.requestId, op: entry.op, params: entry.params, networkId: this.#getNetworkId(),
      };
      socket.send(JSON.stringify(frame));
    } catch (error) {
      if (this.#finish(entry)) entry.reject(error);
      return;
    }
    entry.sent = true;
    this.#armTimeout(entry);
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
    try {
      if (entry.sent && this.#socket?.readyState === WS_OPEN) {
        this.#socket.send(JSON.stringify({ type: FRAME.CANCEL, requestId: entry.requestId }));
      }
    } catch { /* the cancel is best effort: the request is over either way */ } finally {
      entry.reject(new GuruError(ABORTED, `${entry.op} was aborted`));
    }
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
