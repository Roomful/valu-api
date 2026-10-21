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
// subscriptions, the identity token) and `host:consent`; how a user comes to be
// signed in (the sign-in token channel) and what the host does when its link to
// the platform drops, returns, is refused, or another tab signs the user out.
// The master session itself (connect, who the user is, the connection state)
// is `HostSession`.
//
// Who is listened to:
//
//   - Only `event.source === win.parent`, except the two popup channels below.
//     Any other window is ignored, silently.
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
// The popup channels (spec §4.3), both checked BEFORE the parent gate and both
// refused to the parent window, which is the app:
//
//   - `valu-host:consent` from the host's own origin, for a nonce an app registered.
//   - `valu-host:token` from one of `config.signInOrigins` (and, in a dev build,
//     `http://localhost:3005`): the sign-in popup's one-time token, or its
//     `cancelled`. A token for another master (`config.master`) is refused with
//     `master_mismatch` and never sent anywhere; otherwise `auth.redeem` trades
//     it for a session, the master is opened with it, and the app is pushed
//     `auth`. A token is taken only after `api:ready`, one at a time, and a user
//     who is signed in is signed out first. The token is never logged, held,
//     posted or put in an error.
//
// What the host pushes when the user's state changes (`api:trigger`, see
// protocol.js): `auth` (who the user is, with a `reason` when there is one) and
// `connection` (`connecting|ready|reconnecting|offline|signed_out`). A master
// that drops and returns invalidates the grants cache and pushes
// `{state:'ready', reconnected:true}`; a master that is lost is connected again
// by the session itself (backoff 1 s to 30 s, never giving up while the user is
// signed in), and the browser's `online` / `offline` events push `offline` or
// the current state and end a wait at once. One the master refuses
// (`session_expired`, from the master or from Valu Guru) is signed out: the
// stored session is forgotten (only if storage still holds it: another tab may
// have signed in since), every request still waiting is answered
// `sign_in_required`, and the app is pushed `signedIn:false,
// reason:'session_expired'`. Whatever ends a session does so for the session
// that asked: an answer that arrives after the user signed out and in again (a
// Guru mint, a restore, a connect) is about a session that is gone and does
// nothing to the new one (`#epoch`, and the connection a `HostSession` listens
// to). Another tab that signs
// the user out, or replaces the session, is heard through `sessionStore.onChange`
// (the page wires the browser's `storage` event to it, and must treat an event
// whose `key` is `null`, a `localStorage.clear()`, as a change too): the host
// drops the session, restores the one in storage if there is one, and pushes
// `auth` (`reason:'signed_out_elsewhere'` when there is none).
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
import { RESOLVE_UNAVAILABLE } from './AppResolver.js';
import * as CommerceIntents from './CommerceIntents.js';
import { GrantsStore } from './GrantsStore.js';
import { GuruClient } from './GuruClient.js';
import {
  CALL_REPLIES, INTENT_REPLIES, NONCE_MAX, answerCall, answerIntent, cartCount, isIdentityReply, isPlainObject,
  notAvailable, permit, validConsentScopes,
} from './HostDispatch.js';
import { HostSession, SUPERSEDED } from './HostSession.js';
import * as Permissions from './Permissions.js';
import { isLocalOrigin, isOrigin, matchesOrigin } from './origins.js';
import {
  CONNECTION_STATE, HOST_ERRORS, MSG, POPUP_MSG, PROTOCOL_VERSION, assertNoHostLeak, parseAppMessage, toParent,
} from './protocol.js';

/**
 * @typedef {object} HostConfig
 * @property {string} hostOrigin The origin this host page is served from.
 * @property {string} [master] The master API host.
 * @property {string[]} [signInOrigins] Origins the sign-in popup may report from (a dev build adds
 *   {@link DEV_SIGN_IN_ORIGINS}). Empty allows nobody.
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

/** The sign-in origins a dev build accepts besides `config.signInOrigins`: the Valu Social dev server. */
export const DEV_SIGN_IN_ORIGINS = Object.freeze(['http://localhost:3005']);

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
  #makeServices;
  #makeGuru;
  #makeGrants;
  #commerce;
  #permissions;
  #fetch;

  #sessionStore;
  /** Where a sign-in token may come from: `config.signInOrigins`, plus the dev origin in a dev build. */
  #signInOrigins;
  /** Stops listening to the session store. */
  #unsubscribeStore = null;

  #listening = false;
  #stopped = false;
  /** Hellos run one at a time; this is the tail of the line. */
  #queue = Promise.resolve();
  /** @type {{origin: string, app: import('./AppResolver.js').ResolvedApp}|null} */
  #bound = null;
  /** `api:ready` has gone out: the host serves the app. */
  #ready = false;
  /** The master connection and who the user is. */
  #session;
  /** The `connection` state the app was last told (or assumed from `api:ready`). */
  #announced = CONNECTION_STATE.SIGNED_OUT;
  /** Bumped whenever a session is dropped, so a sign-in that was waiting on the network can tell it was overtaken. */
  #epoch = 0;
  /** Changes of who is signed in (a token, another tab) run one at a time; this is the tail of the line. */
  #sessionLine = Promise.resolve();
  /** Requests running now, each with what settles it early: `{expire}`. */
  #running = new Set();
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
   * @param {{restore: Function, redeem: Function, signOut: Function}} options.auth A `HostAuth`. `redeem` is
   *   what the sign-in token channel needs; the bridge answers `unavailable` to a token when it is missing.
   * @param {{onChange: (handler: () => void) => (() => void), load?: () => object|null}} [options.sessionStore]
   *   A `SessionStore`: `onChange` is how another tab's sign-out or sign-in arrives, `load` says what is
   *   stored. The page wiring (Task 12) feeds `onChange` from the browser's `storage` event and must treat an
   *   event whose `key` is `null` (another tab's `localStorage.clear()`) as a change too, as well as the
   *   session record's own key. A store without `load` is never acted on.
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
    this.#fetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    this.#makeServices = makeServices ?? defaultMakeServices(this.#fetch);
    this.#makeGuru = makeGuru ?? defaultMakeGuru;
    this.#makeGrants = makeGrants ?? defaultMakeGrants;
    this.#commerce = commerce;
    this.#permissions = permissions;
    this.#config = normalizeConfig(config);
    this.#logger = log;
    this.#signInOrigins = new Set(
      [...this.#config.signInOrigins, ...(this.#config.dev ? DEV_SIGN_IN_ORIGINS : [])].filter(isOrigin),
    );
    this.#session = new HostSession({
      makeConnection,
      log: (level, message) => this.#log(level, message),
      online: () => this.#win.navigator?.onLine !== false,
      onState: (state) => this.#pushConnection(state),
      onReconnected: ({ changed }) => this.#onReconnected(changed),
      onExpired: () => this.#sessionExpired(),
    });
    this.#seams = Object.freeze({
      permissions,
      commerce,
      signedIn: () => this.#session.signedIn,
      callTimeoutMs: this.#config.callTimeoutMs,
      app: () => this.#bound.app,
      services: () => this.#servicesFor(),
      grants: () => this.#grantsFor(),
      guru: () => this.#guruFor(),
      user: () => this.#session.masterUser,
      networkId: () => this.#session.networkId(),
      emit: (ns, data) => this.#session.connection.emit(ns, data),
      subscribed: () => this.#subscribed,
      setSubscribed: (events) => { this.#subscribed = events; },
      log: (level, message) => this.#log(level, message),
    });
  }

  /**
   * Who the host is bound to and what it knows of the user: `connection` is the
   * state the app is told (`ready`, `reconnecting`, `offline`, `signed_out`) and
   * `lastError` why the link is down or the session ended, as `{code, message}`
   * with a fixed message, or null. For tests and the consent page.
   */
  get state() {
    return {
      bound: this.#bound ? { ...this.#bound } : null,
      signedIn: this.#session.signedIn,
      ...this.#session.identity(),
      connection: this.#session.state,
      lastError: this.#session.lastError,
    };
  }

  /** Start listening. Safe to call twice; a stopped bridge does not start again. */
  start() {
    if (this.#stopped) throw new Error('a stopped HostBridge cannot be started again');
    if (this.#listening) return this;
    this.#win.addEventListener('message', this.#onMessage);
    this.#win.addEventListener('online', this.#onNetwork);
    this.#win.addEventListener('offline', this.#onNetwork);
    this.#listening = true;
    const unsubscribe = this.#sessionStore?.onChange?.(() => this.#onStoreChange());
    this.#unsubscribeStore = typeof unsubscribe === 'function' ? unsubscribe : null;
    this.#exposeConsent();
    return this;
  }

  /** Stop listening and close what the bridge opened. Idempotent; never rejects. */
  async stop() {
    this.#stopped = true;
    if (this.#listening) {
      this.#win.removeEventListener('message', this.#onMessage);
      this.#win.removeEventListener('online', this.#onNetwork);
      this.#win.removeEventListener('offline', this.#onNetwork);
      this.#listening = false;
    }
    this.#ready = false;
    this.#unsubscribeStore?.();
    this.#unsubscribeStore = null;
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
   * @param {string} [reason] Why, when the push has one the app should see. `signedIn` is
   *   always the state now, so a reason that changes nothing (a cancelled popup for a user
   *   who is signed in) arrives with `signedIn:true`.
   */
  pushAuth(reason) {
    if (!this.#ready) return;
    this.#post(MSG.TRIGGER, {
      action: 'auth',
      data: { signedIn: this.#session.signedIn, ...this.#session.identity(), ...(text(reason) ? { reason } : {}) },
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

  /**
   * Tell the app the state of the host's link to the platform: `api:trigger
   * connection {state}`, `state` one of {@link CONNECTION_STATE}. A state the
   * app was told already is not told again, except with `extra` (the reconnect
   * notice, which is news even when the state is the same).
   * @param {string} [state] Default: the session's.
   * @param {object} [extra]
   */
  #pushConnection(state = this.#session.state, extra) {
    if (!this.#ready || (!extra && state === this.#announced)) return;
    this.#announced = state;
    this.#post(MSG.TRIGGER, { action: 'connection', data: { state, ...extra } });
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
      if (isPlainObject(data) && data.type === POPUP_MSG.TOKEN) {
        this.#onToken(event);
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

  /**
   * The browser's `online` / `offline`: the session tells the app (`offline`, or
   * what the master's state makes of it) and, when the network is back, retries a
   * master that was waiting.
   */
  #onNetwork = () => {
    try {
      if (!this.#stopped) this.#session.networkChanged();
    } catch (error) {
      this.#log('error', `a network change could not be handled (${error?.name ?? 'error'})`);
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
    this.#pushConnection();
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
    // What answers the request early when the master refuses the session: a request that
    // waits on a dead session must not wait out its timeout to be told so.
    const held = { expire: null };
    const expired = new Promise((resolve) => { held.expire = () => resolve(kind.signInRequired); });
    this.#running.add(held);
    let answer;
    try {
      answer = await orAfter(Promise.race([work(track), expired]), this.#config.callTimeoutMs, TIMED_OUT, this.#timers);
      if (answer === TIMED_OUT) answer = track.wrote && kind.timeoutAfterWrite ? kind.timeoutAfterWrite : kind.timeout;
    } catch (error) {
      this.#log('error', `a request failed (${error?.code ?? error?.name ?? 'error'})`);
      answer = kind.failed;
    } finally {
      this.#inFlight -= 1;
      this.#running.delete(held);
      track.abandoned = true;
    }
    this.#post(kind.reply, answer, id);
  }

  /** The SDK's service functions over this session's master, built on first use. */
  #servicesFor() {
    this.#services ??= this.#makeServices(this.#session.connection, this.#bound.app);
    return this.#services;
  }

  // --- Valu Guru -----------------------------------------------------------

  /** The Guru client for this session, with the grants over it: made on first need, closed on sign-out. */
  #guruFor() {
    if (this.#guru) return this.#guru;
    if (!this.#session.signedIn || !this.#bound) throw new Error('not signed in');
    const { app } = this.#bound;
    const guru = this.#makeGuru({ mintToken: () => this.#mintGuruToken(), getNetworkId: () => this.#networkId() }, app);
    let grants;
    try {
      grants = this.#makeGrants(guru, app);
      guru.onCommerceEvent?.((frame) => this.#onCommerceFrame(guru, frame));
      // A mint the master refuses leaves the client `reconnecting` with `lastError.code`
      // `session_expired`: the master has ended the session, so the host does too.
      guru.onStateChange?.(() => {
        if (this.#guru === guru && guru.lastError?.code === HOST_ERRORS.SESSION_EXPIRED) this.#sessionExpired();
      });
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
    return this.#session.networkId();
  }

  /**
   * A one-time token for the Guru socket, minted with the host's session. A
   * token works once, so the client asks again for every connect attempt. A
   * refused session rejects `session_expired`; nothing here carries the session
   * into a message.
   */
  async #mintGuruToken() {
    const sessionId = this.#session.sessionId;
    const epoch = this.#epoch;
    if (!sessionId) throw Object.assign(new Error('no session to mint a token with'), { code: HOST_ERRORS.SIGN_IN_REQUIRED });
    if (typeof this.#fetch !== 'function') throw new Error('no fetch to mint a token with');
    const networkId = this.#networkId();
    const response = await this.#fetch(`https://${this.#config.master}/api/v1/auth/getOneTimeAuthToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId, ...(networkId ? { 'X-Network': networkId } : {}) },
      body: '{}',
    });
    const body = await response.json();
    // The master signals a refused session in the body (HTTP 200). The Guru client only
    // sees that its state stays `reconnecting` when this is not its first failure, so the
    // session ends here, where it is known.
    if (body?.error?.code === 401) {
      // Only the session that asked: a mint that was in flight when the user signed out and
      // in again is about a session that is gone, and says nothing about the new one.
      if (epoch === this.#epoch) this.#sessionExpired();
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
    if (!this.#session.signedIn) return refuse(HOST_ERRORS.SIGN_IN_REQUIRED);
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
    const failure = await this.#restoreSession(app);
    if (this.#stopped) return;
    this.#ready = true;
    this.#sendReady();
    // A stored session the master refused at connect: say why, not only "signed out".
    if (failure === HOST_ERRORS.SESSION_EXPIRED) this.pushAuth(HOST_ERRORS.SESSION_EXPIRED);
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
    const stored = await this.#storedSession(app);
    if (this.#stopped || !text(stored?.sessionId)) return null;
    return this.#openMaster(stored.sessionId);
  }

  /** What `auth.restore` finds for this app, within `restoreTimeoutMs`; null when nothing, or it failed. */
  async #storedSession(app) {
    try {
      return await orAfter(this.#auth.restore({ homeNetworkId: app.homeNetworkId }), this.#config.restoreTimeoutMs);
    } catch (error) {
      this.#log('warn', `the stored session could not be checked (${error?.code ?? error?.name ?? 'error'})`);
      return null;
    }
  }

  /**
   * Connect the master for a session. Answers `null` once the user is signed
   * in, else why not (`session_expired`, `unavailable`, or `SUPERSEDED` when
   * the session was dropped meanwhile). A session the master refuses is forgotten.
   */
  async #openMaster(sessionId) {
    const failure = await this.#session.open(sessionId);
    if (failure === HOST_ERRORS.SESSION_EXPIRED && !this.#stopped) this.#forgetSession(sessionId);
    return failure;
  }

  /**
   * Is `sessionId` in storage? `null` when the store cannot say (it has no `load`).
   * @returns {boolean|null}
   */
  #holds(sessionId) {
    if (typeof this.#sessionStore?.load !== 'function') return null;
    const record = this.#sessionStore.load();
    return Object.values(record?.sessions ?? {}).some((entry) => entry?.sessionId === sessionId);
  }

  /**
   * Clear the stored session. Given the `sessionId` that ended, only when storage
   * still holds that session (as `HostAuth.restore` does): another tab may have
   * signed in since, and its record is not ours to clear. A store that cannot say,
   * and an explicit sign-out (no id), clear.
   * @param {string|null} [sessionId]
   */
  #forgetSession(sessionId = null) {
    try {
      if (sessionId !== null && this.#holds(sessionId) === false) return;
      this.#auth.signOut();
    } catch (error) {
      this.#log('warn', `the stored session could not be cleared (${error?.name ?? 'error'})`);
    }
  }

  /**
   * Close the master connection and the guru client, forget who the user was
   * and what was held for them: the grants cache, the Commerce subscriptions,
   * the consent requests (their apps are told they are over). A sign-in that
   * is waiting on the network sees the epoch move and stands down.
   * @param {string|null} [why] `session_expired`: the session ended because the master refused it.
   */
  #dropSession(why = null) {
    const guru = this.#guru;
    const grants = this.#grants;
    this.#epoch += 1;
    const closing = this.#session.drop(why);
    this.#guru = null;
    this.#grants = null;
    this.#services = null;
    this.#subscribed = new Set();
    this.#cartSeq += 1;
    this.#settleConsents(HOST_ERRORS.SIGN_IN_REQUIRED);
    // After the state is gone, and guarded: a cache that will not clear must not
    // keep the session alive or stop the sign-out from being answered.
    try {
      grants?.invalidate?.();
    } catch (error) {
      this.#log('warn', `the grants cache could not be dropped (${error?.name ?? 'error'})`);
    }
    return Promise.all([closing, guru && this.#closeQuietly(guru)]);
  }

  async #closeQuietly(closable) {
    try {
      await closable.close?.();
    } catch (error) {
      this.#log('warn', `a connection did not close cleanly (${error?.name ?? 'error'})`);
    }
  }

  /**
   * The master refused the session, as the master connection or Valu Guru
   * found out: it is over. Sign the user out as a sign-out would, answer every
   * request still waiting `sign_in_required`, and tell the app why.
   */
  #sessionExpired() {
    if (this.#stopped || !this.#session.signedIn) return;
    this.#forgetSession(this.#session.sessionId);
    void this.#dropSession(HOST_ERRORS.SESSION_EXPIRED);
    for (const held of [...this.#running]) held.expire();
    this.pushAuth(HOST_ERRORS.SESSION_EXPIRED);
    this.#pushConnection();
  }

  /**
   * The master came back after a drop. What was cached about the user's
   * permissions may be stale (the grants are read again), and `user_info` may
   * name another user or network (the app is told). The services stay: they run
   * over the connection's stable socket, which followed it across the
   * replacement; so do the Guru client and the Commerce subscription, which
   * reconnect on their own.
   */
  #onReconnected(changed) {
    try {
      this.#grants?.invalidate?.();
    } catch (error) {
      this.#log('warn', `the grants cache could not be dropped (${error?.name ?? 'error'})`);
    }
    if (changed) this.pushAuth();
    this.#pushConnection(CONNECTION_STATE.READY, { reconnected: true });
  }

  // --- signing in ----------------------------------------------------------

  /** Run `task` after every earlier change of who is signed in; a failure is logged, never thrown. */
  #inSessionLine(task) {
    this.#sessionLine = this.#sessionLine.then(task).catch((error) => {
      this.#log('error', `a session change failed (${error?.name ?? 'error'})`);
    });
  }

  /**
   * A `valu-host:token` message: from a Valu sign-in origin, and never from the
   * window that frames the host (the app page cannot be the sign-in page,
   * whatever origin it claims: the origin is the browser's). Taken only once the
   * app has been told the host is ready.
   */
  #onToken(event) {
    if (!this.#signInOrigins.has(event.origin) || event.source === this.#win.parent) return;
    if (!this.#ready) return;
    const { data } = event;
    this.#inSessionLine(() => this.#signInWith(data));
  }

  /**
   * What a token message says. `cancelled` and a token for another master are
   * pushed as their reason; a token is redeemed for a session (a user who is
   * signed in is signed out first), the master is opened with it, and the app is
   * told. A refusal is pushed as its reason. Nothing here holds the token longer
   * than the redeem, and nothing logs or posts it.
   */
  async #signInWith(data) {
    if (this.#stopped) return;
    if (data.cancelled === true) {
      this.pushAuth(HOST_ERRORS.CANCELLED);
      return;
    }
    if (data.master !== this.#config.master) {
      this.pushAuth(HOST_ERRORS.MASTER_MISMATCH);
      return;
    }

    const { app } = this.#bound;
    if (this.#session.signedIn) {
      this.#forgetSession();
      void this.#dropSession();
    }
    const epoch = this.#epoch;

    let redeemed;
    try {
      if (typeof this.#auth.redeem !== 'function') throw new TypeError('no redeem');
      redeemed = await this.#auth.redeem(data.token, { homeNetworkId: app.homeNetworkId ?? undefined });
      if (!text(redeemed?.sessionId)) throw new TypeError('no session');
    } catch (error) {
      this.#signInFailed(error?.code, 'a sign-in token could not be redeemed');
      return;
    }
    if (this.#stopped) return;
    if (epoch !== this.#epoch) {
      // The user signed out while the master was asked: the session just stored is not wanted.
      this.#forgetSession(redeemed.sessionId);
      return;
    }

    const failure = await this.#openMaster(redeemed.sessionId);
    if (failure === SUPERSEDED || this.#stopped) return;
    if (failure !== null) {
      this.#signInFailed(failure);
      return;
    }
    this.pushAuth();
    this.#pushConnection();
  }

  /**
   * A sign-in did not come up: the app is told why. A code the host does not
   * know is "unavailable", and what is logged is that reason, never the raw
   * code or the error's message.
   * @param {unknown} code
   * @param {string} [what] Logged with the reason, when the failure is worth a line.
   */
  #signInFailed(code, what) {
    const reasons = [
      HOST_ERRORS.NOT_A_MEMBER, HOST_ERRORS.INVALID_TOKEN, HOST_ERRORS.SESSION_EXPIRED, HOST_ERRORS.UNAVAILABLE,
    ];
    const reason = reasons.includes(code) ? code : HOST_ERRORS.UNAVAILABLE;
    if (what) this.#log('warn', `${what} (${reason})`);
    this.pushAuth(reason);
    this.#pushConnection();
  }

  /**
   * Another tab changed the stored session (the page calls this through
   * `sessionStore.onChange`, for the browser's `storage` event). A user who is
   * signed in here stays so while their session is still in storage. When it
   * is gone (the other tab signed out) or has been replaced, this tab lets it
   * go and takes what storage holds now, if the master still accepts it. The
   * stored record is not touched: it is whatever the other tab left, and
   * clearing it would sign them out.
   */
  #onStoreChange() {
    this.#inSessionLine(() => this.#syncWithStore());
  }

  async #syncWithStore() {
    if (this.#stopped || !this.#ready || !this.#session.signedIn) return;
    // Still stored (or the store cannot say): nothing changed for this tab.
    if (this.#holds(this.#session.sessionId) !== false) return;

    void this.#dropSession();
    const epoch = this.#epoch;
    const replacement = await this.#storedSession(this.#bound.app);
    if (this.#stopped || epoch !== this.#epoch) return;
    const failure = text(replacement?.sessionId) ? await this.#openMaster(replacement.sessionId) : HOST_ERRORS.SIGNED_OUT_ELSEWHERE;
    if (failure === SUPERSEDED || this.#stopped) return;
    this.pushAuth(failure === null ? undefined : HOST_ERRORS.SIGNED_OUT_ELSEWHERE);
    this.#pushConnection();
  }

  // --- sending -------------------------------------------------------------

  #sendReady() {
    // What the app assumes of the link from what `api:ready` says of the user.
    this.#announced = this.#session.signedIn ? CONNECTION_STATE.READY : CONNECTION_STATE.SIGNED_OUT;
    this.#post(MSG.READY, {
      applicationId: this.#bound.app.address,
      action: 'start',
      params: {},
      host: {
        protocol: PROTOCOL_VERSION, mode: 'dedicated', signedIn: this.#session.signedIn, ...this.#session.identity(),
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
