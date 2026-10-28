// ===========================================================================
// createHost — the composition root the host page calls (spec §4.1, §4.3).
//
// It builds every part of the bridge from a window, `io`, `fetch`, a
// `WebSocket`, a storage and a config, and returns the started bridge. These
// tests run the REAL parts it wires (resolver, session store, auth, master
// connection, Guru client, grants) over fakes of the outside world only: a
// window pair, an `io` factory, one routing `fetch`, a Guru socket and a
// storage. So they show that the pieces are connected to each other and to the
// config's origins; what each piece does is tested in its own file.
//
// Reading the wire is as in `hostBridgeFakes.js`: the host answers its parent
// through `app.posted`.
// ===========================================================================
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createHost } from '../../src/host/Host.js';
import { HostBridge } from '../../src/host/HostBridge.js';
import { HOST_ERRORS, MSG, POPUP_MSG, PROTOCOL_VERSION } from '../../src/host/protocol.js';
import { SESSION_KEY, SessionStore } from '../../src/host/SessionStore.js';
import { Responder, readyIo } from '../helpers/fakes.js';
import { APP, APP_ORIGIN, HOST_ORIGIN, LOCAL_ORIGIN, settle } from '../helpers/hostBridgeFakes.js';
import {
  FakeStorage, FakeWindowPair, fakeAuthFetch, fakeGuruWebSocket, fakeResolveFetch,
} from '../helpers/hostFakes.js';

/** Every bridge a test starts, stopped afterwards: a connection holds timers. */
const bridges = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

const SIGN_IN_ORIGINS = ['https://live.valuverse.io', 'https://valu-social.com', 'https://chabaduniverse.com', 'https://texpo.io'];
const NETWORK = 'net-1';

/**
 * One `fetch` for every endpoint the host asks: resolve, the master's auth
 * endpoints and the Guru one-time token. `.calls` is every request.
 */
function routedFetch({ table }) {
  const resolve = fakeResolveFetch(table);
  const auth = fakeAuthFetch();
  const impl = async (url, init) => {
    impl.calls.push({ url: String(url), init });
    const { pathname } = new URL(String(url));
    if (pathname.endsWith('/api/host/v1/resolve')) return resolve(url, init);
    if (pathname.endsWith('/api/v1/auth/getOneTimeAuthToken')) {
      return { ok: true, status: 200, json: async () => ({ data: { token: 'ott-1' }, error: { status: false, code: 200, message: '' } }) };
    }
    return auth(url, init);
  };
  impl.calls = [];
  impl.urls = () => impl.calls.map((call) => call.url);
  return impl;
}

/**
 * The page the host runs in: a window pair whose host side also hears `storage`
 * events (`fireStorage`, as the browser fires them for another tab's change),
 * a storage (holding a session when `stored`), and the fakes `createHost` takes.
 */
function page({
  appOrigin = APP_ORIGIN, table, config, stored = false, createOptions = {}, location, navigator,
} = {}) {
  const { app, host } = FakeWindowPair({ appOrigin, hostOrigin: HOST_ORIGIN });
  if (location) host.location = location;
  if (navigator) host.navigator = navigator;
  const storageListeners = new Set();
  /**
   * Every `online` listener registered on the window: `{self, listener, options}`, `self` being the receiver of the call.
   * The bridge registers its own (no options, as a method of the window); the Guru client registers one per
   * attempt with an `AbortSignal`, through the `addEventListener` it was given.
   */
  const onlineListeners = [];
  const listen = host.addEventListener.bind(host);
  host.addEventListener = function addEventListener(type, listener, ...rest) {
    if (type === 'storage') storageListeners.add(listener);
    else if (type === 'online') onlineListeners.push({ self: this, listener, options: rest[0] });
    else listen(type, listener, ...rest);
  };
  const fireStorage = (event) => { for (const listener of [...storageListeners]) listener({ type: 'storage', ...event }); };

  const storage = new FakeStorage();
  const store = new SessionStore({ storage });
  if (stored) store.set({ userId: 'u1', networkId: NETWORK, sessionId: 'sess-1' });

  const fetchImpl = routedFetch({ table: table ?? { [appOrigin]: APP } });
  const io = readyIo(new Responder(), { userId: 'u1', networkId: NETWORK });
  const WebSocketImpl = fakeGuruWebSocket({ autoOpen: true });
  const logs = [];
  const bridge = createHost({
    win: host,
    io,
    fetchImpl,
    WebSocketImpl,
    storage,
    config: { hostOrigin: HOST_ORIGIN, ...config },
    log: (level, message) => logs.push({ level, message }),
    ...createOptions,
  });
  bridges.push(bridge);

  const send = (data, { origin = appOrigin, source = app } = {}) => host.dispatch({ data, origin, source });
  const hello = (extra) => send({ name: MSG.HELLO, message: { protocol: PROTOCOL_VERSION, client: 'test', ...extra } });
  const names = () => app.posted.map((post) => post.data.name);
  const last = () => app.posted.at(-1).data;
  const authPushes = () => app.posted
    .filter((post) => post.data.name === MSG.TRIGGER && post.data.message.action === 'auth')
    .map((post) => post.data.message.data);
  return {
    app, host, bridge, storage, store, fetchImpl, io, WebSocketImpl, logs, fireStorage, onlineListeners, send, hello, names, last,
    authPushes,
  };
}

/** The `online` listeners the Guru client registered: the ones that carry the signal that removes them. */
const guruOnlineListeners = (env) => env.onlineListeners.filter((entry) => entry.options?.signal instanceof AbortSignal);

/** Hello, then a consent-tier call: the bridge reads the grants, which opens the Guru client. */
async function askGuru(env, requestId = 7) {
  env.hello();
  await settle();
  await settle();
  env.send({ name: MSG.CALL, message: { service: 'Groups', action: 'list-groups', params: {}, requestId } });
  await settle();
  await settle();
}

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------

test('createHost returns a started HostBridge: a hello is answered with api:ready', async () => {
  const env = page();
  assert.ok(env.bridge instanceof HostBridge);
  assert.equal(env.bridge.start(), env.bridge, 'starting again is harmless');

  env.hello();
  await settle();

  assert.deepEqual(env.names(), [MSG.READY]);
  assert.equal(env.last().message.applicationId, APP.address);
  assert.equal(env.last().message.host.signedIn, false);
  assert.deepEqual(env.logs, []);
});

test('createHost wires the bridge with the config origins', async () => {
  const env = page({
    stored: true,
    config: {
      master: 'master.example.test',
      resolveBaseUrl: 'https://resolver.example.test',
      guruUrl: 'wss://guru.example.test/',
      signInOrigins: ['https://sign.example.test'],
    },
  });
  env.hello();
  await settle();
  await settle();

  // resolveBaseUrl: the app was looked up there
  assert.equal(
    env.fetchImpl.urls()[0],
    `https://resolver.example.test/api/host/v1/resolve?origin=${encodeURIComponent(APP_ORIGIN)}`,
  );
  // master: the stored session was checked there, and the socket went there
  assert.ok(env.fetchImpl.urls().includes('https://master.example.test/api/v1/auth/check'));
  assert.ok(!env.fetchImpl.urls().some((url) => url.includes('api.roomful.net')), 'the default master is not asked');
  assert.match(env.io.calls[0].url, /master\.example\.test/);
  assert.equal(env.last().name, MSG.READY);
  assert.equal(env.last().message.host.signedIn, true);
  assert.equal(env.bridge.state.signedIn, true);

  // guruUrl, the mint and the network: a consent-tier call reads the grants over the Guru socket
  env.send({ name: MSG.CALL, message: { service: 'Groups', action: 'list-groups', params: {}, requestId: 7 } });
  for (let i = 0; i < 20 && !env.WebSocketImpl.last?.sent.length; i += 1) await settle();
  const socket = env.WebSocketImpl.last;
  assert.equal(socket.url, 'wss://guru.example.test/?token=ott-1&client=host');
  const mint = env.fetchImpl.calls.find((call) => call.url.endsWith('/auth/getOneTimeAuthToken'));
  assert.equal(mint.url, 'https://master.example.test/api/v1/auth/getOneTimeAuthToken');
  assert.equal(mint.init.headers['X-Session-Id'], 'sess-1');
  const [request] = socket.sent;
  assert.equal(request.op, 'valuguru.apps.grants.list');
  assert.deepEqual(request.params, { appId: APP.address });
  socket.reply(request.requestId, { data: { grants: [] } });
  await settle();
  await settle();
  const answer = env.app.posted.map((post) => post.data).find((data) => data.requestId === 7);
  assert.deepEqual(answer.message.error, { status: true, code: 403, message: 'consent_required', scope: 'groups:read' });

  // signInOrigins: a token from the configured origin is redeemed, one from a default origin is not
  const before = env.fetchImpl.calls.length;
  env.host.dispatch({
    data: { type: POPUP_MSG.TOKEN, token: 'ott-A', master: 'master.example.test' },
    origin: 'https://live.valuverse.io',
    source: { popup: true },
  });
  await settle();
  assert.ok(!env.fetchImpl.calls.slice(before).some((call) => call.url.includes('checkOneTimeAuthToken')), 'a default sign-in origin is not trusted');
  env.host.dispatch({
    data: { type: POPUP_MSG.TOKEN, token: 'ott-B', master: 'master.example.test' },
    origin: 'https://sign.example.test',
    source: { popup: true },
  });
  await settle();
  await settle();
  assert.ok(
    env.fetchImpl.calls.slice(before).some((call) => call.url === 'https://master.example.test/api/v1/auth/checkOneTimeAuthToken/ott-B'),
    'the configured sign-in origin is trusted, and the token is checked at the configured master',
  );
});

test('createHost defaults: the production hosts, master and the four Valu sign-in origins', async () => {
  const env = page({ stored: true });
  env.hello();
  await settle();
  await settle();

  assert.equal(
    env.fetchImpl.urls()[0],
    `https://valuguru.texpo.io/api/host/v1/resolve?origin=${encodeURIComponent(APP_ORIGIN)}`,
  );
  assert.ok(env.fetchImpl.urls().includes('https://api.roomful.net/api/v1/auth/check'));
  assert.match(env.io.calls[0].url, /api\.roomful\.net/);
  env.send({ name: MSG.CALL, message: { service: 'Groups', action: 'list-groups', params: {}, requestId: 1 } });
  for (let i = 0; i < 20 && !env.WebSocketImpl.last?.sent.length; i += 1) await settle();
  assert.equal(env.WebSocketImpl.last.url, 'wss://valuguru.texpo.io/?token=ott-1&client=host');
});

test('createHost defaults: a token from each of the four Valu origins is redeemed, one from any other is not', async () => {
  for (const origin of SIGN_IN_ORIGINS) {
    const env = page();
    env.hello();
    await settle();
    env.host.dispatch({ data: { type: POPUP_MSG.TOKEN, token: 'ott-1', master: 'api.roomful.net' }, origin, source: { popup: true } });
    for (let i = 0; i < 20 && env.authPushes().length === 0; i += 1) await settle();
    assert.equal(env.authPushes().at(-1)?.signedIn, true, `${origin} signs the user in`);
    assert.ok(env.fetchImpl.urls().includes('https://api.roomful.net/api/v1/auth/checkOneTimeAuthToken/ott-1'));
  }

  for (const origin of ['https://evil.example', 'https://live.valuverse.io.evil.example', 'http://texpo.io', APP_ORIGIN]) {
    const env = page();
    env.hello();
    await settle();
    env.host.dispatch({ data: { type: POPUP_MSG.TOKEN, token: 'ott-1', master: 'api.roomful.net' }, origin, source: { popup: true } });
    await settle();
    await settle();
    assert.equal(env.authPushes().length, 0, `${origin} is not trusted`);
    assert.ok(!env.fetchImpl.urls().some((url) => url.includes('checkOneTimeAuthToken')));
  }
});

test('a signInOrigins list the page gets wrong allows nobody, and one it leaves out takes the four', async () => {
  const wrong = page({ config: { signInOrigins: 'https://live.valuverse.io' } });
  wrong.hello();
  await settle();
  wrong.host.dispatch({
    data: { type: POPUP_MSG.TOKEN, token: 'ott-1', master: 'api.roomful.net' }, origin: 'https://live.valuverse.io', source: { popup: true },
  });
  await settle();
  await settle();
  assert.equal(wrong.authPushes().length, 0);

  const left = page({ config: { signInOrigins: undefined } });
  left.hello();
  await settle();
  left.host.dispatch({
    data: { type: POPUP_MSG.TOKEN, token: 'ott-1', master: 'api.roomful.net' }, origin: 'https://texpo.io', source: { popup: true },
  });
  for (let i = 0; i < 20 && left.authPushes().length === 0; i += 1) await settle();
  assert.equal(left.authPushes().at(-1)?.signedIn, true);
});

test('createHost passes the other bridge settings through, so a page can tune them', async () => {
  const env = page({ config: { allowedAncestors: ['https://only.example.test'] }, location: { ancestorOrigins: [APP_ORIGIN] } });
  env.hello();
  await settle();
  assert.equal(env.last().name, MSG.ERROR, 'the framing page is not on the page\'s own list');
  assert.equal(env.last().message.code, HOST_ERRORS.NESTED);
});

test('the Guru client is given the window\'s addEventListener, bound to it', async () => {
  const env = page({ stored: true });
  await askGuru(env);

  const listeners = guruOnlineListeners(env);
  assert.equal(listeners.length, 1, 'the client listens for `online` through the window the page gave');
  assert.equal(listeners[0].self, env.host, 'called on the window: a bare call would throw "Illegal invocation" in a browser');
  assert.ok(env.onlineListeners.length > listeners.length, 'the bridge\'s own online listener is a different registration');
});

test('the Guru client is given the window\'s navigator: a page that is offline waits for the online event', async () => {
  const navigator = { onLine: false };
  const env = page({ stored: true, navigator });
  await askGuru(env);

  assert.equal(env.WebSocketImpl.sockets.length, 0, 'offline: no socket is opened');
  assert.ok(!env.fetchImpl.urls().some((url) => url.endsWith('/auth/getOneTimeAuthToken')), 'and no token is minted');
  const listeners = guruOnlineListeners(env);
  assert.equal(listeners.length, 1, 'the client waits for the window\'s online event');

  navigator.onLine = true;
  listeners[0].listener({ type: 'online' });
  for (let i = 0; i < 20 && !env.WebSocketImpl.last?.sent.length; i += 1) await settle();

  assert.equal(env.WebSocketImpl.sockets.length, 1, 'back online: the socket opens');
  const [request] = env.WebSocketImpl.last.sent;
  assert.equal(request.op, 'valuguru.apps.grants.list');
  env.WebSocketImpl.last.reply(request.requestId, { data: { grants: [] } });
  await settle();
  await settle();
  const answer = env.app.posted.map((post) => post.data).find((data) => data.requestId === 7);
  assert.equal(answer.message.error.message, 'consent_required');
});

test('a page that is online connects at once', async () => {
  const env = page({ stored: true, navigator: { onLine: true } });
  await askGuru(env);

  for (let i = 0; i < 20 && !env.WebSocketImpl.last?.sent.length; i += 1) await settle();
  assert.equal(env.WebSocketImpl.sockets.length, 1);
});

// ---------------------------------------------------------------------------
// Dev mode
// ---------------------------------------------------------------------------

test('dev mode accepts a localhost claim', async () => {
  const env = page({ appOrigin: LOCAL_ORIGIN, table: {}, config: { dev: true } });
  env.hello({ app: 'ws_1/demo' });
  await settle();

  assert.equal(env.last().name, MSG.READY);
  assert.equal(env.last().message.applicationId, 'ws_1/demo');
  assert.ok(!env.fetchImpl.urls().some((url) => url.includes('/resolve')), 'a claim is not looked up');
  assert.equal(env.bridge.state.bound.app.slug, 'demo');
});

test('dev mode still asks the resolver about every other origin', async () => {
  const env = page({ config: { dev: true } });
  env.hello({ app: 'ws_9/other' });
  await settle();

  assert.equal(env.last().message.applicationId, APP.address, 'the resolver answered; the claim of a non-local origin is not read');
  assert.equal(env.fetchImpl.urls().filter((url) => url.includes('/resolve')).length, 1);
});

test('production refuses a localhost claim', async () => {
  const env = page({ appOrigin: LOCAL_ORIGIN, table: {}, config: { dev: false } });
  env.hello({ app: 'ws_1/demo' });
  await settle();

  assert.equal(env.last().name, MSG.ERROR);
  assert.equal(env.last().message.code, HOST_ERRORS.UNKNOWN_APP);
  assert.equal(env.bridge.state.bound, null);

  const omitted = page({ appOrigin: LOCAL_ORIGIN, table: {} });
  omitted.hello({ app: 'ws_1/demo' });
  await settle();
  assert.equal(omitted.last().message.code, HOST_ERRORS.UNKNOWN_APP, 'no dev key is production');
});

test('dev is on for the boolean true only, and never from the URL, the hash or storage', async () => {
  const location = {
    origin: HOST_ORIGIN, search: '?dev=1&dev=true', hash: '#dev', href: `${HOST_ORIGIN}/?dev=1#dev`,
  };
  for (const dev of ['true', 1, {}, [], 'yes', null, undefined, () => true]) {
    const env = page({ appOrigin: LOCAL_ORIGIN, table: {}, config: { dev }, location });
    env.storage.setItem('dev', 'true');
    env.storage.setItem('valu-host:dev', 'true');
    env.hello({ app: 'ws_1/demo' });
    await settle();
    assert.equal(env.last().message.code, HOST_ERRORS.UNKNOWN_APP, `dev: ${String(dev)} does not turn the claim on`);
  }
  const on = page({ appOrigin: LOCAL_ORIGIN, table: {}, config: { dev: true }, location: { origin: HOST_ORIGIN, search: '', hash: '' } });
  on.hello({ app: 'ws_1/demo' });
  await settle();
  assert.equal(on.last().name, MSG.READY);
});

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

test('fetchImpl is bound: the global fetch is called with the global as its receiver', async (t) => {
  const real = routedFetch({ table: { [APP_ORIGIN]: APP } });
  const seen = [];
  // A browser's fetch throws "Illegal invocation" unless called on the window.
  const strict = function strictFetch(url, init) {
    seen.push(String(url));
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return real(url, init);
  };
  const original = globalThis.fetch;
  globalThis.fetch = strict;
  t.after(() => { globalThis.fetch = original; });

  const { app, host } = FakeWindowPair({ appOrigin: APP_ORIGIN, hostOrigin: HOST_ORIGIN });
  const storage = new FakeStorage();
  new SessionStore({ storage }).set({ userId: 'u1', networkId: NETWORK, sessionId: 'sess-1' });
  const logs = [];
  const bridge = createHost({
    win: host,
    io: readyIo(new Responder(), { userId: 'u1', networkId: NETWORK }),
    WebSocketImpl: fakeGuruWebSocket(),
    storage,
    config: { hostOrigin: HOST_ORIGIN },
    log: (level, message) => logs.push({ level, message }),
  });
  bridges.push(bridge);
  host.dispatch({ data: { name: MSG.HELLO, message: { protocol: PROTOCOL_VERSION } }, origin: APP_ORIGIN, source: app });
  await settle();
  await settle();

  assert.ok(seen.some((url) => url.includes('/api/host/v1/resolve')), 'the resolver used it');
  assert.ok(seen.some((url) => url.endsWith('/api/v1/auth/check')), 'the stored session was checked with it');
  assert.equal(app.posted.at(-1).data.name, MSG.READY, 'no "Illegal invocation": the app was resolved');
  assert.equal(app.posted.at(-1).data.message.host.signedIn, true);
  assert.deepEqual(logs, []);
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test('storage events with key null reach the session store: another tab clearing storage signs this tab out', async () => {
  const env = page({ stored: true });
  env.hello();
  await settle();
  await settle();
  assert.equal(env.bridge.state.signedIn, true);
  env.app.posted.length = 0;

  env.storage.clear(); // another tab: localStorage.clear()
  env.fireStorage({ key: null, oldValue: null, newValue: null });
  await settle();
  await settle();

  assert.equal(env.bridge.state.signedIn, false);
  assert.equal(env.authPushes().at(-1)?.signedIn, false);
  assert.equal(env.authPushes().at(-1)?.reason, HOST_ERRORS.SIGNED_OUT_ELSEWHERE);
});

test('a storage event for the session record reaches the session store', async () => {
  const env = page({ stored: true });
  env.hello();
  await settle();
  await settle();
  env.app.posted.length = 0;

  env.store.clear(); // another tab signed out
  env.fireStorage({ key: SESSION_KEY });
  await settle();
  await settle();

  assert.equal(env.bridge.state.signedIn, false);
});

test('a storage event for any other key is not a session change', async () => {
  const env = page({ stored: true });
  env.hello();
  await settle();
  await settle();
  env.app.posted.length = 0;

  env.store.clear(); // the record is gone, but this event is about something else
  env.fireStorage({ key: 'theme' });
  env.fireStorage({ key: 'valu-host:session-extra' });
  await settle();
  await settle();

  assert.equal(env.bridge.state.signedIn, true, 'only the session key (or a clear) is looked at');
  assert.deepEqual(env.authPushes(), []);
});

test('a page whose localStorage throws on access still hosts, with the session kept in memory', async () => {
  const { app, host } = FakeWindowPair({ appOrigin: APP_ORIGIN, hostOrigin: HOST_ORIGIN });
  Object.defineProperty(host, 'localStorage', {
    get() { throw Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' }); },
  });
  const fetchImpl = routedFetch({ table: { [APP_ORIGIN]: APP } });
  const bridge = createHost({
    win: host,
    io: readyIo(new Responder(), { userId: 'u1', networkId: NETWORK }),
    fetchImpl,
    WebSocketImpl: fakeGuruWebSocket(),
    config: { hostOrigin: HOST_ORIGIN },
    log: () => {},
  });
  bridges.push(bridge);
  host.dispatch({ data: { name: MSG.HELLO, message: { protocol: PROTOCOL_VERSION } }, origin: APP_ORIGIN, source: app });
  await settle();
  assert.equal(app.posted.at(-1).data.name, MSG.READY);
  assert.equal(app.posted.at(-1).data.message.host.signedIn, false);
});

test('without a storage the window\'s localStorage is the store', async () => {
  const { app, host } = FakeWindowPair({ appOrigin: APP_ORIGIN, hostOrigin: HOST_ORIGIN });
  host.localStorage = new FakeStorage();
  new SessionStore({ storage: host.localStorage }).set({ userId: 'u1', networkId: NETWORK, sessionId: 'sess-1' });
  const bridge = createHost({
    win: host,
    io: readyIo(new Responder(), { userId: 'u1', networkId: NETWORK }),
    fetchImpl: routedFetch({ table: { [APP_ORIGIN]: APP } }),
    WebSocketImpl: fakeGuruWebSocket(),
    config: { hostOrigin: HOST_ORIGIN },
    log: () => {},
  });
  bridges.push(bridge);
  host.dispatch({ data: { name: MSG.HELLO, message: { protocol: PROTOCOL_VERSION } }, origin: APP_ORIGIN, source: app });
  await settle();
  await settle();
  assert.equal(app.posted.at(-1).data.message.host.signedIn, true);
});

// ---------------------------------------------------------------------------
// What it refuses to build
// ---------------------------------------------------------------------------

test('createHost refuses to build without what the host cannot run without', () => {
  const { host } = FakeWindowPair({ appOrigin: APP_ORIGIN, hostOrigin: HOST_ORIGIN });
  const good = {
    win: host,
    io: readyIo(new Responder()),
    fetchImpl: async () => ({}),
    WebSocketImpl: fakeGuruWebSocket(),
    storage: new FakeStorage(),
    config: { hostOrigin: HOST_ORIGIN },
  };
  const refuses = (override, why) => assert.throws(() => createHost({ ...good, ...override }), TypeError, why);
  const refusesWindow = (win, why) => assert.throws(
    () => createHost({ ...good, win }),
    { name: 'TypeError', message: /needs a window/ },
    why,
  );

  refusesWindow(null, 'no window');
  refusesWindow({}, 'a window that cannot listen');
  refusesWindow({ addEventListener: 'x' }, 'addEventListener that is not a function');
  refuses({ io: undefined }, 'no io');
  refuses({ io: {} }, 'io that is not a factory');
  refuses({ fetchImpl: null }, 'no fetch');
  refuses({ WebSocketImpl: null }, 'no WebSocket');
  refuses({ config: undefined }, 'no config');
  refuses({ config: null }, 'null config');
  refuses({ config: {} }, 'no hostOrigin');
  refuses({ config: { hostOrigin: '*' } }, 'a wildcard is not an origin');
  refuses({ config: { hostOrigin: 'https://valuguru.texpo.io/host/' } }, 'an origin has no path');
  refuses({ config: { hostOrigin: HOST_ORIGIN, master: 5 } }, 'a master that is not a host');
  refuses({ config: { hostOrigin: HOST_ORIGIN, master: '' } }, 'an empty master');
  refuses({ config: { hostOrigin: HOST_ORIGIN, guruUrl: {} } }, 'a Guru url that is not text');
  refuses({ config: { hostOrigin: HOST_ORIGIN, resolveBaseUrl: 7 } }, 'a resolve base that is not text');
  assert.doesNotThrow(() => {
    const bridge = createHost({ ...good, config: { hostOrigin: HOST_ORIGIN, resolveBaseUrl: '' } });
    bridges.push(bridge); // '' asks the page's own origin
  });
});
