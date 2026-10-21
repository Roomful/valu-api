// ===========================================================================
// The host transport — an app page's side of the host bridge.
//
// In dedicated mode the Roomful connection, the session and the permission
// checks live in a hidden iframe on the host origin (`<hostOrigin>/host/`,
// src/host/HostBridge.js). This transport injects that iframe, says
// `host:hello`, and from then on is the page's only way to the host:
//
//   request / notify   the postMessage bridge, as PostMessageTransport does it
//                      (`api:service-intent`, `host:auth`, `host:consent`)
//   callService        one `api:call` per service function; the host's
//                      `api:call-completed` message IS the ValuAck. `local`
//                      functions run here, in the page, and never reach the
//                      host
//   events             every `api:trigger` is a TRIGGER; a reconnect the host
//                      reports is RECONNECTED, so ServiceClient clears its cache
//
// Who may speak. Only `iframe.contentWindow`, from exactly `hostOrigin`, and
// only valu-api envelopes (`target: 'valuApi'`). Replies settle a request by
// its numeric `requestId` and nothing else. Everything posted goes to
// `hostOrigin`, never a wildcard. No credential exists on this side of the
// bridge, and nothing here reads one.
//
// A host that dies (spec §4.11). A `host:ping` goes out every `pingIntervalMs`;
// no `host:pong` within `pingTimeoutMs`, or an `error` on the iframe, is a dead
// host: the calls that were in flight answer `host_restarted`, the iframe is
// replaced, and the handshake runs ONCE more. The stored session makes that
// silent for the user. Calls made while it happens are held for it, within their
// own timeout; if the second handshake fails too, the transport says
// `connection offline` (the `reason` is the host's own error code, say
// `unknown_app`, or `host_unreachable` when it gave none) and stays down.
// ===========================================================================
import { Transport } from './Transport.js';
import { SocketTransport } from './SocketTransport.js';
import { nextId } from '../Utils.js';
import { ERROR_CODES, errorAck } from '../Errors.js';
import { DEFAULT_TIMEOUT_MS } from '../CallPolicy.js';
import { CONNECTION_STATE, HOST_ERRORS, MSG, PROTOCOL_VERSION } from '../host/protocol.js';
import { isOrigin } from '../host/origins.js';
// Registers the service functions: the `local` ones run on this page.
import '../services/impl/index.js';
import { VERSION } from '../version.js';

/** Replies that settle a pending request, by `requestId`. */
const REPLY_NAMES = new Set([
  MSG.CALL_COMPLETED,
  MSG.AUTH_COMPLETED,
  MSG.CONSENT_COMPLETED,
  MSG.RUN_CONSOLE_COMPLETED,
  MSG.RUN_COMPLETED,
  MSG.POINTER_CREATED,
]);

const NOT_OPEN = 'not_open';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** An Error that carries the code the app switches on. */
const hostError = (code, message = code, cause) => Object.assign(
  new Error(message, cause === undefined ? undefined : { cause }),
  { code },
);
const unreachable = (message) => hostError(HOST_ERRORS.HOST_UNREACHABLE, message);

/** A write that was handed to the host may have been applied: the app decides whether to repeat it. */
const unsafeToRepeat = (descriptor, ack) => (descriptor.mutates ? { error: { ...ack.error, retryable: false } } : ack);

const CONNECTION_STATES = new Set(Object.values(CONNECTION_STATE));

/**
 * What `api:ready` says, in the shape the transport keeps; `null` when it is not an `api:ready` body.
 * `connection` is the state of the host's link it names (`connecting` while a stored session is still
 * opening), or, from a host that names none, what `signedIn` implies.
 */
function readyOf(message) {
  if (!isPlainObject(message) || !isPlainObject(message.host) || typeof message.host.signedIn !== 'boolean') return null;
  const { host } = message;
  const implied = host.signedIn ? CONNECTION_STATE.READY : CONNECTION_STATE.SIGNED_OUT;
  return {
    message,
    applicationId: typeof message.applicationId === 'string' ? message.applicationId : null,
    connection: CONNECTION_STATES.has(host.connection) ? host.connection : implied,
    host: {
      signedIn: host.signedIn,
      user: host.user ?? null,
      network: host.network ?? null,
      protocol: host.protocol,
      mode: host.mode,
    },
  };
}

const identityChanged = (before, after) => before?.signedIn !== after.signedIn
  || before?.user?.id !== after.user?.id
  || before?.network?.id !== after.network?.id;

/**
 * The page's side of the host bridge: a hidden iframe on the host origin, and
 * the one transport that serves service functions for a dedicated-mode app.
 *
 * Events (see {@link Transport}): READY once, with the `api:ready` message;
 * TRIGGER for every host push, `{action, data}`; RECONNECTED when the host says
 * it reconnected, or after the iframe was replaced (the SDK cache is dropped).
 *
 * When the host dies, the iframe is replaced once and the handshake re-run
 * (`connection reconnecting`, then `connection {state, reconnected: true}`).
 * When that handshake fails too, the transport is down for good and pushes
 * `connection {state: 'offline', reason}`. The `reason` is the code the host
 * gave (`unknown_app`, `nested`, …), or `host_unreachable` when there was none
 * (it did not answer in time, or the frame failed).
 */
export class HostTransport extends Transport {
  #hostOrigin;
  #win;
  #doc;
  #setTimer;
  #clearTimer;
  #readyTimeoutMs;
  #pingIntervalMs;
  #pingTimeoutMs;
  #local;
  #ownsLocal;
  #listener = (event) => this.#onMessage(event);

  /** idle | opening | ready | recovering | failed | closed */
  #phase = 'idle';
  #opened = null;
  /** Settles (never rejects) when the handshake in progress has ended, either way. */
  #settling = null;
  /** Why the transport is `failed`. */
  #failure = null;
  #iframe = null;
  /** The handshake waiting for `api:ready`: `{frame, resolve, reject}`. */
  #opening = null;
  /** requestId -> `{posted, resolve, reject}`. `posted` is false while a call is held for a handshake. */
  #pending = new Map();
  #hostState = null;
  #applicationId = null;
  #connectionState = CONNECTION_STATE.CONNECTING;
  #pingTimer = null;
  #pongTimer = null;
  #pingId = null;
  /** The address the page claims, sent in `host:hello` when given (a dev host reads it from a localhost page). */
  #app;

  /**
   * @param {object} options
   * @param {string} options.hostOrigin Where the host is served, a bare origin
   *   (`https://valuguru.texpo.io`): the iframe's origin, the `targetOrigin` of
   *   everything posted to it, and the only origin it is heard from.
   * @param {string} [options.app] The app's address (`<workspace>/<slug>`), sent in `host:hello`
   *   as `app`. A dev host serves it to a page on localhost; a production host ignores it.
   * @param {Window} [options.window] Where the host's messages arrive.
   * @param {Document} [options.document] Where the iframe goes (`document.body`).
   * @param {number} [options.readyTimeoutMs] How long a handshake waits for `api:ready`.
   * @param {number} [options.pingIntervalMs] Between a pong (or the start) and the next ping.
   * @param {number} [options.pingTimeoutMs] How long a ping waits for its pong.
   * @param {import('./Transport.js').Transport} [options.localTransport] Runs the
   *   `local` functions. Default: a SocketTransport with no socket, built from
   *   `fetchImpl` and `config`.
   * @param {Function} [options.fetchImpl] `fetch`, for the default `localTransport`.
   * @param {object} [options.config] The origins the default `localTransport`'s URL builders need.
   * @param {Function} [options.setTimeout] Timers, for a test that turns the clock itself.
   * @param {Function} [options.clearTimeout]
   */
  constructor({
    hostOrigin,
    app,
    window: win = globalThis,
    document: doc = globalThis.document,
    readyTimeoutMs = 10_000,
    pingIntervalMs = 15_000,
    pingTimeoutMs = 10_000,
    localTransport,
    fetchImpl,
    config,
    setTimeout: setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: clearTimer = (id) => globalThis.clearTimeout(id),
  } = {}) {
    super();
    if (!isOrigin(hostOrigin)) {
      throw new TypeError('HostTransport hostOrigin must be an origin such as "https://host.example": no path, no trailing slash');
    }
    if (app !== undefined && typeof app !== 'string') {
      throw new TypeError('HostTransport app must be a string such as "ws_1/my-app"');
    }
    this.#hostOrigin = hostOrigin;
    this.#app = app;
    this.#win = win;
    this.#doc = doc;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#readyTimeoutMs = readyTimeoutMs;
    this.#pingIntervalMs = pingIntervalMs;
    this.#pingTimeoutMs = pingTimeoutMs;
    this.#ownsLocal = !localTransport;
    this.#local = localTransport ?? new SocketTransport({ socket: null, fetchImpl, config });
  }

  /** True while the host is there: after `api:ready`, and not while it is being replaced. */
  get connected() { return this.#phase === 'ready'; }

  get servesServiceFunctions() { return true; }

  /** The app's address, from `api:ready`. */
  get applicationId() { return this.#applicationId; }

  /**
   * What the host last said of the user and itself: `{signedIn, user, network,
   * protocol, mode}`, from `api:ready` and every `auth` push since. `null`
   * before the handshake. A copy.
   */
  get hostState() { return this.#hostState ? { ...this.#hostState } : null; }

  /** One of CONNECTION_STATE: what `api:ready` named (`connecting` while a stored session opens), then every `connection` push. */
  get connectionState() { return this.#connectionState; }

  /**
   * Inject the host iframe and shake hands. Resolves on `api:ready`; rejects
   * `Error{code}` with `host_unreachable` when it does not come within
   * `readyTimeoutMs`, or with the code of a `host:error` (`unknown_app`,
   * `nested`, `protocol_unsupported`, `resolve_unavailable` …). One handshake,
   * however often it is asked.
   */
  async open() {
    if (this.#phase === 'closed') throw new Error('transport closed');
    if (this.#phase === 'failed') throw this.#failure;
    if (!this.#opened) {
      this.#phase = 'opening';
      let done;
      this.#settling = new Promise((resolve) => { done = resolve; });
      this.#opened = this.#open();
      this.#opened.then(done, done);
    }
    return this.#opened;
  }

  /** @param {string} name @param {object} message @param {number} [requestId] */
  request(name, message, requestId = nextId()) {
    return new Promise((resolve, reject) => {
      const entry = { posted: false, resolve, reject };
      this.#pending.set(requestId, entry);
      this.#send(requestId, entry, name, { ...message, requestId });
    });
  }

  notify(name, message) {
    if (this.#phase !== 'ready') throw this.#unavailable();
    this.#post(name, message);
  }

  /**
   * Run one service function: in the page for a `local` one, otherwise as an
   * `api:call` the host answers with the ValuAck. Never rejects, and enforces
   * `timeoutMs` itself (408, counted from now, so a call held while the host
   * comes back is inside it).
   */
  callService(descriptor, params, options = {}) {
    if (descriptor?.channel === 'local') return this.#local.callService(descriptor, params, options);
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve) => {
      const requestId = nextId();
      let timer = null;
      const done = (ack) => {
        this.#clearTimer(timer);
        this.#pending.delete(requestId);
        resolve(ack);
      };
      const failed = (ack) => (entry.posted ? unsafeToRepeat(descriptor, ack) : ack);
      const entry = {
        posted: false,
        resolve: (reply) => done(isPlainObject(reply) ? reply : errorAck(ERROR_CODES.DISCONNECTED, HOST_ERRORS.HOST_UNREACHABLE)),
        reject: (error) => done(failed(errorAck(ERROR_CODES.DISCONNECTED, error.code ?? error.message))),
      };
      this.#pending.set(requestId, entry);
      timer = this.#setTimer(() => done(failed(errorAck(ERROR_CODES.TIMEOUT, 'timeout'))), timeoutMs);
      // `timeoutMs` is this attempt's, so the host can bound its one attempt to it.
      this.#send(requestId, entry, MSG.CALL, {
        service: descriptor.service, action: descriptor.action, params, requestId, timeoutMs,
      });
    });
  }

  async close() {
    if (this.#phase === 'closed') return;
    this.#phase = 'closed';
    this.#stopPing();
    this.#opening?.reject(new Error('transport closed'));
    this.#dropFrame();
    this.#win.removeEventListener('message', this.#listener);
    const closed = new Error('transport closed');
    for (const [id, entry] of [...this.#pending]) {
      this.#pending.delete(id);
      entry.reject(closed);
    }
    if (this.#ownsLocal) await this.#local.close?.();
  }

  // --- the handshake -------------------------------------------------------

  async #open() {
    let ready;
    try {
      this.#win.addEventListener('message', this.#listener);
      ready = await this.#attempt();
    } catch (error) {
      if (this.#phase === 'opening') this.#giveUp(error);
      throw error;
    }
    if (this.#phase !== 'opening') throw new Error('transport closed');
    this.#phase = 'ready';
    this.#adopt(ready);
    this.#startPing();
    this.#emit(Transport.READY, ready.message);
  }

  /**
   * One handshake on a fresh iframe: resolves the parsed `api:ready`, rejects an
   * Error{code}. Ends on the first of `api:ready`, `host:error`, an iframe
   * `error`, `readyTimeoutMs` and `close()`; whichever it is, no timer is left.
   */
  #attempt() {
    return new Promise((resolve, reject) => {
      let timer = null;
      const end = (settle) => {
        if (this.#opening !== pending) return;
        this.#opening = null;
        this.#clearTimer(timer);
        settle();
      };
      const pending = {
        frame: null,
        resolve: (ready) => end(() => resolve(ready)),
        reject: (error) => end(() => reject(error)),
      };
      this.#opening = pending;
      timer = this.#setTimer(
        () => pending.reject(unreachable(`the host did not answer within ${this.#readyTimeoutMs}ms`)),
        this.#readyTimeoutMs,
      );
      try {
        const frame = this.#doc.createElement('iframe');
        frame.hidden = true;
        frame.setAttribute('aria-hidden', 'true');
        frame.src = `${this.#hostOrigin}/host/`;
        pending.frame = frame;
        this.#iframe = frame;
        frame.addEventListener('load', () => this.#hello(pending, frame));
        frame.addEventListener('error', () => this.#onFrameError(frame));
        this.#doc.body.appendChild(frame);
      } catch (error) {
        pending.reject(unreachable(`the host frame could not be created: ${error?.message ?? error}`));
      }
    });
  }

  /** The iframe loaded: say hello, once, to this frame and no other. */
  #hello(pending, frame) {
    if (this.#opening !== pending || pending.frame !== frame) return;
    try {
      frame.contentWindow.postMessage(
        {
          name: MSG.HELLO,
          message: { protocol: PROTOCOL_VERSION, client: VERSION, ...(this.#app === undefined ? {} : { app: this.#app }) },
        },
        this.#hostOrigin,
      );
    } catch (error) {
      pending.reject(unreachable(`host:hello could not be posted: ${error?.message ?? error}`));
    }
  }

  #onFrameError(frame) {
    if (frame !== this.#iframe) return;
    if (this.#opening) this.#opening.reject(unreachable('the host frame failed to load'));
    else if (this.#phase === 'ready') this.#recover();
  }

  #adopt(ready) {
    this.#hostState = ready.host;
    this.#applicationId = ready.applicationId;
    this.#connectionState = ready.connection;
  }

  /** The handshake failed for good: the transport is down, and says so to whoever asks. */
  #giveUp(error) {
    this.#phase = 'failed';
    this.#failure = error;
    this.#stopPing();
    this.#dropFrame();
    this.#win.removeEventListener('message', this.#listener);
  }

  // --- a host that died ----------------------------------------------------

  #recover() {
    if (this.#phase !== 'ready') return;
    this.#phase = 'recovering';
    let done;
    this.#settling = new Promise((resolve) => { done = resolve; });
    this.#recovery().then(done);
  }

  /** Replace the iframe and shake hands once more. Never rejects. */
  async #recovery() {
    const before = this.#hostState;
    this.#stopPing();
    this.#failInFlight(hostError(HOST_ERRORS.HOST_RESTARTED));
    this.#dropFrame();
    this.#apply({ action: 'connection', data: { state: CONNECTION_STATE.RECONNECTING } });
    // A listener of that push may have closed the transport: nothing is started then.
    if (this.#phase !== 'recovering') return;

    let ready;
    try {
      ready = await this.#attempt();
    } catch (error) {
      if (this.#phase !== 'recovering') return;
      this.#giveUp(error);
      this.#apply({
        action: 'connection',
        data: { state: CONNECTION_STATE.OFFLINE, reason: error.code ?? HOST_ERRORS.HOST_UNREACHABLE },
      });
      return;
    }
    if (this.#phase !== 'recovering') return;
    this.#phase = 'ready';
    this.#adopt(ready);
    // Before any listener hears of it: one that acts on it (a new call, a second
    // dead frame) finds the transport whole.
    this.#startPing();
    // The new host may know a different user (the session ended while it was
    // down), and everything the app cached predates the gap.
    if (identityChanged(before, ready.host)) {
      const { signedIn, user, network } = ready.host;
      this.#apply({ action: 'auth', data: { signedIn, user, network } });
      // A listener may have closed the transport, or lost this host again: the
      // reconnect is then not the news.
      if (this.#phase !== 'ready') return;
    }
    this.#apply({ action: 'connection', data: { state: this.#connectionState, reconnected: true } });
  }

  /** Answer what was on the wire when the host died: it may or may not have been served. */
  #failInFlight(error) {
    for (const [id, entry] of [...this.#pending]) {
      if (!entry.posted) continue;
      this.#pending.delete(id);
      entry.reject(error);
    }
  }

  // --- ping ----------------------------------------------------------------

  #startPing() {
    this.#pingTimer = this.#setTimer(() => this.#ping(), this.#pingIntervalMs);
  }

  #ping() {
    this.#pingTimer = null;
    if (this.#phase !== 'ready') return;
    const requestId = nextId();
    this.#pingId = requestId;
    // Armed before the post: a host that answers at once must find it there.
    this.#pongTimer = this.#setTimer(() => {
      this.#pongTimer = null;
      this.#recover();
    }, this.#pingTimeoutMs);
    try {
      this.#post(MSG.PING, { requestId });
    } catch {
      this.#recover();
    }
  }

  #onPong(requestId) {
    if (this.#pingId === null || requestId !== this.#pingId) return;
    this.#pingId = null;
    this.#clearTimer(this.#pongTimer);
    this.#pongTimer = null;
    if (this.#phase === 'ready') this.#startPing();
  }

  #stopPing() {
    this.#clearTimer(this.#pingTimer);
    this.#clearTimer(this.#pongTimer);
    this.#pingTimer = null;
    this.#pongTimer = null;
    this.#pingId = null;
  }

  // --- sending -------------------------------------------------------------

  /**
   * Post `name` for a registered request, now when the host is there, otherwise
   * once the handshake in progress has ended; a request that is settled by then
   * (timed out, closed) is not sent. A failure settles the entry.
   */
  #send(requestId, entry, name, message) {
    const post = () => {
      // Marked first: a host that answers inside the post must find it posted.
      entry.posted = true;
      try {
        this.#post(name, message);
      } catch (error) {
        entry.posted = false;
        throw error;
      }
    };
    const fail = (error) => {
      if (this.#pending.get(requestId) !== entry) return;
      this.#pending.delete(requestId);
      entry.reject(error);
    };
    if (this.#phase === 'ready') {
      try { post(); } catch (error) { fail(error); }
      return;
    }
    this.#hold()
      .then(() => { if (this.#pending.get(requestId) === entry) post(); })
      .catch(fail);
  }

  /** Resolves once the host is there; rejects with why it cannot be. */
  async #hold() {
    while (this.#phase === 'opening' || this.#phase === 'recovering') await this.#settling;
    if (this.#phase !== 'ready') throw this.#unavailable();
  }

  #unavailable() {
    switch (this.#phase) {
      case 'closed': return new Error('transport closed');
      case 'failed': return this.#failure ?? unreachable('the host is not reachable');
      case 'recovering': return hostError(HOST_ERRORS.HOST_RESTARTED, 'the host is being restarted');
      case 'opening': return hostError(NOT_OPEN, 'the host has not sent api:ready yet');
      default: return hostError(NOT_OPEN, 'HostTransport.open() has not been called');
    }
  }

  /** The one way out: to the iframe's window, at `hostOrigin`. */
  #post(name, message) {
    const target = this.#iframe?.contentWindow;
    if (!target) throw unreachable('the host frame is not in the page');
    try {
      target.postMessage({ name, message }, this.#hostOrigin);
    } catch (error) {
      throw hostError(HOST_ERRORS.HOST_UNREACHABLE, error?.message ?? 'postMessage failed', error);
    }
  }

  // --- receiving -----------------------------------------------------------

  #onMessage(event) {
    const source = this.#iframe?.contentWindow;
    if (!source || event?.source !== source || event.origin !== this.#hostOrigin) return;
    const { data } = event;
    if (!isPlainObject(data) || data.target !== 'valuApi') return;
    const { name, message, requestId } = data;

    switch (name) {
      case MSG.READY: {
        const ready = this.#opening && readyOf(message);
        if (ready) this.#opening.resolve(ready);
        return;
      }
      case MSG.ERROR:
        this.#opening?.reject(hostError(
          typeof message?.code === 'string' && message.code ? message.code : HOST_ERRORS.HOST_UNREACHABLE,
          typeof message?.message === 'string' ? message.message : undefined,
        ));
        return;
      case MSG.PONG:
        this.#onPong(requestId);
        return;
      case MSG.TRIGGER:
        if (this.#phase === 'ready' && isPlainObject(message)) this.#apply(message);
        return;
      default:
        if (REPLY_NAMES.has(name)) this.#onReply(message, requestId);
    }
  }

  #onReply(message, requestId) {
    if (!Number.isFinite(requestId)) return;
    const entry = this.#pending.get(requestId);
    if (!entry?.posted) return;
    this.#pending.delete(requestId);
    entry.resolve(message);
  }

  /** One `api:trigger` (or one the transport makes of its own): state first, then the events. */
  #apply(message) {
    const { action, data } = message;
    if (action === 'auth' && isPlainObject(data) && typeof data.signedIn === 'boolean') {
      this.#hostState = {
        ...this.#hostState, signedIn: data.signedIn, user: data.user ?? null, network: data.network ?? null,
      };
    }
    if (action === 'connection' && isPlainObject(data) && typeof data.state === 'string') {
      this.#connectionState = data.state;
    }
    this.#emit(Transport.TRIGGER, message);
    if (action === 'connection' && isPlainObject(data) && data.reconnected === true) {
      this.#emit(Transport.RECONNECTED, data);
    }
  }

  /** A listener that throws is its own problem, not the transport's. */
  #emit(event, data) {
    try {
      this.events.emit(event, data);
    } catch (error) {
      console.error(`HostTransport: a "${event}" listener threw:`, error);
    }
  }

  #dropFrame() {
    const frame = this.#iframe;
    this.#iframe = null;
    if (!frame) return;
    try {
      this.#doc.body.removeChild(frame);
    } catch {
      // Already out of the page: nothing left to remove.
    }
  }
}
