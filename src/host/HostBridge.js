// ===========================================================================
// The host iframe's message handler (spec §4.3, §4.5).
//
// The page that embeds a Workspaces app carries a hidden iframe on a Valu
// origin; this is what runs inside it. It binds to ONE parent origin, works out
// which app that is, restores the user's session, tells the app it is ready,
// and then answers everything the app asks: the handshake, the binding, the
// nesting rule, the dispatch table, sign-out, ping and the pushes, and what the
// app is here for, `api:call` (the SDK's service functions over the master),
// `api:service-intent` (the Commerce data intents over Valu Guru, Commerce event
// subscriptions, the identity token) and `host:consent`. The sign-in token
// channel is added on top of it.
//
// Who is listened to:
//
//   - Only `event.source === win.parent`. Any other window is ignored, silently.
//   - After the handshake also `event.origin === bound origin`. The origin is
//     read off the FIRST `host:hello` and never from message params, so an app
//     cannot name itself. A second hello from the bound origin re-sends
//     `api:ready`; from any other origin it is dropped, unanswered.
//   - Nothing is served before `api:ready` has gone out, so a call never meets
//     a half-built session. (A client waits for `api:ready`; one that does not
//     gets no answer, which is what its own timeout is for.)
//
// What a call, an intent and a consent are held to (spec §4.6), in this order,
// every one on every path, before anything runs:
//
//   1. the function is one the host serves (404 / `not_available`);
//   2. the user is signed in (401 / `sign_in_required`);
//   3. the params fit the descriptor (400);
//   4. the scope's tier: `forbidden` is never run and never asked about,
//      `basic` runs, `consent` runs only with an unrevoked grant, read from
//      Valu Guru (cached by `GrantsStore`) and consulted for no other tier.
//
// The app never names itself: `applicationId` / `appId` are the binding's slug.
// At most `maxInFlight` requests run at once; the next answers `busy` at once,
// and one that takes longer than `callTimeoutMs` answers 408 `timeout` (its late
// result is dropped). A consent is decided only by a message from the host's own
// origin (the consent page) that is not from the parent window, for a nonce the
// app registered, and it never grants more than the app asked for.
//
// Where it answers:
//
//   - `win.parent.postMessage(msg, boundOrigin)`, never `'*'`. Before binding
//     (a refusal to a hello) it is the sender's own origin, and only when that
//     is a real `http(s)` origin: an opaque one (`'null'`) has no address.
//   - Every outbound payload passes `assertNoHostLeak` first; one that fails is
//     replaced by `{error:{code:'internal', message:'blocked outbound credential'}}`
//     and logged by key path, never by value. The one exemption: the top-level
//     `token` (a string) of the reply to `Application.get-identity-token`, the
//     app's own short-lived token, which the host builds itself (`markIdentityReply`).
//
// The nesting rule: the host serves only a page its parent frames directly
// (`win.parent === win.top`, `win.parent !== win`) and, where the browser says
// who the ancestors are (`location.ancestorOrigins`), only when every one of
// them is an allowed origin. Otherwise every `host:hello` answers
// `host:error {code:'nested'}` and nothing else is ever served.
//
// Hellos are handled one at a time, in arrival order, so two that overlap (the
// resolver and the session restore are asynchronous) cannot bind twice. Each of
// those two waits is bounded (`resolveTimeoutMs`, `restoreTimeoutMs`), so one
// that never answers cannot hold up every hello behind it.
//
// The config is read from the keys the bridge knows and nothing else
// (`normalizeConfig`): a wrong-typed or missing value takes its default, and the
// dev switch, which bypasses the resolver, is on only for the boolean `true`.
// Nothing here throws out of the listener: a message that is not an app message
// is ignored, and a failure inside a handler is logged.
//
// No DOM at import. The window, the clock and `fetch` are the caller's.
// ===========================================================================
import { createValuServices } from '../services/api.js';
import { displayNameOf } from '../socket/user-info.js';
import { RESOLVE_UNAVAILABLE } from './AppResolver.js';
import * as CommerceIntents from './CommerceIntents.js';
import { GrantsStore } from './GrantsStore.js';
import { GuruClient } from './GuruClient.js';
import {
  CALL_REPLIES, INTENT_REPLIES, NONCE_MAX, answerCall, answerIntent, cartCount, isIdentityReply, isPlainObject,
  notAvailable, permit, validConsentScopes,
} from './HostDispatch.js';
import * as Permissions from './Permissions.js';
import { isLocalOrigin, isOrigin, matchesOrigin } from './origins.js';
import {
  HOST_ERRORS, MSG, POPUP_MSG, PROTOCOL_VERSION, assertNoHostLeak, parseAppMessage, toParent,
} from './protocol.js';

/**
 * @typedef {object} HostConfig
 * @property {string} hostOrigin The origin this host page is served from.
 * @property {string} [master] The master API host.
 * @property {string[]} [signInOrigins] Origins the sign-in popup may report from.
 * @property {string[]} [brandOrigins]
 * @property {string[]} [allowedAncestors] Origin patterns a framing page may have
 *   (`https://*.valuguru.app`: any subdomain; `http://localhost:*`: any port).
 * @property {string[]} [devAncestors] Added to `allowedAncestors` when `dev`.
 * @property {boolean} [dev] Accept `message.app` from a localhost parent. Only
 *   the boolean `true` turns it on.
 * @property {number} [maxInFlight] Concurrent requests per bound app.
 * @property {number} [callTimeoutMs] How long a call or an intent may run before it answers 408 `timeout`.
 * @property {number} [consentTimeoutMs] How long a consent request waits for the popup.
 * @property {number} [restoreTimeoutMs] How long a stored session may take to
 *   check before the user is treated as signed out.
 * @property {number} [resolveTimeoutMs] How long the resolver may take before the
 *   hello is answered `resolve_unavailable`.
 */

const DEFAULT_CONFIG = Object.freeze({
  master: 'api.roomful.net',
  signInOrigins: Object.freeze([]),
  brandOrigins: Object.freeze([]),
  allowedAncestors: Object.freeze(['https://*.valuguru.app']),
  devAncestors: Object.freeze(['http://localhost:*', 'http://127.0.0.1:*']),
  maxInFlight: 16,
  callTimeoutMs: 30_000,
  consentTimeoutMs: 600_000,
  restoreTimeoutMs: 5_000,
  resolveTimeoutMs: 10_000,
});

/** The longest a timer can be: `setTimeout` fires a longer one at once. */
const MAX_TIMER_MS = 2_147_483_647;

const text = (value) => (typeof value === 'string' && value !== '' ? value : null);
/** A finite positive number, capped at what a timer can hold (a larger one would fire at once); else the default. */
const positive = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0
  ? Math.min(value, MAX_TIMER_MS)
  : fallback);
const positiveInteger = (value, fallback) => (Number.isInteger(value) && value > 0 ? Math.min(value, MAX_TIMER_MS) : fallback);
/**
 * An allow-list of origins. Left out (`undefined`) it takes its default; given as
 * anything but an array it is EMPTY, which allows nobody: a mistyped list must
 * refuse, never widen to the default.
 */
const originList = (value, fallback) => {
  if (value === undefined) return fallback;
  return Object.freeze(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
};

/**
 * The config the bridge runs on, built from the keys it knows and nothing else.
 * A number that is missing or the wrong kind takes its default, so an `undefined`
 * override cannot turn a timeout into 0, and one above what a timer can hold is
 * capped there. An origin list that is missing takes its default, but one that
 * is the wrong kind is empty: refused, never widened. `dev` is on only for the
 * boolean `true`: it is the one switch that bypasses the resolver, and `'false'`
 * or `1` must not turn it on. A key a later task needs is added here, with its
 * default.
 * @param {Partial<HostConfig>} [config]
 */
function normalizeConfig(config) {
  const given = config && typeof config === 'object' ? config : {};
  return Object.freeze({
    hostOrigin: text(given.hostOrigin),
    master: text(given.master) ?? DEFAULT_CONFIG.master,
    signInOrigins: originList(given.signInOrigins, DEFAULT_CONFIG.signInOrigins),
    brandOrigins: originList(given.brandOrigins, DEFAULT_CONFIG.brandOrigins),
    allowedAncestors: originList(given.allowedAncestors, DEFAULT_CONFIG.allowedAncestors),
    devAncestors: originList(given.devAncestors, DEFAULT_CONFIG.devAncestors),
    dev: given.dev === true,
    maxInFlight: positiveInteger(given.maxInFlight, DEFAULT_CONFIG.maxInFlight),
    callTimeoutMs: positive(given.callTimeoutMs, DEFAULT_CONFIG.callTimeoutMs),
    consentTimeoutMs: positive(given.consentTimeoutMs, DEFAULT_CONFIG.consentTimeoutMs),
    restoreTimeoutMs: positive(given.restoreTimeoutMs, DEFAULT_CONFIG.restoreTimeoutMs),
    resolveTimeoutMs: positive(given.resolveTimeoutMs, DEFAULT_CONFIG.resolveTimeoutMs),
  });
}

/** `<workspace>/<slug>`. */
const CLAIM_RE = /^([\w-][\w.-]*)\/([\w-][\w.-]*)$/;

/** A request id the way a client writes it: a number, else none (a reply to nobody names no id). */
const idOf = (requestId) => (typeof requestId === 'number' && Number.isFinite(requestId) ? requestId : undefined);

/** The one Commerce event the host answers with a count it reads itself, and the frame and op for it. */
const CART_EVENT = 'cart-updated';
const CART_FRAME = 'commerce.cart.updated';
const CART_GET = 'valuguru.commerce.cart.get';

/** App -> host names the host refuses, and the name each is answered under. */
const REFUSED = new Map([
  [MSG.RUN_INTENT, MSG.RUN_COMPLETED],
  [MSG.CREATE_POINTER, MSG.POINTER_CREATED],
  [MSG.RUN, MSG.RUN_COMPLETED],
  [MSG.RUN_CONSOLE, MSG.RUN_CONSOLE_COMPLETED],
]);

/** A message without its own top-level `token`. */
const withoutToken = (message) => Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'token'));

/** The default logger: warnings and errors to the console. A page passes its own. */
const consoleLog = (level, message) => {
  globalThis.console?.[level === 'error' ? 'error' : 'warn']?.(`[valu-host] ${message}`);
};

/**
 * `promise`, or `fallback` once `ms` have passed. The timer never outlives the
 * race; one that is passed `timers` is also listed there while it runs, so a
 * stop can clear it.
 * @param {Set<any>} [timers]
 */
function orAfter(promise, ms, fallback = null, timers = null) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  timers?.add(timer);
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
    timers?.delete(timer);
  });
}

/** What a wait that ran out of time answers, apart from `null` (a resolve the server answered "no such app"). */
const TIMED_OUT = Symbol('timed out');

/**
 * The default `makeServices`: the 65 functions over the master socket, for
 * this app. The slug is stamped by the host (an app's storage is addressed by
 * it, never by params); the two origins are the ones `Resources.*` links use.
 * @param {Function} [fetchImpl] A bound `fetch`.
 * @returns {(connection: {socket: object}, app: {slug: string}) => import('../services/api.js').ValuServiceApi}
 */
export const defaultMakeServices = (fetchImpl) => (connection, app) => createValuServices({
  socket: connection.socket,
  applicationId: app.slug,
  cache: null,
  fetchImpl,
  config: { webBase: 'https://live.valuverse.io', apiGate: 'https://api.roomful.net' },
});

/**
 * The default `makeGuru`: a `GuruClient` over the session seam (`mintToken`,
 * `getNetworkId`). Made lazily; it opens its socket on the first request. A
 * page that needs another URL or `WebSocket` passes its own `makeGuru`.
 * @param {{mintToken: Function, getNetworkId: Function}} session
 */
export const defaultMakeGuru = (session) => new GuruClient({
  mintToken: session.mintToken, getNetworkId: session.getNetworkId,
});

/** The default `makeGrants`: this app's grants, by its canonical address. */
export const defaultMakeGrants = (guru, app) => new GrantsStore({ guru, appAddress: app.address });

export class HostBridge {
  #win;
  #resolver;
  #auth;
  #config;
  #logger;
  #makeConnection;
  #makeServices;
  #makeGuru;
  #makeGrants;
  #commerce;
  #permissions;
  #fetch;

  // Held for the sign-in channel, which a later task adds.
  #sessionStore;

  #listening = false;
  #stopped = false;
  /** Hellos run one at a time; this is the tail of the line. */
  #queue = Promise.resolve();
  /** @type {{origin: string, app: import('./AppResolver.js').ResolvedApp}|null} */
  #bound = null;
  /** `api:ready` has gone out: the host serves the app. */
  #ready = false;
  #connection = null;
  #signedIn = false;
  #user = null;
  #network = null;
  /** The master session id, for the Guru mint; never posted, never logged. Null when signed out. */
  #sessionId = null;
  /** `user_info.user`, whole: what the Commerce intents answer with. */
  #masterUser = null;
  /** The SDK's service functions over the master, built on first use. */
  #services = null;
  /** The Valu Guru client and the grants over it, built on first need. */
  #guru = null;
  #grants = null;
  /** The Commerce events the app subscribed to. */
  #subscribed = new Set();
  /** Which cart read is the latest: an older one that finishes late is not pushed. */
  #cartSeq = 0;
  /** The tail of the line commerce frames wait in, so they are handled in order. */
  #frames = Promise.resolve();
  /** `api:call` + `api:service-intent` requests running now. */
  #inFlight = 0;
  /** Timers armed for a running request, so a stop can clear them. */
  #timers = new Set();
  /** nonce -> a consent request waiting for the popup: `{app, scopes, requestId, timer}`. */
  #consents = new Map();
  /** What the consent page reads, while this bridge is on the host origin. */
  #exposed = null;
  /** What `answerCall` and `answerIntent` are lent: this bridge's state, read through functions. */
  #seams;

  /**
   * @param {object} options
   * @param {Window} options.win The host page's window.
   * @param {{resolve: (origin: string) => Promise<object|null>}} options.resolver
   * @param {{restore: Function, signOut: Function}} options.auth A `HostAuth`.
   * @param {object} [options.sessionStore] A `SessionStore`.
   * @param {(sessionId: string) => {connect: Function, close: Function, socket: object}} options.makeConnection
   *   A `MasterConnection` for a session id.
   * @param {(connection: object, app: object) => object} [options.makeServices]
   *   Default: {@link defaultMakeServices}.
   * @param {(session: {mintToken: () => Promise<string>, getNetworkId: () => string|null}, app: object) => object} [options.makeGuru]
   *   A `GuruClient`, made when first needed (a grant check or a Commerce op), once per session. `session` is
   *   what it needs of the host: a one-time token per connect attempt and the master's network. Default:
   *   {@link defaultMakeGuru}.
   * @param {(guru: object, app: object) => object} [options.makeGrants] A `GrantsStore` over that client.
   *   Default: {@link defaultMakeGrants}.
   * @param {object} [options.commerce] The Commerce intent table (default: the module).
   * @param {object} [options.permissions] The permission tiers (default: the module).
   * @param {HostConfig} options.config
   * @param {(level: 'warn'|'error', message: string) => void} [options.log]
   * @param {Function} [options.fetchImpl] A bound `fetch`: the default `makeServices` and the Guru mint use it.
   */
  constructor({
    win, resolver, auth, sessionStore, makeConnection, makeServices, makeGuru, makeGrants,
    commerce = CommerceIntents, permissions = Permissions, config, log = consoleLog, fetchImpl,
  } = {}) {
    if (!win || typeof win.addEventListener !== 'function') throw new TypeError('HostBridge needs a window.');
    if (typeof resolver?.resolve !== 'function') throw new TypeError('HostBridge needs a resolver.');
    if (typeof auth?.restore !== 'function' || typeof auth?.signOut !== 'function') {
      throw new TypeError('HostBridge needs an auth with restore() and signOut().');
    }
    if (typeof makeConnection !== 'function') throw new TypeError('HostBridge needs a makeConnection.');
    this.#win = win;
    this.#resolver = resolver;
    this.#auth = auth;
    this.#sessionStore = sessionStore;
    this.#makeConnection = makeConnection;
    this.#fetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    this.#makeServices = makeServices ?? defaultMakeServices(this.#fetch);
    this.#makeGuru = makeGuru ?? defaultMakeGuru;
    this.#makeGrants = makeGrants ?? defaultMakeGrants;
    this.#commerce = commerce;
    this.#permissions = permissions;
    this.#config = normalizeConfig(config);
    this.#logger = log;
    this.#seams = Object.freeze({
      permissions,
      commerce,
      signedIn: () => this.#signedIn,
      app: () => this.#bound.app,
      services: () => this.#servicesFor(),
      grants: () => this.#grantsFor(),
      guru: () => this.#guruFor(),
      user: () => this.#masterUser,
      networkId: () => this.#networkId(),
      emit: (ns, data) => this.#connection.emit(ns, data),
      subscribed: () => this.#subscribed,
      setSubscribed: (events) => { this.#subscribed = events; },
      log: (level, message) => this.#log(level, message),
    });
  }

  /** Who the host is bound to and what it knows of the user. For tests and the consent page. */
  get state() {
    return {
      bound: this.#bound ? { ...this.#bound } : null,
      signedIn: this.#signedIn,
      ...this.#identity(),
    };
  }

  /** Start listening. Safe to call twice; a stopped bridge does not start again. */
  start() {
    if (this.#stopped) throw new Error('a stopped HostBridge cannot be started again');
    if (this.#listening) return this;
    this.#win.addEventListener('message', this.#onMessage);
    this.#listening = true;
    this.#exposeConsent();
    return this;
  }

  /** Stop listening and close what the bridge opened. Idempotent; never rejects. */
  async stop() {
    this.#stopped = true;
    if (this.#listening) {
      this.#win.removeEventListener('message', this.#onMessage);
      this.#listening = false;
    }
    this.#ready = false;
    if (this.#exposed && this.#win.__valuHost === this.#exposed) delete this.#win.__valuHost;
    this.#exposed = null;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    await this.#dropSession();
  }

  /**
   * The consent request waiting for the popup under `nonce`, for the consent
   * page to show: the app's name and address come from the binding and the
   * scopes from the request, never from anything the page itself is given.
   * @param {string} nonce
   * @returns {{nonce: string, app: {name: string, address: string}, scopes: string[]}|null}
   */
  pendingConsent(nonce) {
    const entry = typeof nonce === 'string' ? this.#consents.get(nonce) : undefined;
    return entry ? { nonce, app: { ...entry.app }, scopes: [...entry.scopes] } : null;
  }

  /**
   * Settle a waiting consent request with the user's decision: the consent
   * page's message, once it has passed the origin check. An approval writes the
   * grants (only scopes the app asked for, whatever the decision names), then
   * answers the app's `host:consent` with `host:consent-completed`. A nonce that
   * is not waiting is ignored, so a decision counts once.
   * @param {{nonce: string, approved: boolean, scopes: string[]}} decision
   * @returns {Promise<boolean>} whether a waiting request was settled
   */
  async resolveConsent({ nonce, approved, scopes } = {}) {
    const entry = typeof nonce === 'string' ? this.#consents.get(nonce) : undefined;
    if (!entry) return false;
    this.#consents.delete(nonce);
    clearTimeout(entry.timer);

    // Only `true` approves, and only of what was asked: a decision that names
    // nothing the app asked for grants nothing.
    const granted = approved === true && Array.isArray(scopes) ? entry.scopes.filter((scope) => scopes.includes(scope)) : [];
    let answer = { approved: false };
    if (granted.length > 0) {
      try {
        const grants = this.#grantsFor();
        await grants.grant(granted);
        answer = this.#grants === grants ? { approved: true } : { approved: false, reason: HOST_ERRORS.SIGN_IN_REQUIRED };
      } catch (error) {
        this.#log('warn', `a consent could not be written (${error?.code ?? error?.name ?? 'error'})`);
        answer = { approved: false, reason: HOST_ERRORS.UNAVAILABLE };
      }
    }
    this.#post(MSG.CONSENT_COMPLETED, answer, entry.requestId);
    return true;
  }

  /**
   * Tell the app what the host now knows about the user: `api:trigger auth`.
   * Nothing is sent before the app has been told it is ready.
   * @param {string} [reason] Why, when the state changed for a reason the app should see.
   */
  pushAuth(reason) {
    if (!this.#ready) return;
    this.#post(MSG.TRIGGER, {
      action: 'auth',
      data: { signedIn: this.#signedIn, ...this.#identity(), ...(text(reason) ? { reason } : {}) },
    });
  }

  /**
   * Push a Commerce event: `api:trigger commerce`.
   * @param {string} event
   * @param {object} [data]
   */
  pushCommerce(event, data = {}) {
    if (!this.#ready) return;
    this.#post(MSG.TRIGGER, { action: 'commerce', data: { ...data, event } });
  }

  // --- receiving -----------------------------------------------------------

  #onMessage = (event) => {
    try {
      if (this.#stopped || !event) return;
      const { data } = event;
      if (isPlainObject(data) && data.type === POPUP_MSG.CONSENT) {
        this.#onConsentDecision(event);
        return;
      }
      const parent = this.#win.parent;
      if (!parent || event.source !== parent) return;
      const parsed = parseAppMessage(event.data);
      if (!parsed) return;

      if (parsed.name === MSG.HELLO) {
        this.#enqueue(() => this.#onHello(event.origin, parsed.message));
        return;
      }
      if (!this.#ready || event.origin !== this.#bound.origin) return;
      this.#dispatch(parsed);
    } catch (error) {
      this.#log('error', `a message handler failed: ${error?.message ?? error}`);
    }
  };

  #enqueue(task) {
    this.#queue = this.#queue.then(task).catch((error) => {
      this.#log('error', `the handshake failed: ${error?.message ?? error}`);
    });
  }

  /** What an app asks once the host is ready. */
  #dispatch({ name, message, requestId }) {
    const id = idOf(requestId);
    switch (name) {
      case MSG.PING:
        this.#post(MSG.PONG, {}, id);
        return;
      case MSG.AUTH:
        this.#onAuth(message, id);
        return;
      case MSG.CALL:
        void this.#serve(CALL_REPLIES, id, (track) => answerCall(this.#seams, message, track));
        return;
      case MSG.SERVICE_INTENT:
        void this.#serve(INTENT_REPLIES, id, (track) => answerIntent(this.#seams, message, track));
        return;
      case MSG.CONSENT:
        this.#requestConsent(message, id);
        return;
      default:
        // `api:run-command` and anything unknown: in dedicated mode the app owns
        // its URL, and a name the host does not know is not worth an answer.
        if (REFUSED.has(name)) this.#post(REFUSED.get(name), notAvailable(name), id);
    }
  }

  #onAuth(message, id) {
    if (message.action !== 'sign-out') {
      this.#post(MSG.AUTH_COMPLETED, notAvailable(`host:auth ${String(message.action)}`), id);
      return;
    }
    this.#forgetSession();
    this.#dropSession();
    this.pushAuth();
    this.#post(MSG.AUTH_COMPLETED, { ok: true }, id);
  }

  // --- what the app asks ---------------------------------------------------

  /**
   * Take one `api:call` or `api:service-intent`: at most `maxInFlight` run at
   * once (the next answers `busy` at once), each is bounded by `callTimeoutMs`
   * (its late result is dropped), and one that fails answers `failed` and is
   * logged by code, never by message. `kind` says what each answers. `work`
   * is given a `track` it sets `wrote` on when it hands a write to the services
   * (a write that ran out of time may still be applied, and says so); once the
   * request is answered, `track.abandoned` is set, so work that was still
   * waiting (for the grants, say) does not start afterwards.
   * @param {typeof CALL_REPLIES} kind
   * @param {number|undefined} id
   * @param {(track: import('./HostDispatch.js').Track) => Promise<object>} work
   */
  async #serve(kind, id, work) {
    if (this.#inFlight >= this.#config.maxInFlight) {
      this.#post(kind.reply, kind.busy, id);
      return;
    }
    this.#inFlight += 1;
    const track = { wrote: false, abandoned: false };
    let answer;
    try {
      answer = await orAfter(work(track), this.#config.callTimeoutMs, TIMED_OUT, this.#timers);
      if (answer === TIMED_OUT) answer = track.wrote && kind.timeoutAfterWrite ? kind.timeoutAfterWrite : kind.timeout;
    } catch (error) {
      this.#log('error', `a request failed (${error?.code ?? error?.name ?? 'error'})`);
      answer = kind.failed;
    } finally {
      this.#inFlight -= 1;
      track.abandoned = true;
    }
    this.#post(kind.reply, answer, id);
  }

  /** The SDK's service functions over this session's master, built on first use. */
  #servicesFor() {
    this.#services ??= this.#makeServices(this.#connection, this.#bound.app);
    return this.#services;
  }

  // --- Valu Guru -----------------------------------------------------------

  /** The Guru client for this session, with the grants over it: made on first need, closed on sign-out. */
  #guruFor() {
    if (this.#guru) return this.#guru;
    if (!this.#signedIn || !this.#bound) throw new Error('not signed in');
    const { app } = this.#bound;
    const guru = this.#makeGuru({ mintToken: () => this.#mintGuruToken(), getNetworkId: () => this.#networkId() }, app);
    let grants;
    try {
      grants = this.#makeGrants(guru, app);
      guru.onCommerceEvent?.((frame) => this.#onCommerceFrame(guru, frame));
    } catch (error) {
      this.#closeQuietly(guru);
      throw error;
    }
    this.#guru = guru;
    this.#grants = grants;
    return guru;
  }

  #grantsFor() {
    this.#guruFor();
    return this.#grants;
  }

  /** The network the master is in now; what a Guru request is addressed to. */
  #networkId() {
    return this.#connection?.socket?.networkId ?? this.#network?.id ?? null;
  }

  /**
   * A one-time token for the Guru socket, minted with the host's session. A
   * token works once, so the client asks again for every connect attempt. A
   * refused session rejects `session_expired`; nothing here carries the session
   * into a message.
   */
  async #mintGuruToken() {
    const sessionId = this.#sessionId;
    if (!sessionId) throw Object.assign(new Error('no session to mint a token with'), { code: HOST_ERRORS.SIGN_IN_REQUIRED });
    if (typeof this.#fetch !== 'function') throw new Error('no fetch to mint a token with');
    const networkId = this.#networkId();
    const response = await this.#fetch(`https://${this.#config.master}/api/v1/auth/getOneTimeAuthToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId, ...(networkId ? { 'X-Network': networkId } : {}) },
      body: '{}',
    });
    const body = await response.json();
    // The master signals a refused session in the body (HTTP 200).
    if (body?.error?.code === 401) {
      throw Object.assign(new Error('the master refused the session'), { code: HOST_ERRORS.SESSION_EXPIRED });
    }
    const token = body?.data?.token;
    if (!response.ok || typeof token !== 'string' || token === '') throw new Error('the master issued no one-time token');
    return token;
  }

  /**
   * A `commerce_event` frame. Frames are handled one at a time, in arrival
   * order (the check below may wait on Valu Guru), so the app hears them in the
   * order they came.
   */
  #onCommerceFrame(guru, frame) {
    this.#frames = this.#frames.then(() => this.#handleFrame(guru, frame)).catch((error) => {
      this.#log('error', `a commerce event could not be handled (${error?.name ?? 'error'})`);
    });
  }

  /**
   * One frame, pushed to the app when it is one the app subscribed to and may
   * hear; a cart frame is read for its count instead. A subscription outlives
   * the check that made it, so each frame first asks, as `subscribe-events`
   * did, whether the app still holds `commerce:read` (cached by the grants
   * store for its TTL): a grant that was revoked, or that cannot be read, drops
   * the frame and the subscription, and the app subscribes again once it is
   * allowed to.
   */
  async #handleFrame(guru, frame) {
    if (this.#guru !== guru || !this.#ready || this.#subscribed.size === 0) return;
    const verdict = await permit(this.#seams, this.#permissions.scopeOfIntent('Commerce', 'subscribe-events'));
    if (this.#guru !== guru || !this.#ready) return;
    if (!verdict.ok) {
      this.#subscribed = new Set();
      return;
    }
    try {
      const mapped = this.#commerce.mapCommerceEvent(frame, {
        appId: this.#bound.app.slug, networkId: this.#networkId(), subscribed: this.#subscribed,
      });
      if (mapped) this.pushCommerce(mapped.event, mapped.data);
      if (frame?.event === CART_FRAME && this.#subscribed.has(CART_EVENT)) void this.#pushCartCount(guru);
    } catch (error) {
      this.#log('error', `a commerce event could not be handled (${error?.name ?? 'error'})`);
    }
  }

  /** Read the cart and push `cart-updated {count}`; only the latest read is pushed, and only to a subscriber. */
  async #pushCartCount(guru) {
    this.#cartSeq += 1;
    const seq = this.#cartSeq;
    try {
      const data = await guru.request(CART_GET, {});
      if (seq !== this.#cartSeq || this.#guru !== guru || !this.#subscribed.has(CART_EVENT)) return;
      this.pushCommerce(CART_EVENT, { count: cartCount(data, this.#bound.app.slug) });
    } catch (error) {
      this.#log('warn', `the cart count could not be read (${error?.code ?? error?.name ?? 'error'})`);
    }
  }

  // --- consent -------------------------------------------------------------

  /** `host:consent`: register what the consent page will show, and wait for its decision. */
  #requestConsent({ scopes, nonce }, id) {
    const refuse = (reason) => this.#post(MSG.CONSENT_COMPLETED, { approved: false, reason }, id);
    if (!this.#signedIn) return refuse(HOST_ERRORS.SIGN_IN_REQUIRED);
    const wanted = validConsentScopes(scopes, (scope) => this.#permissions.tierOf(scope));
    // The nonce names a request, so one that is already waiting is not rewritten.
    if (!wanted || typeof nonce !== 'string' || nonce === '' || nonce.length > NONCE_MAX || this.#consents.has(nonce)) {
      return refuse(HOST_ERRORS.INVALID_REQUEST);
    }
    if (this.#consents.size >= this.#config.maxInFlight) return refuse(HOST_ERRORS.BUSY);
    const { name, address } = this.#bound.app;
    const timer = setTimeout(() => this.#expireConsent(nonce), this.#config.consentTimeoutMs);
    this.#consents.set(nonce, { app: { name, address }, scopes: wanted, requestId: id, timer });
    return undefined;
  }

  #expireConsent(nonce) {
    const entry = this.#consents.get(nonce);
    if (!entry) return;
    this.#consents.delete(nonce);
    this.#post(MSG.CONSENT_COMPLETED, { approved: false, reason: HOST_ERRORS.TIMEOUT }, entry.requestId);
  }

  /** Tell every waiting app its request is over, and forget them. */
  #settleConsents(reason) {
    for (const entry of this.#consents.values()) {
      clearTimeout(entry.timer);
      this.#post(MSG.CONSENT_COMPLETED, { approved: false, reason }, entry.requestId);
    }
    this.#consents.clear();
  }

  /**
   * The consent page's decision. It is accepted from the host's own origin
   * only, and never from the parent window: the app page is not the consent page
   * even if it shares the origin.
   */
  #onConsentDecision(event) {
    const { hostOrigin } = this.#config;
    if (!hostOrigin || event.origin !== hostOrigin || event.source === this.#win.parent) return;
    const { nonce, approved, scopes } = event.data;
    this.resolveConsent({ nonce, approved, scopes }).catch((error) => {
      this.#log('error', `a consent decision failed (${error?.name ?? 'error'})`);
    });
  }

  /** Give the consent page its window onto the pending requests, when this page is on the host origin. */
  #exposeConsent() {
    const { hostOrigin } = this.#config;
    if (!hostOrigin || this.#win.location?.origin !== hostOrigin) return;
    this.#exposed = Object.freeze({ pendingConsent: (nonce) => this.pendingConsent(nonce) });
    this.#win.__valuHost = this.#exposed;
  }

  // --- the handshake -------------------------------------------------------

  async #onHello(origin, message) {
    if (this.#stopped) return;
    // Bound to another origin for the life of the page: not even an answer, and
    // before anything that could answer (a nesting refusal is an answer).
    if (this.#bound && this.#bound.origin !== origin) return;
    // An opaque origin ('null') has nowhere to be answered, and no app.
    if (!isOrigin(origin)) return;

    const refusal = this.#placementRefusal();
    if (refusal) {
      this.#post(MSG.ERROR, { code: HOST_ERRORS.NESTED, message: refusal }, undefined, origin);
      return;
    }

    const { protocol } = message;
    if (typeof protocol === 'number' && protocol > PROTOCOL_VERSION) {
      this.#post(MSG.ERROR, {
        code: HOST_ERRORS.PROTOCOL_UNSUPPORTED,
        message: `this host speaks protocol ${PROTOCOL_VERSION}; the client asked for ${protocol}`,
      }, undefined, origin);
      return;
    }

    if (this.#bound) {
      if (this.#ready) this.#sendReady();
      return;
    }
    await this.#bind(origin, message);
  }

  /** Resolve the app, bind to it, restore the session, say ready. */
  async #bind(origin, message) {
    let app = this.#claimedApp(origin, message);
    if (!app) {
      try {
        // Bounded, so a resolver that never answers cannot hold up every hello behind this one.
        app = await orAfter(this.#resolver.resolve(origin), this.#config.resolveTimeoutMs, TIMED_OUT);
      } catch (error) {
        this.#log('warn', `the app could not be resolved (${error?.code ?? RESOLVE_UNAVAILABLE})`);
        this.#post(MSG.ERROR, {
          code: RESOLVE_UNAVAILABLE, message: 'the app could not be looked up; try again',
        }, undefined, origin);
        return;
      }
      if (this.#stopped) return;
      if (app === TIMED_OUT) {
        this.#log('warn', 'the app could not be resolved (timeout)');
        this.#post(MSG.ERROR, {
          code: RESOLVE_UNAVAILABLE, message: 'the app could not be looked up in time; try again',
        }, undefined, origin);
        return;
      }
      if (!app) {
        this.#post(MSG.ERROR, {
          code: HOST_ERRORS.UNKNOWN_APP, message: 'this origin is not a published Valu app',
        }, undefined, origin);
        return;
      }
    }

    this.#bound = { origin, app };
    await this.#restoreSession(app);
    if (this.#stopped) return;
    this.#ready = true;
    this.#sendReady();
  }

  /**
   * A dev build lets a localhost page name its app (`message.app`,
   * `<workspace>/<slug>`) instead of being resolved. Production has neither.
   */
  #claimedApp(origin, message) {
    if (!this.#config.dev || !isLocalOrigin(origin) || typeof message.app !== 'string') return null;
    const claim = CLAIM_RE.exec(message.app);
    if (!claim) return null;
    return {
      address: message.app, workspaceId: claim[1], slug: claim[2], devAppId: null, name: claim[2], homeNetworkId: null,
    };
  }

  /** Why this page may not be served, or `null` when it may. */
  #placementRefusal() {
    const win = this.#win;
    if (win.parent === win || win.parent !== win.top) {
      return 'the host runs only in a page that the app frames directly';
    }
    const ancestors = win.location?.ancestorOrigins;
    if (ancestors) {
      const allowed = [...this.#config.allowedAncestors, ...(this.#config.dev ? this.#config.devAncestors : [])];
      const stranger = Array.from(ancestors).some((origin) => !allowed.some((pattern) => matchesOrigin(pattern, origin)));
      if (stranger) return 'the page that frames this host is not an allowed origin';
    }
    return null;
  }

  // --- the session ---------------------------------------------------------

  /** Restore the stored session, and when there is one, open the master. A timeout is "no session". */
  async #restoreSession(app) {
    let stored = null;
    try {
      stored = await orAfter(
        this.#auth.restore({ homeNetworkId: app.homeNetworkId }),
        this.#config.restoreTimeoutMs,
      );
    } catch (error) {
      this.#log('warn', `the stored session could not be checked (${error?.code ?? error?.name ?? 'error'})`);
    }
    if (this.#stopped || !text(stored?.sessionId)) return;
    await this.#openMaster(stored.sessionId);
  }

  /** Connect the master for a session. A rejection means the user is signed out. */
  async #openMaster(sessionId) {
    let connection = null;
    try {
      connection = this.#makeConnection(sessionId);
      this.#connection = connection;
      const info = await connection.connect();
      if (this.#stopped || this.#connection !== connection) return;
      this.#signedIn = true;
      this.#sessionId = sessionId;
      this.#masterUser = isPlainObject(info?.user) ? info.user : null;
      this.#user = text(info?.userId) ? { id: info.userId, name: displayNameOf(info.user) } : null;
      this.#network = text(info?.networkId)
        ? { id: info.networkId, name: text(info.network?.fullName) ?? text(info.network?.name) }
        : null;
    } catch (error) {
      if (this.#connection === connection) this.#connection = null;
      if (connection) this.#closeQuietly(connection);
      this.#log('warn', `the master did not accept the session (${error?.code ?? error?.name ?? 'error'})`);
      if (error?.code === HOST_ERRORS.SESSION_EXPIRED && !this.#stopped) this.#forgetSession();
    }
  }

  /** Clear the stored session. */
  #forgetSession() {
    try {
      this.#auth.signOut();
    } catch (error) {
      this.#log('warn', `the stored session could not be cleared (${error?.name ?? 'error'})`);
    }
  }

  /**
   * Close the master connection and the guru client, forget who the user was
   * and what was held for them: the grants cache, the Commerce subscriptions,
   * the consent requests (their apps are told they are over).
   */
  #dropSession() {
    const closing = [this.#connection, this.#guru].filter(Boolean);
    const grants = this.#grants;
    this.#connection = null;
    this.#guru = null;
    this.#grants = null;
    this.#services = null;
    this.#sessionId = null;
    this.#masterUser = null;
    this.#subscribed = new Set();
    this.#cartSeq += 1;
    this.#signedIn = false;
    this.#user = null;
    this.#network = null;
    this.#settleConsents(HOST_ERRORS.SIGN_IN_REQUIRED);
    // After the state is gone, and guarded: a cache that will not clear must not
    // keep the session alive or stop the sign-out from being answered.
    try {
      grants?.invalidate?.();
    } catch (error) {
      this.#log('warn', `the grants cache could not be dropped (${error?.name ?? 'error'})`);
    }
    return Promise.all(closing.map((closable) => this.#closeQuietly(closable)));
  }

  async #closeQuietly(closable) {
    try {
      await closable.close?.();
    } catch (error) {
      this.#log('warn', `a connection did not close cleanly (${error?.name ?? 'error'})`);
    }
  }

  #identity() {
    return {
      user: this.#user && { ...this.#user },
      network: this.#network && { ...this.#network },
    };
  }

  // --- sending -------------------------------------------------------------

  #sendReady() {
    this.#post(MSG.READY, {
      applicationId: this.#bound.app.address,
      action: 'start',
      params: {},
      host: {
        protocol: PROTOCOL_VERSION, mode: 'dedicated', signedIn: this.#signedIn, ...this.#identity(),
      },
    });
  }

  /**
   * Post one message to the parent, to `targetOrigin` — the bound origin unless
   * a refusal names the sender's. Never to a wildcard, and never with a credential.
   */
  #post(name, message, requestId, targetOrigin = this.#bound?.origin) {
    if (this.#stopped) return;
    const parent = this.#win.parent;
    if (!parent || !isOrigin(targetOrigin)) return;

    let payload;
    try {
      payload = toParent(name, message, requestId);
      // The identity token reply is the one message whose own `token` may leave:
      // the guard still reads everything else in it, and a token that is not a
      // plain string is no token.
      const exempt = isIdentityReply(message) && typeof message.token === 'string';
      assertNoHostLeak(exempt ? toParent(name, withoutToken(message), requestId) : payload, `outbound ${name}`);
    } catch (error) {
      this.#log('error', `blocked an outbound ${name}: ${error.message}`);
      payload = toParent(name, { error: { code: 'internal', message: 'blocked outbound credential' } }, requestId);
    }
    try {
      parent.postMessage(payload, targetOrigin);
    } catch (error) {
      this.#log('warn', `could not post ${name} (${error?.name ?? 'error'})`);
    }
  }

  #log(level, message) {
    try {
      this.#logger(level, message);
    } catch { /* a logger that throws must not take the bridge with it */ }
  }
}
