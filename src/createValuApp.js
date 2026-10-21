// ===========================================================================
// createValuApp — the one entry point an app uses (spec §4.8).
//
//   const valu = await createValuApp();
//   await valu.auth.signIn();                 // from a click
//   const me = await valu.data.Users.current();
//
// One object that carries both halves of the package: the bridge (`ValuApi`:
// intents, Commerce events) and the service functions (`valu.Users.current()`),
// plus `auth`, `network` and `connection`.
//
// Two modes. DEDICATED is a top-level page (or `?valu-mode=dedicated`, or the
// `mode` option): the page injects the host iframe (`HostTransport`), the user
// signs in through a popup, and every service function goes to the host, which
// checks the grants. EMBEDDED is a page inside Valu Social: the parent's
// `api:ready` is awaited as it always was (`valu.ready`, no timeout), the bridge
// is the one `ValuApi` has, and nothing else changes: `auth.signIn()`,
// `signOut()` and `requestConsent()` reject `not_available`, and the service
// tree answers 501.
//
// The popups. A browser lets a page open a window only from a user gesture, so
// `signIn()` and `requestConsent()` call `popup(...)` before they do anything
// else, in the call's own turn, and say `popup_blocked` when they get `null`.
// The URLs are built from the two configured origins and a random nonce, never
// from anything the host says.
//
// What the host never tells the page is whether a sign-in popup that closed was
// cancelled or is being redeemed: the sign-in page posts its token and closes at
// once, and the host then takes seconds to redeem it and connect. So a closed
// popup is `cancelled` only once nothing has followed it for CLOSED_GRACE_MS.
// (The Cancel button does not need the wait: the page posts `cancelled`, and
// the host pushes it within a few milliseconds.)
//
// Consent. A call the host refuses `consent_required` is, when the page is
// inside a user gesture (`navigator.userActivation.isActive`), put through the
// consent dialog and repeated ONCE; otherwise the refusal is the answer and the
// app asks from its own click with `auth.requestConsent([scope])`. The retry
// lives under the service client (a transport wrapper), so `valu.X.y()`,
// `valu.data.X.y()` and calls by name all get it.
// ===========================================================================
import { ValuApi } from './ValuApi.js';
import { Transport } from './transport/Transport.js';
import { HostTransport } from './transport/HostTransport.js';
import { PostMessageTransport } from './transport/PostMessageTransport.js';
import { createValuServices } from './services/api.js';
import { ERROR_CODES, errorAck } from './Errors.js';
import { CONNECTION_STATE, HOST_ERRORS, MSG } from './host/protocol.js';
import { isOrigin } from './host/origins.js';

const DEFAULT_HOST_ORIGIN = 'https://valuguru.texpo.io';
const DEFAULT_SIGN_IN_ORIGIN = 'https://live.valuverse.io';
const POPUP_FEATURES = 'popup,width=480,height=640';
/** How often an open popup is asked whether it was closed. */
const POLL_MS = 500;
/** How long a closed popup is given to be followed by its result before it counts as abandoned. */
const CLOSED_GRACE_MS = 10_000;
/** How long a sign-in may take (spec §4.4: five minutes). */
const SIGN_IN_TIMEOUT_MS = 300_000;
const MODES = ['dedicated', 'embedded'];
/**
 * The `reason`s of an auth push that end a sign-in without a user. `session_expired`
 * is one only while a sign-in waits: the session the host held ended under it.
 */
const SIGN_IN_FAILURES = new Set([
  HOST_ERRORS.MASTER_MISMATCH, HOST_ERRORS.NOT_A_MEMBER, HOST_ERRORS.INVALID_TOKEN, HOST_ERRORS.UNAVAILABLE,
  HOST_ERRORS.SESSION_EXPIRED,
]);
const CLOSED = 'closed';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** An Error that carries the code the app switches on. */
const codedError = (code, message = code) => Object.assign(new Error(message), { code });
const notAvailable = (what) => codedError(HOST_ERRORS.NOT_AVAILABLE, `${what} is available in dedicated mode only`);
const popupBlocked = (what) => codedError(HOST_ERRORS.POPUP_BLOCKED, `the browser blocked the ${what} window: call it from a click`);
const closedError = () => codedError(CLOSED, 'the app was closed');

/** Dedicated when the page is top-level or asks for it; embedded when it is framed. */
function modeOf(mode, win) {
  if (mode !== undefined) {
    if (!MODES.includes(mode)) throw new TypeError(`createValuApp mode must be "dedicated" or "embedded", not ${String(mode)}`);
    return mode;
  }
  let query;
  try {
    query = new URLSearchParams(win.location?.search ?? '');
  } catch {
    query = new URLSearchParams();
  }
  if (query.get('valu-mode') === 'dedicated') return 'dedicated';
  return win.parent === win ? 'dedicated' : 'embedded';
}

/** 128 random bits, hex: what ties the consent popup to the request the host holds for it. */
function randomNonce(win) {
  const crypto = win?.crypto ?? globalThis.crypto;
  if (typeof crypto?.getRandomValues !== 'function') throw new Error('createValuApp needs crypto.getRandomValues for the consent nonce');
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const validScopes = (scopes) => Array.isArray(scopes) && scopes.length > 0
  && scopes.every((scope) => typeof scope === 'string' && scope !== '');

const isClosed = (win) => {
  try { return win.closed === true; } catch { return true; }
};
const closeQuietly = (win) => {
  try { win.close?.(); } catch { /* a window that will not close is the user's now */ }
};

/** A set of `change` handlers. A handler that throws is reported, and the others still run. */
function changeEmitter(label) {
  const handlers = new Set();
  return {
    on(name, handler) {
      if (name !== 'change') throw new TypeError(`${label}.on: "change" is the only event, not "${String(name)}"`);
      if (typeof handler !== 'function') throw new TypeError(`${label}.on needs a handler function`);
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    emit(value) {
      for (const handler of [...handlers]) {
        try {
          handler(value);
        } catch (error) {
          console.error(`${label}: a "change" listener threw:`, error);
        }
      }
    },
    clear() { handlers.clear(); },
  };
}

/** The scope of a `consent_required` ack, or `null` when the ack is anything else. */
function consentScopeOf(ack) {
  const error = ack?.error;
  const scope = error?.scope;
  const asked = error?.code === ERROR_CODES.FORBIDDEN && error.message === HOST_ERRORS.CONSENT_REQUIRED;
  return asked && typeof scope === 'string' && scope !== '' ? scope : null;
}

/**
 * The service transport of a dedicated app: the host transport, and after a
 * call the host refused for consent that `consent(scope)` got the user to give,
 * the same call once more. The refusal never executed anything, so repeating a
 * write is safe. Never rejects, as no service transport does.
 */
class ConsentRetryTransport extends Transport {
  #inner;
  #consent;

  /** @param {Transport} inner @param {(scope: string) => Promise<boolean>} consent Never rejects. */
  constructor(inner, consent) {
    super();
    this.#inner = inner;
    this.#consent = consent;
  }

  get connected() { return this.#inner.connected; }
  get servesServiceFunctions() { return true; }
  get applicationId() { return this.#inner.applicationId; }
  subscribe(event, handler) { return this.#inner.subscribe(event, handler); }
  close() { return this.#inner.close(); }

  async callService(descriptor, params, options) {
    const ack = await this.#inner.callService(descriptor, params, options);
    const scope = consentScopeOf(ack);
    if (scope === null || !(await this.#consent(scope))) return ack;
    return this.#inner.callService(descriptor, params, options);
  }
}

/** The service transport of an embedded app: it serves nothing, and says so (501), which no retry policy repeats. */
class UnservedTransport extends Transport {
  get servesServiceFunctions() { return true; }

  async callService(descriptor) {
    return errorAck(
      ERROR_CODES.UNSUPPORTED,
      `${descriptor.key} is not available in embedded mode: the embedding application serves intents (callService), not service functions`,
    );
  }
}

class ValuApp {
  #mode;
  #hostOrigin;
  #signInOrigin;
  #win;
  #popup;
  #setTimer;
  #clearTimer;
  /** The bridge's transport: the host iframe, or the parent window. */
  #transport;
  #bridge;
  #services;
  #unsubscribe = [];
  #authChanges = changeEmitter('auth');
  #connectionChanges = changeEmitter('connection');
  /** The `reason` of the last auth push, while it is the last. */
  #authReason;
  /** `{code}` from the last connection push that had a reason; cleared when the link is back. */
  #connectionError = null;
  #embeddedReady = false;
  #resolveReady;
  #ready;
  /** The sign-in in progress: `{win, promise, succeed, fail}`. */
  #signIn = null;
  /** The consent dialogs open, by their scopes: sorted, space-joined. */
  #consents = new Map();
  /** The popups this app opened whose flow has not ended: `close()` closes them. */
  #popups = new Set();
  #closed = false;

  /**
   * @param {object} parts
   * @param {'dedicated'|'embedded'} parts.mode
   * @param {Transport} parts.transport HostTransport or PostMessageTransport, not yet opened.
   */
  constructor({ mode, transport, hostOrigin, signInOrigin, win, popup, setTimer, clearTimer }) {
    this.#mode = mode;
    this.#transport = transport;
    this.#hostOrigin = hostOrigin;
    this.#signInOrigin = signInOrigin;
    this.#win = win;
    this.#popup = popup;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;

    // Before the host is opened: the bridge hears `api:ready` (the launch intent
    // reaches an application registered later), and so does `ready`.
    this.#bridge = new ValuApi({ transport });
    const dedicated = mode === 'dedicated';
    if (dedicated) {
      this.#ready = Promise.resolve();
      this.#unsubscribe.push(transport.subscribe(Transport.TRIGGER, (message) => this.#onTrigger(message)));
    } else {
      this.#ready = new Promise((resolve) => { this.#resolveReady = resolve; });
      this.#unsubscribe.push(transport.subscribe(Transport.READY, () => this.#onEmbeddedReady()));
    }
    this.#services = createValuServices({
      transport: dedicated
        ? new ConsentRetryTransport(transport, (scope) => this.#consentFor(scope))
        : new UnservedTransport(),
    });

    const readAuth = () => this.#authState();
    this.auth = Object.freeze({
      get state() { return readAuth(); },
      signIn: () => this.#startSignIn(),
      signOut: () => this.#signOut(),
      requestConsent: (scopes) => this.#requestConsent(scopes),
      on: (name, handler) => this.#authChanges.on(name, handler),
    });
    const readConnection = () => ({ state: this.#connectionState(), lastError: this.#lastError() });
    this.connection = Object.freeze({
      get state() { return readConnection().state; },
      get lastError() { return readConnection().lastError; },
      on: (name, handler) => this.#connectionChanges.on(name, handler),
    });

    for (const [name, namespace] of Object.entries(this.#services)) {
      if (name in this) throw new Error(`the service "${name}" has the name of a member of the app`);
      this[name] = namespace;
    }
  }

  /** `'dedicated'` or `'embedded'`. */
  get mode() { return this.#mode; }

  /** Resolves when the host is there: at once in dedicated mode, on the parent's `api:ready` when embedded. */
  get ready() { return this.#ready; }

  /** `{id, name}` of the network the host runs in, or `null`. */
  get network() { return this.#authState().network; }

  /** The service functions with the envelope unwrapped: `valu.data.Users.current()` resolves the payload and throws. */
  get data() { return this.#services.data; }

  /** The `ValuApi` underneath, for what is not copied onto this object: `setApplication`, `getApi`, `runConsoleCommand`, `pushRoute`. */
  get bridge() { return this.#bridge; }

  // --- the bridge ----------------------------------------------------------

  callService(intent) { return this.#bridge.callService(intent); }
  sendIntent(intent) { return this.#bridge.sendIntent(intent); }

  /** Listen for Commerce events (`ValuApi.ON_COMMERCE`). Returns the way to stop. */
  onCommerceEvent(handler) {
    if (typeof handler !== 'function') throw new TypeError('onCommerceEvent needs a handler function');
    this.#bridge.addEventListener(ValuApi.ON_COMMERCE, handler);
    return () => { this.#bridge.removeEventListener(ValuApi.ON_COMMERCE, handler); };
  }

  addEventListener = (...parameters) => this.#bridge.addEventListener(...parameters);
  removeEventListener = (...parameters) => this.#bridge.removeEventListener(...parameters);

  /**
   * Stop: fail what is waiting, drop the caches, take the host iframe (or the
   * window listener) away. Idempotent.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const win of this.#popups) closeQuietly(win);
    this.#popups.clear();
    this.#signIn?.fail(closedError());
    for (const off of this.#unsubscribe) off();
    this.#authChanges.clear();
    this.#connectionChanges.clear();
    await this.#services.close();
    await this.#transport.close();
  }

  // --- what the host says --------------------------------------------------

  #authState() {
    const host = this.#transport.hostState;
    return {
      signedIn: host?.signedIn === true,
      user: host?.user ?? null,
      network: host?.network ?? null,
      ...(this.#authReason ? { reason: this.#authReason } : {}),
    };
  }

  #connectionState() {
    return this.#transport.connectionState ?? (this.#embeddedReady ? CONNECTION_STATE.READY : CONNECTION_STATE.CONNECTING);
  }

  #lastError() { return this.#connectionError && { ...this.#connectionError }; }

  /** An `api:trigger` of the host. HostTransport has already applied it to its state. */
  #onTrigger(message) {
    const { action, data } = message ?? {};
    if (!isPlainObject(data)) return;
    if (action === 'auth') {
      this.#authReason = typeof data.reason === 'string' ? data.reason : undefined;
      const state = this.#authState();
      this.#settleSignIn(data, state);
      this.#authChanges.emit(state);
    } else if (action === 'connection' && typeof data.state === 'string') {
      if (typeof data.reason === 'string') this.#connectionError = { code: data.reason };
      else if (data.state === CONNECTION_STATE.READY || data.state === CONNECTION_STATE.SIGNED_OUT) this.#connectionError = null;
      this.#connectionChanges.emit({
        state: this.#connectionState(),
        reconnected: data.reconnected === true,
        lastError: this.#lastError(),
      });
    }
  }

  /** Embedded: the parent's `api:ready`. A repeat is `onCreate` again, not a change of connection. */
  #onEmbeddedReady() {
    if (this.#embeddedReady) return;
    this.#embeddedReady = true;
    this.#resolveReady();
    this.#connectionChanges.emit({ state: CONNECTION_STATE.READY, reconnected: false, lastError: null });
  }

  // --- popups --------------------------------------------------------------

  /** `window.open`, now. `null` when the browser said no (or threw, as a sandboxed frame does). */
  #open(url, name) {
    let win = null;
    try {
      win = this.#popup(url, name, POPUP_FEATURES) ?? null;
    } catch {
      win = null;
    }
    if (win) this.#popups.add(win);
    return win;
  }

  /**
   * Close a popup the flow that opened it is done with and the page will not
   * close itself, unless something has closed it already (`close()` lets go of
   * every popup it closes): a popup is closed once.
   */
  #closeOwn(win) {
    if (this.#popups.delete(win)) closeQuietly(win);
  }

  /** A request to the host. One that fails because the app was closed says `closed`, as `signIn` does. */
  async #request(name, message) {
    try {
      return await this.#transport.request(name, message);
    } catch (error) {
      throw this.#closed ? closedError() : error;
    }
  }

  /**
   * Call `abandoned()` once `win` has been closed for CLOSED_GRACE_MS without
   * whatever it was opened for having finished. Returns the way to stop.
   */
  #watchClosed(win, abandoned) {
    let timer = null;
    const poll = () => {
      timer = this.#setTimer(() => {
        if (isClosed(win)) timer = this.#setTimer(abandoned, CLOSED_GRACE_MS);
        else poll();
      }, POLL_MS);
    };
    poll();
    return () => { this.#clearTimer(timer); };
  }

  // --- sign-in -------------------------------------------------------------

  /** `auth.signIn()`: the popup first, then the wait for the host's answer. */
  #startSignIn() {
    if (this.#mode !== 'dedicated') return Promise.reject(notAvailable('signIn'));
    if (this.#closed) return Promise.reject(closedError());
    // One at a time: opening the popup again would reload the page the user is on.
    if (this.#signIn) return this.#signIn.promise;

    const win = this.#open(`${this.#signInOrigin}/auth/host`, 'valu-signin');
    if (!win) return Promise.reject(popupBlocked('sign-in'));

    const record = { win, promise: null, succeed: null, fail: null };
    let deadline = null;
    let stopWatching = () => {};
    record.promise = new Promise((resolve, reject) => {
      const end = (settle, value) => {
        if (this.#signIn !== record) return;
        this.#signIn = null;
        this.#popups.delete(win);
        this.#clearTimer(deadline);
        stopWatching();
        settle(value);
      };
      record.succeed = (state) => end(resolve, state);
      record.fail = (error) => end(reject, error);
    });
    this.#signIn = record;
    stopWatching = this.#watchClosed(win, () => record.fail(codedError(HOST_ERRORS.CANCELLED, 'the sign-in window was closed')));
    deadline = this.#setTimer(() => {
      this.#closeOwn(win);
      record.fail(codedError(HOST_ERRORS.TIMEOUT, 'sign-in did not finish within five minutes'));
    }, SIGN_IN_TIMEOUT_MS);
    return record.promise;
  }

  /**
   * An auth push, for the sign-in waiting on one. The `reason` is read BEFORE
   * `signedIn`: a cancelled or mismatched sign-in changes nothing, so its push
   * carries the current `signedIn`, which is `true` for a user who was signed in.
   */
  #settleSignIn(data, state) {
    const record = this.#signIn;
    if (!record) return;
    const { reason } = data;
    // A sign-in that failed leaves nothing for its window to show (the page may
    // have closed itself already); one that succeeded is the page's to close.
    const failed = (error) => {
      this.#closeOwn(record.win);
      record.fail(error);
    };
    if (reason === HOST_ERRORS.CANCELLED) failed(codedError(HOST_ERRORS.CANCELLED, 'sign-in was cancelled'));
    else if (SIGN_IN_FAILURES.has(reason)) failed(codedError(reason, `sign-in failed: ${reason}`));
    else if (data.signedIn === true) record.succeed(state);
  }

  /** `auth.signOut()`: resolves when the host has finished. */
  async #signOut() {
    if (this.#mode !== 'dedicated') throw notAvailable('signOut');
    const reply = await this.#request(MSG.AUTH, { action: 'sign-out' });
    if (isPlainObject(reply?.error)) {
      const { code, message } = reply.error;
      throw codedError(typeof code === 'string' ? code : HOST_ERRORS.UNAVAILABLE, typeof message === 'string' ? message : undefined);
    }
  }

  // --- consent -------------------------------------------------------------

  /** `auth.requestConsent(scopes)`: the popup first, then the host's request. Resolves whether the user approved. */
  #requestConsent(scopes) {
    if (this.#mode !== 'dedicated') return Promise.reject(notAvailable('requestConsent'));
    if (this.#closed) return Promise.reject(closedError());
    if (!validScopes(scopes)) return Promise.reject(new TypeError('requestConsent needs a non-empty array of scope names'));
    // The same dialog is not opened twice: a named window would be reloaded under its nonce.
    const key = [...new Set(scopes)].sort().join(' ');
    const open = this.#consents.get(key);
    if (open) return open;

    let nonce;
    try {
      nonce = randomNonce(this.#win);
    } catch (error) {
      return Promise.reject(error);
    }
    const win = this.#open(`${this.#hostOrigin}/host/consent.html?nonce=${nonce}`, 'valu-consent');
    if (!win) return Promise.reject(popupBlocked('consent'));

    const asked = this.#askConsent(win, scopes, nonce);
    const entry = asked.finally(() => {
      if (this.#consents.get(key) === entry) this.#consents.delete(key);
    });
    this.#consents.set(key, entry);
    return entry;
  }

  /**
   * Post `host:consent` and wait for the decision; a popup closed with no decision
   * is a no. A decision made in the dialog leaves the popup to the page that made
   * it; every other end (the host refused before the dialog could matter, or the
   * request failed) leaves it with nothing to show, so it is closed here.
   */
  async #askConsent(win, scopes, nonce) {
    let stopWatching = () => {};
    try {
      const reply = await new Promise((resolve, reject) => {
        stopWatching = this.#watchClosed(win, () => resolve({ approved: false }));
        this.#request(MSG.CONSENT, { scopes: [...scopes], nonce }).then(resolve, reject);
      });
      if (typeof reply?.reason === 'string') this.#closeOwn(win);
      return reply?.approved === true;
    } catch (error) {
      this.#closeOwn(win);
      throw error;
    } finally {
      stopWatching();
      this.#popups.delete(win);
    }
  }

  /**
   * A call was refused for `scope`: did the user give it now? Never rejects.
   * Joins a dialog that is already open for the scope; opens one only from a
   * user gesture, and never beside another.
   */
  async #consentFor(scope) {
    try {
      const open = this.#consents.get(scope);
      if (open) return await open;
      if (this.#closed || this.#consents.size > 0 || this.#win.navigator?.userActivation?.isActive !== true) return false;
      return await this.#requestConsent([scope]);
    } catch {
      return false;
    }
  }
}

/**
 * Make the app's one object: open the host (dedicated) or start listening for
 * the parent (embedded).
 *
 * @param {object} [options]
 * @param {string} [options.hostOrigin] Where the host is served. Default `https://valuguru.texpo.io`.
 * @param {string} [options.signInOrigin] Where the sign-in page is, the Valu brand the app signs users in
 *   through. Default `https://live.valuverse.io`.
 * @param {string} [options.app] The app's address (`<workspace>/<slug>`), told to the host in
 *   `host:hello` (dedicated). A dev host serves a localhost page under it; a production host ignores it.
 * @param {'dedicated'|'embedded'} [options.mode] Default: dedicated for a top-level page or `?valu-mode=dedicated`,
 *   embedded for a framed one.
 * @param {Window} [options.window] The page's window.
 * @param {Document} [options.document] Where the host iframe goes (dedicated).
 * @param {(url: string, name: string, features: string) => (Window|null)} [options.popup]
 *   Opens a window. Default `window.open`.
 * @param {Function} [options.fetchImpl] `fetch` for the functions that run in the page (dedicated).
 * @param {import('./transport/Transport.js').Transport} [options.localTransport] Runs those functions instead (dedicated).
 * @param {Function} [options.setTimeout] Timers, for a test that turns the clock itself.
 * @param {Function} [options.clearTimeout]
 * @returns {Promise<ValuApp>} Dedicated: once the host has answered `api:ready`; it rejects with the
 *   `code` of why it could not (`host_unreachable`, `unknown_app`, `nested`, `bad_origin`,
 *   `protocol_unsupported`, `resolve_unavailable`). Embedded: at once.
 */
export async function createValuApp({
  hostOrigin = DEFAULT_HOST_ORIGIN,
  signInOrigin = DEFAULT_SIGN_IN_ORIGIN,
  app: appAddress,
  mode,
  window: win = globalThis,
  document: doc = globalThis.document,
  popup = (url, name, features) => win.open(url, name, features),
  fetchImpl,
  localTransport,
  setTimeout: setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: clearTimer = (id) => globalThis.clearTimeout(id),
} = {}) {
  for (const [name, value] of [['hostOrigin', hostOrigin], ['signInOrigin', signInOrigin]]) {
    if (!isOrigin(value)) {
      throw new TypeError(`createValuApp ${name} must be an origin such as "https://host.example": no path, no trailing slash`);
    }
  }
  const resolved = modeOf(mode, win);
  const dedicated = resolved === 'dedicated';
  const transport = dedicated
    ? new HostTransport({
      hostOrigin,
      app: appAddress,
      window: win,
      document: doc,
      fetchImpl,
      localTransport,
      setTimeout: setTimer,
      clearTimeout: clearTimer,
    })
    : new PostMessageTransport({ target: win });

  const app = new ValuApp({
    mode: resolved, transport, hostOrigin, signInOrigin, win, popup, setTimer, clearTimer,
  });
  // A failed handshake leaves nothing behind (HostTransport takes its iframe,
  // listener and timers away), so the app is simply dropped.
  if (dedicated) await transport.open();
  return app;
}
