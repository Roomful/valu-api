// ===========================================================================
// The embedded transport: the service transport of an app inside Valu Social.
//
// The bridge (PostMessageTransport) is the page's line to the window that
// frames it. A Valu Social that mounts valu-api's frame server
// (src/embed/FrameServer.js) answers valu-api's own `api:call` there, and says
// so in its `api:ready`: `message.valuApi = {protocol: 1, calls: true, user,
// network}`. This transport is the page's side of that, and mirrors
// HostTransport's:
//
//   local functions   run here, in the page (Http.*, Time.*, the resource URL
//                     builders), at once, whatever the parent says
//   every other one   one `api:call` over the bridge, `{service, action,
//                     params, requestId, timeoutMs}` exactly as HostTransport
//                     posts it; the `api:call-completed` message IS the ack
//   a typed intent    (`valu.Chats.openChannel()`, `valu.Commerce.getCart()`)
//                     one `api:call` too, with `intent: {target, id}` (the
//                     app or service it goes to), when the `api:ready` said
//                     `valuApi.intents`; otherwise the older bridge, as before:
//                     `api:run-intent` to an app, `api:service-intent` to a
//                     service. Either way the reply is read into an ack
//                     (`intentAck`), it is held for `api:ready` and bounded by
//                     the call's timeout like any call, and never retried
//   a route           (`valu.route.push(path)`, `routeCommand`) the same: an
//                     `api:call` with `intent: {target: 'route'}` when intents
//                     are served, the older `api:run-command` otherwise
//   before api:ready  held for it, within the call's own timeout
//   no valuApi.calls  an older Valu Social, which serves intents only: 501, as
//                     embedded mode always answered
//   untrusted parent  the same 501, and no user: `valuApi` (the calls AND the
//                     identity) is taken only from a parent whose origin is
//                     trusted, `trustedOrigins` (the app's `hostOrigins`, or the
//                     Valu origins the host trusts for sign-in). Any page can
//                     frame an app and send `api:ready`; one that is not Valu
//                     Social must not read the calls' params, forge their
//                     answers, or name a user. The bridge itself binds as before
//   no api:ready      within `readyTimeoutMs`: a parent that never answers (a
//                     preview, a page that is no Valu app host). The held calls answer 503
//                     `host_unreachable` (`retryable`: nothing was sent), and so
//                     does every call until an `api:ready` comes after all; one
//                     that does is taken like the first
//
// `callService` never rejects and enforces `timeoutMs` itself (408, counted
// from the call, so the wait for api:ready is inside it; a write that was
// posted says `retryable: false`, it may still be applied). The user and the
// network are what the last `api:ready` said (`{id, name}` or `null`).
//
// Events: READY on every accepted `api:ready`, with its message, once this
// transport has taken it; UNREACHABLE once, when `readyTimeoutMs` passes first.
// ===========================================================================
import { Transport } from './Transport.js';
import { SocketTransport } from './SocketTransport.js';
import { unsafeToRepeat } from './HostTransport.js';
import { nextId } from '../Utils.js';
import { ERROR_CODES, errorAck } from '../Errors.js';
import { DEFAULT_TIMEOUT_MS } from '../CallPolicy.js';
import { EMBEDDED_PROTOCOL_VERSION, HOST_ERRORS, MSG, identityOf } from '../host/protocol.js';
import { DEFAULT_SIGN_IN_ORIGINS } from '../host/origins.js';
import { intentAck } from '../services/intents.js';
// Registers the service functions: the `local` ones run on this page.
import '../services/impl/index.js';

/** How long the page waits for Valu Social's `api:ready` by default. */
export const EMBEDDED_READY_TIMEOUT_MS = 10_000;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** What a parent that says nothing of valu-api (or is not trusted to) leaves: no calls, no intents, no user. */
const NOTHING = Object.freeze({ calls: false, intents: false, user: null, network: null });

/**
 * What `api:ready` says of valu-api: whether `api:call` answers functions
 * (`calls`) and intents (`intents`, typed app intents), and who the user and
 * the network are. The two are separate: Valu Social answers intents even
 * when it cannot name the app a function would be served for.
 */
function valuApiOf(message) {
  const info = isPlainObject(message) ? message.valuApi : undefined;
  if (!isPlainObject(info)) return NOTHING;
  const spoken = info.protocol === EMBEDDED_PROTOCOL_VERSION;
  return {
    calls: info.calls === true && spoken,
    intents: info.intents === true && spoken,
    user: identityOf(info.user),
    network: identityOf(info.network),
  };
}

/** The route commands, and what the older bridge calls each (`ValuApi.pushRoute`, `replaceRoute`). */
export const ROUTE_COMMANDS = Object.freeze({ push: 'pushRoute', replace: 'replaceRoute' });
/** A route moves the app's own address and nothing else: never a write anyone else sees, never retried. */
const ROUTE = Object.freeze({ key: 'route', mutates: false });

/** What an older Valu Social leaves a service function with: the answer embedded mode always gave. */
const unserved = (descriptor) => errorAck(
  ERROR_CODES.UNSUPPORTED,
  `${descriptor.key} is not available in embedded mode: the embedding application serves intents (callService), not service functions`,
);

/** A frame nobody answered: nothing was sent, so the call may be made again. */
const unreachable = () => ({ error: { ...errorAck(ERROR_CODES.DISCONNECTED, HOST_ERRORS.HOST_UNREACHABLE).error, retryable: true } });

/** Why a post failed, as a string: a DOMException's `code` is a number. */
const reasonOf = (error) => (typeof error?.code === 'string' ? error.code : (error?.message ?? 'postMessage failed'));

export class EmbeddedTransport extends Transport {
  /** Emitted once, when no `api:ready` came within `readyTimeoutMs`. */
  static UNREACHABLE = 'unreachable';

  #bridge;
  #local;
  #ownsLocal;
  #setTimer;
  #clearTimer;
  /** waiting | ready | unreachable | closed */
  #phase = 'waiting';
  #info = NOTHING;
  #trustedOrigins;
  #readyTimer = null;
  #offReady;
  /** Every call not answered yet: `{posted, send, answer}`. */
  #active = new Set();
  /** The ones waiting for `api:ready`. */
  #held = new Set();

  /**
   * @param {object} options
   * @param {import('./PostMessageTransport.js').PostMessageTransport} options.bridge The page's bridge to Valu Social.
   * @param {string[]} [options.trustedOrigins] The parent origins whose `api:ready` is taken at its word on
   *   `valuApi`. Default: the Valu origins the host trusts for sign-in (`DEFAULT_SIGN_IN_ORIGINS`).
   * @param {number} [options.readyTimeoutMs] How long to wait for `api:ready`. Default 10 s.
   * @param {Transport} [options.localTransport] Runs the `local` functions. Default: a SocketTransport with
   *   no socket, built from `fetchImpl` and `config`.
   * @param {Function} [options.fetchImpl] `fetch`, for the default `localTransport`.
   * @param {object} [options.config] The origins the default `localTransport`'s URL builders need.
   * @param {Function} [options.setTimeout] Timers, for a test that turns the clock itself.
   * @param {Function} [options.clearTimeout]
   */
  constructor({
    bridge,
    trustedOrigins = DEFAULT_SIGN_IN_ORIGINS,
    readyTimeoutMs = EMBEDDED_READY_TIMEOUT_MS,
    localTransport,
    fetchImpl,
    config,
    setTimeout: setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: clearTimer = (id) => globalThis.clearTimeout(id),
  } = {}) {
    super();
    if (typeof bridge?.request !== 'function' || typeof bridge?.subscribe !== 'function') {
      throw new TypeError('EmbeddedTransport needs the bridge to Valu Social (a PostMessageTransport)');
    }
    if (!Array.isArray(trustedOrigins)) throw new TypeError('EmbeddedTransport trustedOrigins must be an array of origins');
    this.#trustedOrigins = Object.freeze([...trustedOrigins]);
    this.#bridge = bridge;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#ownsLocal = !localTransport;
    this.#local = localTransport ?? new SocketTransport({ socket: null, fetchImpl, config });
    this.#offReady = bridge.subscribe(Transport.READY, (message) => this.#onReady(message));
    this.#readyTimer = this.#setTimer(() => this.#expire(), readyTimeoutMs);
  }

  get servesServiceFunctions() { return true; }
  get servesIntents() { return true; }

  /** True once an `api:ready` came (and until `close()`). */
  get connected() { return this.#phase === 'ready'; }

  /** `waiting` (for api:ready), `ready`, `unreachable` (none came in time), `closed`. */
  get phase() { return this.#phase; }

  /** Whether Valu Social answers `api:call`: what the last `api:ready` said. */
  get calls() { return this.#info.calls; }

  /** Whether Valu Social answers intents over `api:call` (`valuApi.intents`): what the last `api:ready` said. */
  get intents() { return this.#info.intents; }

  /** Valu Social's user, `{id, name}`, or `null`. */
  get user() { return this.#info.user; }

  /** Valu Social's network, `{id, name}`, or `null`. */
  get network() { return this.#info.network; }

  get applicationId() { return this.#bridge.applicationId; }

  /**
   * Run one service function: in the page for a `local` one, otherwise as an
   * `api:call` to Valu Social once it has said it answers one; a typed intent
   * as an intent (see the header). Never rejects.
   */
  callService(descriptor, params, options = {}) {
    if (descriptor?.channel === 'local') return this.#local.callService(descriptor, params, options);
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const send = descriptor?.channel === 'intent'
      ? (entry) => this.#sendIntent(entry, descriptor, params, timeoutMs)
      : (entry) => this.#send(entry, descriptor, params, timeoutMs);
    return this.#queue(descriptor, timeoutMs, send);
  }

  /**
   * Move the app's own route inside Valu Social: `push` (a new history entry)
   * or `replace`. Held for `api:ready` and bounded by `timeoutMs` like a call;
   * never rejects. Over `api:call` when Valu Social answers intents, otherwise
   * the older `api:run-command`, which answers nothing: then the ack says only
   * that it was sent.
   * @param {'push'|'replace'} command
   * @param {string} path
   * @param {{timeoutMs?: number}} [options]
   */
  routeCommand(command, path, options = {}) {
    if (!Object.hasOwn(ROUTE_COMMANDS, command)) {
      return Promise.resolve(errorAck(ERROR_CODES.INVALID_PARAMS, `route command must be push or replace, not ${String(command)}`));
    }
    if (typeof path !== 'string') return Promise.resolve(errorAck(ERROR_CODES.INVALID_PARAMS, 'route: path must be a string'));
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return this.#queue(ROUTE, timeoutMs, (entry) => this.#sendRoute(entry, command, path, timeoutMs));
  }

  /** One call's life: held for `api:ready`, then `send(entry)`, answered once, bounded by `timeoutMs`. */
  #queue(descriptor, timeoutMs, send) {
    return new Promise((resolve) => {
      let timer = null;
      const entry = { posted: false, send: null, answer: null };
      entry.answer = (ack) => {
        if (!this.#active.delete(entry)) return;
        this.#held.delete(entry);
        this.#clearTimer(timer);
        resolve(ack);
      };
      entry.send = () => send(entry);
      this.#active.add(entry);
      timer = this.#setTimer(() => {
        const timedOut = errorAck(ERROR_CODES.TIMEOUT, 'timeout');
        entry.answer(entry.posted ? unsafeToRepeat(descriptor, timedOut) : timedOut);
      }, timeoutMs);

      switch (this.#phase) {
        case 'ready': entry.send(); break;
        case 'unreachable': entry.answer(unreachable()); break;
        case 'closed': entry.answer(errorAck(ERROR_CODES.DISCONNECTED, 'transport closed')); break;
        default: this.#held.add(entry);
      }
    });
  }

  /**
   * A typed intent inside Valu Social: an `api:call` with `intent` when the
   * `api:ready` said it answers one (the frame server checks it as the bridge
   * checks the same intent), the older bridge otherwise: `api:run-intent` to an
   * app, `api:service-intent` to a service, which Valu Social gates by the
   * app's declared permissions too.
   */
  #sendIntent(entry, descriptor, params, timeoutMs) {
    this.#held.delete(entry);
    if (!this.#active.has(entry)) return;
    const input = isPlainObject(params) ? params : {};
    const target = descriptor.target ?? 'service';
    const id = descriptor.to ?? descriptor.service;
    entry.posted = true;
    if (this.#info.intents) {
      this.#post(entry, (requestId) => ({ intent: { target, id }, action: descriptor.action, params: input, requestId, timeoutMs }));
      return;
    }
    const name = target === 'application' ? MSG.RUN_INTENT : MSG.SERVICE_INTENT;
    let sent;
    try {
      sent = this.#bridge.request(name, { applicationId: id, action: descriptor.action, params: input });
    } catch (error) {
      sent = Promise.reject(error);
    }
    sent.then(
      (reply) => entry.answer(intentAck(reply)),
      (error) => entry.answer(errorAck(ERROR_CODES.DISCONNECTED, reasonOf(error))),
    );
  }

  /** A route command, by what the `api:ready` said (see `routeCommand`). */
  #sendRoute(entry, command, path, timeoutMs) {
    this.#held.delete(entry);
    if (!this.#active.has(entry)) return;
    entry.posted = true;
    if (this.#info.intents) {
      this.#post(entry, (requestId) => ({ intent: { target: 'route' }, action: command, params: { path }, requestId, timeoutMs }));
      return;
    }
    try {
      this.#bridge.notify(MSG.RUN_COMMAND, { command: ROUTE_COMMANDS[command], data: path });
      entry.answer({ data: { success: true, sent: true } });
    } catch (error) {
      entry.answer(errorAck(ERROR_CODES.DISCONNECTED, reasonOf(error)));
    }
  }

  /** Post one `api:call` for `entry`, `message(requestId)`; the `api:call-completed` message is its ack. */
  #post(entry, message) {
    const requestId = nextId();
    this.#bridge.request(MSG.CALL, message(requestId), requestId).then(
      (reply) => entry.answer(isPlainObject(reply) ? reply : errorAck(ERROR_CODES.DISCONNECTED, HOST_ERRORS.HOST_UNREACHABLE)),
      // The post itself failed (a message that cannot be cloned): it never left the page.
      (error) => entry.answer(errorAck(ERROR_CODES.DISCONNECTED, reasonOf(error))),
    );
  }

  /** Answer what is waiting, stop the ready timer and the listener. Idempotent. */
  async close() {
    if (this.#phase === 'closed') return;
    this.#phase = 'closed';
    this.#clearTimer(this.#readyTimer);
    this.#readyTimer = null;
    this.#offReady?.();
    for (const entry of [...this.#active]) entry.answer(errorAck(ERROR_CODES.DISCONNECTED, 'transport closed'));
    if (this.#ownsLocal) await this.#local.close?.();
  }

  /** Post one call, or answer it 501 when this Valu Social does not take `api:call`. */
  #send(entry, descriptor, params, timeoutMs) {
    this.#held.delete(entry);
    if (!this.#active.has(entry)) return;
    if (!this.#info.calls) {
      entry.answer(unserved(descriptor));
      return;
    }
    // Marked first: a parent that answers inside the post must find it posted.
    entry.posted = true;
    this.#post(entry, (requestId) => ({ service: descriptor.service, action: descriptor.action, params, requestId, timeoutMs }));
  }

  /** Whether the parent the bridge is bound to may say that it answers calls, and who the user is. */
  get trusted() { return this.#trustedOrigins.includes(this.#bridge.peerOrigin); }

  /**
   * An `api:ready` the bridge took: what it says of valu-api, when the parent is
   * trusted to say it, then what was held for it. An untrusted parent is served
   * as an older Valu Social: no calls (501), no user.
   */
  #onReady(message) {
    if (this.#phase === 'closed') return;
    this.#info = this.trusted ? valuApiOf(message) : NOTHING;
    this.#phase = 'ready';
    this.#clearTimer(this.#readyTimer);
    this.#readyTimer = null;
    for (const entry of [...this.#held]) entry.send();
    this.#emit(Transport.READY, message);
  }

  /** `readyTimeoutMs` passed with no `api:ready`. */
  #expire() {
    this.#readyTimer = null;
    if (this.#phase !== 'waiting') return;
    this.#phase = 'unreachable';
    for (const entry of [...this.#held]) entry.answer(unreachable());
    this.#emit(EmbeddedTransport.UNREACHABLE, {});
  }

  /** A listener that throws is its own problem, not the transport's. */
  #emit(event, data) {
    try {
      this.events.emit(event, data);
    } catch (error) {
      console.error(`EmbeddedTransport: a "${event}" listener threw:`, error);
    }
  }
}
