// ===========================================================================
// The host iframe's message handler (spec §4.3, §4.5).
//
// The page that embeds a Workspaces app carries a hidden iframe on a Valu
// origin; this is what runs inside it. It binds to ONE parent origin, works out
// which app that is, restores the user's session, tells the app it is ready,
// and then answers everything the app asks. This file is the skeleton: the
// handshake, the binding, the nesting rule, the dispatch table, sign-out, ping
// and the pushes. `api:call` / `api:service-intent`, consent and the sign-in
// token channel are added on top of it.
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
// Where it answers:
//
//   - `win.parent.postMessage(msg, boundOrigin)`, never `'*'`. Before binding
//     (a refusal to a hello) it is the sender's own origin, and only when that
//     is a real `http(s)` origin: an opaque one (`'null'`) has no address.
//   - Every outbound payload passes `assertNoHostLeak` first; one that fails is
//     replaced by `{error:{code:'internal', message:'blocked outbound credential'}}`
//     and logged by key path, never by value.
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
import { ERROR_CODES, errorAck } from '../Errors.js';
import { displayNameOf } from '../socket/user-info.js';
import { RESOLVE_UNAVAILABLE } from './AppResolver.js';
import * as CommerceIntents from './CommerceIntents.js';
import * as Permissions from './Permissions.js';
import { isLocalOrigin, isOrigin, matchesOrigin } from './origins.js';
import {
  HOST_ERRORS, MSG, PROTOCOL_VERSION, assertNoHostLeak, parseAppMessage, toParent,
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
 * @property {number} [callTimeoutMs]
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
    restoreTimeoutMs: positive(given.restoreTimeoutMs, DEFAULT_CONFIG.restoreTimeoutMs),
    resolveTimeoutMs: positive(given.resolveTimeoutMs, DEFAULT_CONFIG.resolveTimeoutMs),
  });
}

/** `<workspace>/<slug>`. */
const CLAIM_RE = /^([\w-][\w.-]*)\/([\w-][\w.-]*)$/;

/** A request id the way a client writes it: a number, else none (a reply to nobody names no id). */
const idOf = (requestId) => (typeof requestId === 'number' && Number.isFinite(requestId) ? requestId : undefined);

/** The answer for something the host does not do. */
const notAvailable = (what) => ({
  error: { code: HOST_ERRORS.NOT_AVAILABLE, message: `${what} is not available through the valu-api host` },
});

/** App -> host names the host refuses, and the name each is answered under. */
const REFUSED = new Map([
  [MSG.RUN_INTENT, MSG.RUN_COMPLETED],
  [MSG.CREATE_POINTER, MSG.POINTER_CREATED],
  [MSG.RUN, MSG.RUN_COMPLETED],
  [MSG.RUN_CONSOLE, MSG.RUN_CONSOLE_COMPLETED],
]);

/** The default logger: warnings and errors to the console. A page passes its own. */
const consoleLog = (level, message) => {
  globalThis.console?.[level === 'error' ? 'error' : 'warn']?.(`[valu-host] ${message}`);
};

/** `promise`, or `fallback` once `ms` have passed. The timer never outlives the race. */
function orAfter(promise, ms, fallback = null) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** What a resolve that ran out of time answers, apart from `null` (the server said "no such app"). */
const RESOLVE_TIMED_OUT = Symbol('resolve timed out');

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

export class HostBridge {
  #win;
  #resolver;
  #auth;
  #config;
  #logger;
  #makeConnection;

  // Held for the tasks that build on this one: calls, consent, the sign-in channel.
  #sessionStore;
  #makeServices;
  #makeGuru;
  #makeGrants;
  #commerce;
  #permissions;

  #listening = false;
  #stopped = false;
  /** Hellos run one at a time; this is the tail of the line. */
  #queue = Promise.resolve();
  /** @type {{origin: string, app: import('./AppResolver.js').ResolvedApp}|null} */
  #bound = null;
  /** `api:ready` has gone out: the host serves the app. */
  #ready = false;
  #connection = null;
  #guru = null;
  #signedIn = false;
  #user = null;
  #network = null;

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
   * @param {(session: object, app: object) => object} [options.makeGuru] A `GuruClient`, made when first needed.
   * @param {(guru: object, app: object) => object} [options.makeGrants] A `GrantsStore`.
   * @param {object} [options.commerce] The Commerce intent table (default: the module).
   * @param {object} [options.permissions] The permission tiers (default: the module).
   * @param {HostConfig} options.config
   * @param {(level: 'warn'|'error', message: string) => void} [options.log]
   * @param {Function} [options.fetchImpl] A bound `fetch`, for the default `makeServices`.
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
    this.#makeServices = makeServices ?? defaultMakeServices(fetchImpl ?? globalThis.fetch?.bind(globalThis));
    this.#makeGuru = makeGuru;
    this.#makeGrants = makeGrants;
    this.#commerce = commerce;
    this.#permissions = permissions;
    this.#config = normalizeConfig(config);
    this.#logger = log;
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
    await this.#dropSession();
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
        this.#post(MSG.CALL_COMPLETED, errorAck(ERROR_CODES.UNSUPPORTED, HOST_ERRORS.NOT_AVAILABLE), id);
        return;
      case MSG.SERVICE_INTENT:
        this.#post(MSG.RUN_CONSOLE_COMPLETED, notAvailable(name), id);
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
        app = await orAfter(this.#resolver.resolve(origin), this.#config.resolveTimeoutMs, RESOLVE_TIMED_OUT);
      } catch (error) {
        this.#log('warn', `the app could not be resolved (${error?.code ?? RESOLVE_UNAVAILABLE})`);
        this.#post(MSG.ERROR, {
          code: RESOLVE_UNAVAILABLE, message: 'the app could not be looked up; try again',
        }, undefined, origin);
        return;
      }
      if (this.#stopped) return;
      if (app === RESOLVE_TIMED_OUT) {
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

  /** Close the master connection and the guru client, and forget who the user was. */
  #dropSession() {
    const closing = [this.#connection, this.#guru].filter(Boolean);
    this.#connection = null;
    this.#guru = null;
    this.#signedIn = false;
    this.#user = null;
    this.#network = null;
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
      payload = assertNoHostLeak(toParent(name, message, requestId), `outbound ${name}`);
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
