// ===========================================================================
// Fakes for the host iframe's world: the two windows it talks across, the
// storage it keeps a session in, the Valu Guru WebSocket, and the two HTTP
// endpoints it asks (resolve, auth). `fakes.js` has the SDK's own fakes; these
// are the ones only the host needs.
//
// Every fake is synchronous and records what it was asked, so a test can
// assert on the wire without a timer or a network.
// ===========================================================================

/** A DOMException-alike: the host catches by `name`, as it would in a browser. */
const domError = (name, message) => Object.assign(new Error(message), { name });

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * A `Storage` that holds strings, and fails on request the way a real one does:
 * Safari private windows and full quotas throw on `setItem`, blocked site data
 * throws on any access. `throwOn` can be set again mid-test.
 */
export class FakeStorage {
  #items = new Map();

  /** @param {{throwOn?: 'get'|'set'|null}} [options] */
  constructor({ throwOn = null } = {}) { this.throwOn = throwOn; }

  get length() { return this.#items.size; }

  key(index) { return [...this.#items.keys()][index] ?? null; }

  getItem(key) {
    if (this.throwOn === 'get') throw domError('SecurityError', 'The operation is insecure.');
    return this.#items.has(String(key)) ? this.#items.get(String(key)) : null;
  }

  setItem(key, value) {
    if (this.throwOn === 'set') throw domError('QuotaExceededError', 'The quota has been exceeded.');
    this.#items.set(String(key), String(value));
  }

  removeItem(key) { this.#items.delete(String(key)); }

  clear() { this.#items.clear(); }
}

// ---------------------------------------------------------------------------
// Valu Guru WebSocket
// ---------------------------------------------------------------------------

/**
 * A browser `WebSocket`, driven by the test.
 *
 * Nothing happens on its own: the test opens it, answers the requests it
 * recorded, and drops it. `sent` is every frame the client sent, parsed;
 * `sentRaw` is the same as the strings that went out.
 */
export class FakeGuruSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeGuruSocket.CONNECTING;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  sent = [];
  sentRaw = [];
  /** `{code, reason}` when the client closed it, else `null`. */
  closedWith = null;

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
  }

  /** The client sends. A real socket refuses while connecting, and drops silently once closed. */
  send(json) {
    if (this.readyState === FakeGuruSocket.CONNECTING) {
      throw domError('InvalidStateError', "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.");
    }
    if (this.readyState !== FakeGuruSocket.OPEN) return;
    this.sentRaw.push(json);
    this.sent.push(JSON.parse(json));
  }

  /** The client closes. */
  close(code = 1000, reason = '') {
    if (this.readyState === FakeGuruSocket.CLOSED) return;
    this.closedWith = { code, reason };
    this.#close({ code, reason, wasClean: true });
  }

  // ---- the test's side ----------------------------------------------------

  /** The handshake completed. */
  open() {
    this.readyState = FakeGuruSocket.OPEN;
    this.onopen?.({ type: 'open' });
    return this;
  }

  /** Deliver one server frame. */
  frame(obj) {
    this.onmessage?.({ type: 'message', data: JSON.stringify(obj) });
    return this;
  }

  /** Answer a `data_request`. */
  reply(requestId, { ok = true, data, error } = {}) {
    return this.frame({ type: 'data_response', requestId, ok, ...(ok ? { data } : { error }) });
  }

  /** Report progress on a `data_request`, which resets the client's silence timer. */
  progress(requestId, step) {
    return this.frame({ type: 'data_progress', requestId, step });
  }

  /** The transport went away under the client (1006: abnormal closure). */
  drop(code = 1006) {
    if (this.readyState === FakeGuruSocket.CLOSED) return this;
    this.#close({ code, reason: '', wasClean: false });
    return this;
  }

  #close({ code, reason, wasClean }) {
    this.readyState = FakeGuruSocket.CLOSED;
    this.onclose?.({ type: 'close', code, reason, wasClean });
  }
}

/**
 * A `WebSocket` constructor over {@link FakeGuruSocket}, recording what it was
 * asked for: `.urls`, `.sockets`, `.last`.
 *
 * `autoOpen` opens each socket on the next microtask — after the client has
 * wired its handlers — for a test that is not about the handshake. `onSocket`
 * runs as the socket is made.
 */
export function fakeGuruWebSocket({ autoOpen = false, onSocket } = {}) {
  class GuruWebSocket extends FakeGuruSocket {
    constructor(url, protocols) {
      super(url, protocols);
      GuruWebSocket.urls.push(url);
      GuruWebSocket.sockets.push(this);
      GuruWebSocket.last = this;
      onSocket?.(this);
      if (autoOpen) {
        queueMicrotask(() => { if (this.readyState === FakeGuruSocket.CONNECTING) this.open(); });
      }
    }
  }
  GuruWebSocket.urls = [];
  GuruWebSocket.sockets = [];
  GuruWebSocket.last = null;
  return GuruWebSocket;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * One side of a {@link FakeWindowPair}.
 *
 * `postMessage` has the browser's meaning: `X.postMessage(data, targetOrigin)`
 * is a message TO `X`, sent by whichever window is calling. In a pair that is
 * always the other side, so it arrives at `X`'s own listeners with the caller as
 * `source` and the caller's origin as `origin`. The host answers its parent with
 * `app.postMessage(...)` (`win.parent.postMessage`), the app page reaches the
 * host with `host.postMessage(...)` (`iframe.contentWindow.postMessage`).
 */
class FakePairWindow {
  listeners = new Set();
  /** Every `postMessage` call made ON this window (a message to it), delivered or not: `{data, targetOrigin}`. */
  posted = [];
  /** The ones that were not delivered, because `targetOrigin` named neither `'*'` nor this window's origin. */
  dropped = [];
  parent = this;
  top = this;
  frames = [];

  constructor(origin) { this.origin = origin; }

  /** @internal The other side, the caller of this window's `postMessage`; set by the pair. */
  peer = null;

  /** Listeners of every other event type (`online`, `offline`, …): type -> Set. `listeners` is `message` only. */
  windowListeners = new Map();

  addEventListener(type, listener) {
    if (type === 'message') {
      this.listeners.add(listener);
      return;
    }
    if (!this.windowListeners.has(type)) this.windowListeners.set(type, new Set());
    this.windowListeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    if (type === 'message') this.listeners.delete(listener);
    else this.windowListeners.get(type)?.delete(listener);
  }

  /** Fire a window event that is not a message (`fire('offline')`) at this window's listeners. */
  fire(type, event = { type }) {
    for (const listener of [...(this.windowListeners.get(type) ?? [])]) listener(event);
  }

  /**
   * A message to this window. Delivered, synchronously, to this window's
   * listeners only when `targetOrigin` is `'*'` or this window's origin — a
   * missing one is not a wildcard. The listeners get a structured clone, as a
   * real `postMessage` gives, with the caller's (the other side's) origin and
   * window.
   */
  postMessage(data, targetOrigin) {
    this.posted.push({ data, targetOrigin });
    const delivers = targetOrigin === '*' || targetOrigin === this.origin;
    if (!delivers) {
      this.dropped.push({ data, targetOrigin });
      return;
    }
    this.dispatch({ data: structuredClone(data), origin: this.peer.origin, source: this.peer });
  }

  /** Deliver an arbitrary event to this side's listeners — a third window, a forged origin. */
  dispatch({ data, origin, source }) {
    for (const listener of [...this.listeners]) listener({ type: 'message', data, origin, source });
  }
}

/**
 * An app window and the host iframe inside it, wired to each other.
 *
 * `host.parent === host.top === app`, `app.frames = [host]` — what the nesting
 * rule reads; set `host.top` to something else to be nested.
 *
 * `postMessage` delivers to the window it is called ON, from the other side:
 * `host.postMessage(msg, hostOrigin)` is the app page writing to the iframe and
 * reaches `host`'s listeners as `{origin: app.origin, source: app}`;
 * `app.postMessage(msg, appOrigin)` is the host answering its parent and reaches
 * `app`'s listeners as `{origin: host.origin, source: host}`. Either needs
 * `targetOrigin` to be `'*'` or the origin of the window it is called on.
 *
 * A factory, so it reads the same with or without `new`:
 *
 *   const { app, host } = FakeWindowPair({ appOrigin, hostOrigin });
 */
export function FakeWindowPair({
  appOrigin = 'https://demo-ws-1.valuguru.app',
  hostOrigin = 'https://valuguru.texpo.io',
} = {}) {
  const app = new FakePairWindow(appOrigin);
  const host = new FakePairWindow(hostOrigin);
  app.peer = host;
  host.peer = app;
  host.parent = app;
  host.top = app;
  app.frames = [host];
  return { app, host };
}

/**
 * The `document` an app page injects its host iframe into, over a
 * {@link FakeWindowPair}: `createElement('iframe')` makes an element whose
 * `contentWindow` is `pair.host` while it is in the page and `null` while it is
 * not (before `body.appendChild`, after `body.removeChild`), as in a browser.
 * `appendChild` fires the element's `load` on the next microtask, once the
 * page has wired its listeners.
 *
 * A second `createElement` makes a second element on the same `pair.host`: the
 * page that removes a dead frame and builds a new one. `frames` is every
 * element made, in order; `fire(type)` on one is a browser event the test
 * raises by hand (`error`, a second `load`). `autoLoad: false` leaves `load`
 * to the test.
 * @param {{host: object}} pair
 * @param {{autoLoad?: boolean}} [options]
 */
export function fakeDocumentFor(pair, { autoLoad = true } = {}) {
  const frames = [];
  const children = [];

  const body = {
    children,
    appendChild(element) {
      children.push(element);
      element.parentNode = body;
      if (autoLoad) queueMicrotask(() => { if (element.parentNode === body) element.fire('load'); });
      return element;
    },
    removeChild(element) {
      const index = children.indexOf(element);
      if (index < 0) throw domError('NotFoundError', 'The node to be removed is not a child of this node.');
      children.splice(index, 1);
      element.parentNode = null;
      return element;
    },
  };

  const createElement = (tagName) => {
    const listeners = { load: new Set(), error: new Set() };
    const attributes = new Map();
    const element = {
      tagName: String(tagName).toUpperCase(),
      src: '',
      hidden: false,
      parentNode: null,
      get contentWindow() { return element.parentNode ? pair.host : null; },
      get attributes() { return Object.fromEntries(attributes); },
      setAttribute(name, value) { attributes.set(String(name), String(value)); },
      getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
      addEventListener(type, listener) { listeners[type]?.add(listener); },
      removeEventListener(type, listener) { listeners[type]?.delete(listener); },
      /** Raise a browser event on this element. */
      fire(type) { for (const listener of [...(listeners[type] ?? [])]) listener({ type, target: element }); },
    };
    frames.push(element);
    return element;
  };

  return { body, frames, createElement };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** A `fetch` Response, as much of it as the host reads. */
const respond = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/**
 * A `fetch` for `GET …/api/host/v1/resolve?origin=<encoded>`.
 *
 * `table` maps an origin to its `ResolvedApp`, or to `null` for one the server
 * does not know; an origin that is not in it is unknown too. Anything that is
 * not a resolve lookup answers 500, so a stray request fails loudly.
 * `.calls` is every request: `{url, method, headers}`.
 * @param {Record<string, object|null>|Map<string, object|null>} table
 */
export function fakeResolveFetch(table) {
  const lookup = table instanceof Map ? (k) => table.get(k) : (k) => (Object.hasOwn(table, k) ? table[k] : null);
  const impl = async (url, options) => {
    const method = options?.method ?? 'GET';
    impl.calls.push({ url: String(url), method, headers: options?.headers });
    const parsed = new URL(String(url));
    if (method !== 'GET' || !parsed.pathname.endsWith('/api/host/v1/resolve')) {
      return respond(500, { ok: false, error: { code: 'unexpected_request' } });
    }
    const app = lookup(parsed.searchParams.get('origin')) ?? null;
    return app
      ? respond(200, { ok: true, app })
      : respond(404, { ok: false, error: { code: 'unknown_app' } });
  };
  impl.calls = [];
  return impl;
}

/**
 * A `fetch` for the master's two auth endpoints.
 *
 * The master signals every verdict in the JSON body and answers HTTP 200 for
 * all of them, a rejected session and a bad token included — so `check: 401`
 * is a 200 whose `error.status` is true. Both knobs can be reassigned
 * mid-test (`fetch.check = 401`: a session that was good and then is not).
 * Anything else answers 500. `.calls` is every request: `{url, method, headers}`.
 *
 *   GET  …/api/v1/auth/check
 *   POST …/api/v1/auth/checkOneTimeAuthToken/<token>
 * @param {{check?: 200|401, redeem?: object}} [options]
 */
export function fakeAuthFetch({ check = 200, redeem } = {}) {
  const impl = async (url, options) => {
    const method = options?.method ?? 'GET';
    impl.calls.push({ url: String(url), method, headers: options?.headers });
    const { pathname } = new URL(String(url));
    if (method === 'GET' && pathname.endsWith('/api/v1/auth/check')) {
      if (impl.check === 401) return respond(200, { error: { status: true, code: 401, message: 'Unauthorized' } });
      if (impl.check !== 200) throw new TypeError(`fakeAuthFetch: check must be 200 or 401, not ${impl.check}`);
      return respond(200, { data: null, error: { status: false, code: 200, message: '' } });
    }
    if (method === 'POST' && /\/api\/v1\/auth\/checkOneTimeAuthToken\/[^/]+$/.test(pathname)) {
      return respond(200, impl.redeem);
    }
    return respond(500, { error: { status: true, code: 500, message: 'unexpected request' } });
  };
  impl.calls = [];
  impl.check = check;
  impl.redeem = redeem ?? {
    data: { user_id: 'u1', session_token: 's1', is_new: false, need_verification: false },
    error: { status: false, code: 200, message: '' },
  };
  return impl;
}
