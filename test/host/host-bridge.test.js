// ===========================================================================
// HostBridge — the host iframe's message handler: handshake, binding, the
// nesting rule, the dispatch table, sign-out, ping and pushes (spec §4.3,
// §4.5). `api:call` / `api:service-intent` bodies, consent and the sign-in
// token channel are later tasks; here they answer `not_available` / are absent.
//
// Everything runs on the fakes, synchronously except where the bridge awaits
// (the resolver, `auth.restore`, `connect`); `settle()` lets those finish.
//
// Reading the wire: the host answers through `win.parent.postMessage(msg,
// origin)`. `FakeWindowPair.postMessage` is the SENDER's side (a call on `app`
// is "app sends to host"), so a reply to the app is a call recorded in
// `app.posted`, never delivered to an app listener — these tests read
// `app.posted`, and send into the host with `host.dispatch`, which does not
// depend on that polarity.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HostBridge, defaultMakeServices } from '../../src/host/HostBridge.js';
import { AppResolver } from '../../src/host/AppResolver.js';
import { HostAuth } from '../../src/host/HostAuth.js';
import { SessionStore } from '../../src/host/SessionStore.js';
import { MSG, HOST_ERRORS, PROTOCOL_VERSION } from '../../src/host/protocol.js';
import {
  FakeWindowPair, FakeStorage, fakeResolveFetch, fakeAuthFetch,
} from '../helpers/hostFakes.js';

const APP_ORIGIN = 'https://demo-ws-1.valuguru.app';
const HOST_ORIGIN = 'https://valuguru.texpo.io';
const OTHER_ORIGIN = 'https://other-ws-1.valuguru.app';
const LOCAL_ORIGIN = 'http://localhost:3005';

const APP = {
  address: 'ws_1/demo', workspaceId: 'ws_1', slug: 'demo', devAppId: 'dev-1', name: 'Demo', homeNetworkId: 'net-1',
};
const INFO = {
  userId: 'u1',
  networkId: 'n1',
  user: { id: 'u1', name: 'Ada Lovelace' },
  network: { id: 'n1', fullName: 'Roomful' },
};
const SESSION = { userId: 'u1', sessionId: 'sess-SECRET-1' };

/** Let every promise the bridge is awaiting run to its next real wait. */
const settle = () => new Promise((resolve) => { setImmediate(resolve); });

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const codedError = (code) => Object.assign(new Error(`failed (${code})`), { code });

/** A resolver over a table of origin -> app (`null`: unknown); records every ask. */
function fakeResolver(table = { [APP_ORIGIN]: APP }) {
  const resolver = {
    calls: [],
    async resolve(origin) {
      resolver.calls.push(origin);
      return Object.hasOwn(table, origin) ? table[origin] : null;
    },
  };
  return resolver;
}

/** An `auth` whose `restore` answers `session` (or runs `restore`), recording what it was asked. */
function fakeAuth({ session = null, restore } = {}) {
  const auth = {
    restoreCalls: [],
    signOutCalls: 0,
    restore: async (options) => {
      auth.restoreCalls.push(options);
      return restore ? restore(options) : session;
    },
    signOut() { auth.signOutCalls += 1; },
  };
  return auth;
}

/** `makeConnection` over a scripted master: `connect` answers `info`, or rejects with `error`. */
function fakeMaker({ info = INFO, error = null, connect } = {}) {
  const maker = {
    sessions: [],
    connections: [],
    make(sessionId) {
      maker.sessions.push(sessionId);
      const connection = {
        closed: 0,
        socket: { emit: async () => ({ data: {} }) },
        connect: connect ? () => connect(connection) : async () => { if (error) throw error; return info; },
        close: async () => { connection.closed += 1; },
      };
      maker.connections.push(connection);
      return connection;
    },
  };
  return maker;
}

const noopStore = { onChange: () => () => {} };

/**
 * A bridge on a window pair, started. `send` posts an app message into the
 * host as the app (the parent window) unless told otherwise.
 */
function setup({
  appOrigin = APP_ORIGIN, resolver = fakeResolver(), auth = fakeAuth(), maker = fakeMaker(),
  config = {}, sessionStore = noopStore, start = true, ancestors, ...rest
} = {}) {
  const pair = FakeWindowPair({ appOrigin, hostOrigin: HOST_ORIGIN });
  const { app, host } = pair;
  if (ancestors) host.location = { ancestorOrigins: ancestors };
  const logs = [];
  const bridge = new HostBridge({
    win: host,
    resolver,
    auth,
    sessionStore,
    makeConnection: (sessionId) => maker.make(sessionId),
    config: { hostOrigin: HOST_ORIGIN, signInOrigins: [], ...config },
    log: (level, message) => logs.push({ level, message }),
    ...rest,
  });
  if (start) bridge.start();

  const send = (data, { origin = appOrigin, source = app } = {}) => host.dispatch({ data, origin, source });
  const hello = (extra, options) => send({ name: MSG.HELLO, message: { protocol: PROTOCOL_VERSION, client: 'test', ...extra } }, options);
  const call = (name, message = {}, options) => send({ name, message }, options);
  /** What the host posted to the app, in order: `{data, targetOrigin}`. */
  const posts = () => app.posted;
  const names = () => app.posted.map((p) => p.data.name);
  const last = () => app.posted.at(-1);
  /** Run the handshake to the end and forget what it posted. */
  const open = async (extra) => {
    hello(extra);
    await settle();
    app.posted.length = 0;
  };
  return {
    pair, app, host, bridge, resolver, auth, maker, logs, send, hello, call, posts, names, last, open,
  };
}

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

test('hello from the parent binds the origin and answers api:ready with the app address and signedIn:false', async () => {
  const resolver = fakeResolver();
  const auth = fakeAuth();
  const { bridge, hello, posts, maker } = setup({ resolver, auth });

  hello();
  await settle();

  assert.deepEqual(resolver.calls, [APP_ORIGIN], 'the app is resolved from the sender origin');
  assert.deepEqual(auth.restoreCalls, [{ homeNetworkId: 'net-1' }]);
  assert.equal(maker.sessions.length, 0, 'no session, no master connection');
  assert.equal(posts().length, 1);
  const { data, targetOrigin } = posts()[0];
  assert.equal(targetOrigin, APP_ORIGIN, 'the reply goes to the bound origin');
  assert.equal(data.target, 'valuApi');
  assert.equal(data.name, MSG.READY);
  assert.equal(data.requestId, undefined, 'api:ready answers no request');
  assert.deepEqual(data.message, {
    applicationId: 'ws_1/demo',
    action: 'start',
    params: {},
    host: { protocol: 1, mode: 'dedicated', signedIn: false, user: null, network: null },
  });
  assert.deepEqual(bridge.state, { bound: { origin: APP_ORIGIN, app: APP }, signedIn: false, user: null, network: null });
});

test('hello binds through the real resolver, and a miss answers unknown_app', async () => {
  const fetchImpl = fakeResolveFetch({ [APP_ORIGIN]: APP });
  const resolver = new AppResolver({ fetchImpl, baseUrl: HOST_ORIGIN });
  const known = setup({ resolver });
  known.hello();
  await settle();
  assert.equal(known.last().data.name, MSG.READY);

  const stranger = setup({ appOrigin: OTHER_ORIGIN, resolver });
  stranger.hello();
  await settle();
  assert.equal(stranger.posts().length, 1);
  assert.equal(stranger.last().data.name, MSG.ERROR);
  assert.equal(stranger.last().data.message.code, HOST_ERRORS.UNKNOWN_APP);
  assert.equal(typeof stranger.last().data.message.message, 'string');
  assert.equal(stranger.last().targetOrigin, OTHER_ORIGIN);
  assert.equal(stranger.bridge.state.bound, null, 'an unknown app binds nothing');
});

test('after unknown_app nothing is served, and a later hello from a known origin still binds', async () => {
  const table = { [APP_ORIGIN]: null };
  const { hello, call, posts, resolver, bridge } = setup({ resolver: fakeResolver(table) });
  hello();
  await settle();
  posts().length = 0;

  call(MSG.PING, { requestId: 4 });
  await settle();
  assert.deepEqual(posts(), [], 'not bound: a ping is not answered');

  table[APP_ORIGIN] = APP;
  hello();
  await settle();
  assert.equal(resolver.calls.length, 2);
  assert.equal(bridge.state.bound.origin, APP_ORIGIN);
  assert.equal(posts().at(-1).data.name, MSG.READY);
});

test('a resolver that cannot answer gives resolve_unavailable and binds nothing', async () => {
  const resolver = { async resolve() { throw codedError('resolve_unavailable'); } };
  const { hello, last, posts, bridge, logs } = setup({ resolver });
  hello();
  await settle();
  assert.equal(posts().length, 1);
  assert.equal(last().data.name, MSG.ERROR);
  assert.equal(last().data.message.code, 'resolve_unavailable');
  assert.equal(bridge.state.bound, null);
  assert.equal(logs.length, 1);
});

test('a protocol newer than the host answers protocol_unsupported to the sender origin, before binding', async () => {
  const { hello, posts, last, resolver, bridge } = setup();
  hello({ protocol: PROTOCOL_VERSION + 1 });
  await settle();
  assert.equal(posts().length, 1);
  assert.equal(last().data.name, MSG.ERROR);
  assert.equal(last().data.message.code, HOST_ERRORS.PROTOCOL_UNSUPPORTED);
  assert.equal(last().targetOrigin, APP_ORIGIN);
  assert.deepEqual(resolver.calls, [], 'refused before the resolver is asked');
  assert.equal(bridge.state.bound, null);
});

test('a second hello from the bound origin re-sends api:ready with the current state', async () => {
  const { hello, posts, open, bridge } = setup();
  await open();
  hello();
  await settle();
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].data.name, MSG.READY);
  assert.equal(posts()[0].targetOrigin, APP_ORIGIN);
  assert.equal(posts()[0].data.message.applicationId, 'ws_1/demo');
  assert.equal(bridge.state.bound.origin, APP_ORIGIN);
});

test('a second hello from the bound origin with a newer protocol still answers protocol_unsupported', async () => {
  const { hello, posts, open } = setup();
  await open();
  hello({ protocol: 2 });
  await settle();
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].data.message.code, HOST_ERRORS.PROTOCOL_UNSUPPORTED);
});

test('hello from a second origin after binding is dropped and never answered', async () => {
  const { hello, send, posts, open, resolver, bridge, host } = setup();
  await open();
  const sentBefore = posts().length;

  // The forged event: another origin, but the parent window as its source.
  hello({}, { origin: OTHER_ORIGIN });
  hello({ protocol: 99 }, { origin: OTHER_ORIGIN });
  send({ name: MSG.PING, message: { requestId: 1 } }, { origin: OTHER_ORIGIN });
  await settle();

  assert.equal(posts().length, sentBefore, 'the bound origin receives nothing new');
  assert.ok(posts().every((p) => p.targetOrigin !== OTHER_ORIGIN), 'nothing is posted to the stranger');
  assert.deepEqual(host.posted, [], 'and nothing goes out any other way');
  assert.deepEqual(resolver.calls, [APP_ORIGIN], 'the stranger is not even resolved');
  assert.equal(bridge.state.bound.origin, APP_ORIGIN, 'the binding is for the life of the page');
});

test('hello from a second origin while the first is still binding is dropped, not raced', async () => {
  const gate = deferred();
  const resolver = {
    calls: [],
    async resolve(origin) { resolver.calls.push(origin); await gate.promise; return APP; },
  };
  const { hello, posts, bridge } = setup({ resolver });
  hello();
  hello({}, { origin: OTHER_ORIGIN });
  await settle();
  gate.resolve();
  await settle();

  assert.deepEqual(resolver.calls, [APP_ORIGIN]);
  assert.equal(bridge.state.bound.origin, APP_ORIGIN);
  assert.deepEqual(posts().map((p) => [p.data.name, p.targetOrigin]), [[MSG.READY, APP_ORIGIN]]);
});

test('two hellos from one origin before the first finishes bind once and are both answered', async () => {
  const gate = deferred();
  const resolver = {
    calls: [],
    async resolve(origin) { resolver.calls.push(origin); await gate.promise; return APP; },
  };
  const auth = fakeAuth();
  const { hello, names } = setup({ resolver, auth });
  hello();
  hello();
  await settle();
  gate.resolve();
  await settle();

  assert.equal(resolver.calls.length, 1);
  assert.equal(auth.restoreCalls.length, 1);
  assert.deepEqual(names(), [MSG.READY, MSG.READY]);
});

test('a hello from an opaque origin has nowhere to be answered and is dropped', async () => {
  const { hello, posts, resolver } = setup();
  hello({}, { origin: 'null' });
  hello({}, { origin: '*' });
  hello({}, { origin: null });
  hello({}, { origin: '' });
  await settle();
  assert.deepEqual(posts(), []);
  assert.deepEqual(resolver.calls, []);
});

// ---------------------------------------------------------------------------
// Who may talk to the host
// ---------------------------------------------------------------------------

test('messages not from window.parent are ignored', async () => {
  const { hello, call, posts, resolver, open, bridge } = setup();
  const stranger = { postMessage() {} };

  hello({}, { source: stranger });
  hello({}, { source: null });
  await settle();
  assert.deepEqual(resolver.calls, [], 'a hello from another window is not even resolved');
  assert.deepEqual(posts(), []);
  assert.equal(bridge.state.bound, null);

  await open();
  call(MSG.PING, { requestId: 3 }, { source: stranger });
  call(MSG.AUTH, { action: 'sign-out', requestId: 4 }, { source: stranger });
  await settle();
  assert.deepEqual(posts(), [], 'bound, and still only the parent is heard');
});

test('a parent that is gone (null) never matches a source that is gone (null)', async () => {
  const { host, hello, posts, resolver } = setup();
  host.parent = null;
  host.top = null; // so it is not the nesting rule that turns the hello away
  hello({}, { source: null });
  await settle();
  assert.deepEqual(posts(), []);
  assert.deepEqual(resolver.calls, []);
});

test('after binding, a message from another origin is ignored even when the parent window sent it', async () => {
  const { call, posts, open } = setup();
  await open();
  call(MSG.PING, { requestId: 3 }, { origin: OTHER_ORIGIN });
  await settle();
  assert.deepEqual(posts(), []);
  call(MSG.PING, { requestId: 3 });
  await settle();
  assert.equal(posts().length, 1, 'the bound origin is answered');
});

test('replies go to the bound origin and are never posted to a wildcard', async () => {
  const { call, posts, open, bridge } = setup();
  await open();
  call(MSG.PING, { requestId: 1 });
  call(MSG.CALL, { service: 'Users', action: 'current', requestId: 2 });
  call(MSG.AUTH, { action: 'sign-out', requestId: 3 });
  bridge.pushAuth();
  bridge.pushCommerce('order-updated', { orderId: 'o1' });
  await settle();
  assert.ok(posts().length >= 5);
  assert.ok(posts().every((p) => p.targetOrigin === APP_ORIGIN), JSON.stringify(posts().map((p) => p.targetOrigin)));
});

test('a message that arrives before api:ready is not served', async () => {
  const gate = deferred();
  const auth = fakeAuth({ restore: () => gate.promise });
  const { hello, call, posts, bridge } = setup({ auth });
  hello();
  await settle();
  assert.equal(bridge.state.bound.origin, APP_ORIGIN, 'bound at the hello');
  call(MSG.PING, { requestId: 5 });
  call(MSG.AUTH, { action: 'sign-out', requestId: 6 });
  await settle();
  assert.deepEqual(posts(), [], 'nothing is answered until the host has said ready');
  assert.equal(auth.signOutCalls, 0);

  gate.resolve(null);
  await settle();
  assert.deepEqual(posts().map((p) => p.data.name), [MSG.READY]);
});

// ---------------------------------------------------------------------------
// The nesting rule
// ---------------------------------------------------------------------------

test('a nested host answers nested and serves nothing', async () => {
  const { host, hello, call, posts, resolver, bridge } = setup({ start: false });
  host.top = {}; // the app page is itself framed: parent !== top
  bridge.start();

  hello();
  await settle();
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].data.name, MSG.ERROR);
  assert.equal(posts()[0].data.message.code, HOST_ERRORS.NESTED);
  assert.equal(typeof posts()[0].data.message.message, 'string');
  assert.equal(posts()[0].targetOrigin, APP_ORIGIN, 'answered to the sender origin');
  assert.deepEqual(resolver.calls, []);
  assert.equal(bridge.state.bound, null);

  call(MSG.PING, { requestId: 1 });
  hello();
  await settle();
  assert.equal(posts().length, 2, 'only the second hello answers, again with nested');
  assert.equal(posts()[1].data.message.code, HOST_ERRORS.NESTED);
});

test('a host that is not framed at all answers nested', async () => {
  const { host, hello, posts, bridge } = setup({ start: false });
  host.parent = host;
  host.top = host;
  bridge.start();

  hello({}, { source: host });
  await settle();
  // `win.parent` is the window itself here, so that is where the answer goes.
  assert.equal(host.posted.length, 1);
  assert.equal(host.posted[0].data.message.code, HOST_ERRORS.NESTED);
  assert.equal(host.posted[0].targetOrigin, APP_ORIGIN);
  assert.deepEqual(posts(), []);
});

test('an ancestor outside the allowed origins makes the host answer nested', async () => {
  const refused = [
    ['https://evil.example'],
    ['https://valuguru.app.evil.example'],
    ['https://evilvaluguru.app'],
    ['https://valuguru.app'],
    ['http://demo-ws-1.valuguru.app'],
    ['https://demo-ws-1.valuguru.app:8443'],
    ['null'],
    ['https://demo-ws-1.valuguru.app', 'https://evil.example'],
  ];
  for (const ancestors of refused) {
    const { hello, last, posts, resolver } = setup({ ancestors });
    hello();
    await settle();
    assert.equal(posts().length, 1, `${ancestors}`);
    assert.equal(last().data.message.code, HOST_ERRORS.NESTED, `${ancestors}`);
    assert.deepEqual(resolver.calls, [], `${ancestors}`);
  }

  const served = setup({ ancestors: ['https://demo-ws-1.valuguru.app'] });
  served.hello();
  await settle();
  assert.equal(served.last().data.name, MSG.READY);

  const deeper = setup({ ancestors: ['https://a.b.valuguru.app'] });
  deeper.hello();
  await settle();
  assert.equal(deeper.last().data.name, MSG.READY, 'a pattern like a CSP source covers any depth');
});

test('allowedAncestors is configurable and localhost ancestors count only in dev', async () => {
  const local = ['http://localhost:3005'];

  const prod = setup({ appOrigin: LOCAL_ORIGIN, ancestors: local, resolver: fakeResolver({ [LOCAL_ORIGIN]: APP }) });
  prod.hello();
  await settle();
  assert.equal(prod.last().data.message.code, HOST_ERRORS.NESTED, 'a localhost parent is not allowed in production');

  const dev = setup({
    appOrigin: LOCAL_ORIGIN, ancestors: local, config: { dev: true }, resolver: fakeResolver({ [LOCAL_ORIGIN]: APP }),
  });
  dev.hello();
  await settle();
  assert.equal(dev.last().data.name, MSG.READY);

  const lookalike = setup({
    appOrigin: 'http://localhost.evil.example:3005',
    ancestors: ['http://localhost.evil.example:3005'],
    config: { dev: true },
  });
  lookalike.hello();
  await settle();
  assert.equal(lookalike.last().data.message.code, HOST_ERRORS.NESTED);

  const custom = setup({
    ancestors: ['https://shop.example'], config: { allowedAncestors: ['https://shop.example'] },
    appOrigin: 'https://shop.example', resolver: fakeResolver({ 'https://shop.example': APP }),
  });
  custom.hello();
  await settle();
  assert.equal(custom.last().data.name, MSG.READY);
});

// ---------------------------------------------------------------------------
// The dev claim
// ---------------------------------------------------------------------------

test('dev: a localhost parent may claim an app and the resolver is not asked', async () => {
  const resolver = fakeResolver({});
  const auth = fakeAuth();
  const { hello, last, bridge } = setup({ appOrigin: LOCAL_ORIGIN, resolver, auth, config: { dev: true } });
  hello({ app: 'ws_9/playground' });
  await settle();

  assert.deepEqual(resolver.calls, []);
  assert.equal(last().data.name, MSG.READY);
  assert.equal(last().data.message.applicationId, 'ws_9/playground');
  assert.deepEqual(bridge.state.bound.app, {
    address: 'ws_9/playground', workspaceId: 'ws_9', slug: 'playground', devAppId: null, name: 'playground', homeNetworkId: null,
  });
  assert.deepEqual(auth.restoreCalls, [{ homeNetworkId: null }]);
});

test('dev claim: ignored in production, from a non-localhost origin, and when malformed', async () => {
  const claim = { app: 'ws_evil/steal' };

  const prod = setup({ appOrigin: LOCAL_ORIGIN, resolver: fakeResolver({}) });
  prod.hello(claim);
  await settle();
  assert.equal(prod.last().data.message.code, HOST_ERRORS.UNKNOWN_APP, 'dev:false asks the resolver, which does not know localhost');
  assert.equal(prod.resolver.calls.length, 1);

  const remote = setup({ config: { dev: true } });
  remote.hello(claim);
  await settle();
  assert.equal(remote.last().data.message.applicationId, 'ws_1/demo', 'the resolver, not the claim, names the app');
  assert.equal(remote.resolver.calls.length, 1);

  const lookalike = setup({
    appOrigin: 'http://localhost.evil.example', config: { dev: true }, resolver: fakeResolver({}),
  });
  lookalike.hello(claim);
  await settle();
  assert.equal(lookalike.last().data.message.code, HOST_ERRORS.UNKNOWN_APP);

  for (const bad of ['playground', '/playground', 'ws_9/', 'a/b/c', 'ws 9/play', 42]) {
    const dev = setup({ appOrigin: LOCAL_ORIGIN, config: { dev: true }, resolver: fakeResolver({}) });
    dev.hello({ app: bad });
    await settle();
    assert.equal(dev.last().data.message.code, HOST_ERRORS.UNKNOWN_APP, `claim ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

test('a restored session connects the master and api:ready says signedIn with the user and network', async () => {
  const auth = fakeAuth({ session: SESSION });
  const maker = fakeMaker();
  const { hello, posts, bridge } = setup({ auth, maker });
  hello();
  await settle();

  assert.deepEqual(maker.sessions, ['sess-SECRET-1']);
  assert.equal(posts().length, 1);
  assert.deepEqual(posts()[0].data.message.host, {
    protocol: 1,
    mode: 'dedicated',
    signedIn: true,
    user: { id: 'u1', name: 'Ada Lovelace' },
    network: { id: 'n1', name: 'Roomful' },
  });
  assert.deepEqual(bridge.state, {
    bound: { origin: APP_ORIGIN, app: APP },
    signedIn: true,
    user: { id: 'u1', name: 'Ada Lovelace' },
    network: { id: 'n1', name: 'Roomful' },
  });
  assert.ok(!JSON.stringify(posts()).includes('sess-SECRET-1'), 'the session never crosses the boundary');
});

test('a session the master refuses (session_expired) is cleared and the app is told signedIn:false', async () => {
  const auth = fakeAuth({ session: SESSION });
  const maker = fakeMaker({ error: codedError('session_expired') });
  const { hello, posts, bridge } = setup({ auth, maker });
  hello();
  await settle();

  assert.equal(auth.signOutCalls, 1, 'the dead session is forgotten');
  assert.equal(maker.connections[0].closed, 1, 'and its connection closed');
  assert.equal(posts()[0].data.name, MSG.READY);
  assert.equal(posts()[0].data.message.host.signedIn, false);
  assert.equal(bridge.state.signedIn, false);
});

test('a master that cannot be reached keeps the session and answers signedIn:false', async () => {
  const auth = fakeAuth({ session: SESSION });
  const maker = fakeMaker({ error: codedError('unavailable') });
  const { hello, posts, logs } = setup({ auth, maker });
  hello();
  await settle();

  assert.equal(auth.signOutCalls, 0, 'unreachable is not expired');
  assert.equal(maker.connections[0].closed, 1);
  assert.equal(posts()[0].data.message.host.signedIn, false);
  assert.ok(logs.every((l) => !l.message.includes('sess-SECRET-1')));
});

test('a restore that never answers is treated as no session after restoreTimeoutMs', async () => {
  const auth = fakeAuth({ restore: () => new Promise(() => {}) });
  const maker = fakeMaker();
  const { hello, posts } = setup({ auth, maker, config: { restoreTimeoutMs: 15 } });
  hello();
  await new Promise((resolve) => { setTimeout(resolve, 60); });

  assert.equal(posts().length, 1);
  assert.equal(posts()[0].data.name, MSG.READY);
  assert.equal(posts()[0].data.message.host.signedIn, false);
  assert.equal(maker.sessions.length, 0);
});

test('the restore timer does not outlive a restore that answered', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
  const before = timers();
  const { hello, names } = setup({ auth: fakeAuth({ session: null }) });
  hello();
  await settle();
  assert.deepEqual(names(), [MSG.READY]);
  assert.equal(timers(), before, 'a 5 s timer left behind would hold a closing page, and a test process, open');
});

test('a restore that fails is treated as no session', async () => {
  const auth = fakeAuth({ restore: () => { throw new Error('storage is gone'); } });
  const { hello, posts, logs } = setup({ auth });
  hello();
  await settle();
  assert.equal(posts()[0].data.message.host.signedIn, false);
  assert.equal(logs.length, 1);
});

test('the session store, the real auth and the real resolver, end to end', async () => {
  const storage = new FakeStorage();
  const sessionStore = new SessionStore({ storage });
  sessionStore.set({ userId: 'u1', networkId: 'net-1', sessionId: 'sess-REAL' });
  const maker = fakeMaker();
  const auth = new HostAuth({
    sessionStore, fetchImpl: fakeAuthFetch({ check: 200 }), makeConnection: (id) => maker.make(id),
  });
  const resolver = new AppResolver({ fetchImpl: fakeResolveFetch({ [APP_ORIGIN]: APP }), baseUrl: HOST_ORIGIN });
  const { hello, call, last, bridge } = setup({ auth, resolver, maker, sessionStore });

  hello();
  await settle();
  assert.equal(last().data.message.host.signedIn, true);
  assert.deepEqual(maker.sessions, ['sess-REAL']);

  call(MSG.AUTH, { action: 'sign-out', requestId: 8 });
  await settle();
  assert.equal(sessionStore.load(), null, 'the stored session is gone');
  assert.equal(maker.connections[0].closed, 1);
  assert.equal(bridge.state.signedIn, false);
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

test('host:ping answers host:pong and echoes the request id', async () => {
  const { call, posts, open } = setup();
  await open();
  call(MSG.PING, { requestId: 41 });
  await settle();
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].data.name, MSG.PONG);
  assert.equal(posts()[0].data.requestId, 41);
});

test('replies carry target valuApi and a numeric top-level requestId', async () => {
  const { call, posts, open } = setup();
  await open();
  const requests = [
    [MSG.PING, { requestId: 7 }],
    [MSG.CALL, { service: 'Users', action: 'current', requestId: 8 }],
    [MSG.SERVICE_INTENT, { applicationId: 'Commerce', action: 'list-products', requestId: 9 }],
    [MSG.RUN_INTENT, { requestId: 10 }],
    [MSG.CREATE_POINTER, { requestId: 11 }],
    [MSG.RUN, { requestId: 12 }],
    [MSG.RUN_CONSOLE, { requestId: 13 }],
    [MSG.AUTH, { action: 'sign-out', requestId: 14 }],
  ];
  for (const [name, message] of requests) call(name, message);
  await settle();

  const replies = posts().filter((p) => p.data.name !== MSG.TRIGGER);
  assert.deepEqual(replies.map((p) => p.data.requestId), [7, 8, 9, 10, 11, 12, 13, 14]);
  for (const { data } of posts()) {
    assert.equal(data.target, 'valuApi');
    assert.ok(Object.hasOwn(data, 'requestId'), 'the key is always there, as toParent writes it');
  }
});

test('a request id that is not a number is not echoed', async () => {
  const { call, posts, open } = setup();
  await open();
  call(MSG.PING, { requestId: '7' });
  call(MSG.PING, { requestId: { evil: true } });
  call(MSG.PING, {});
  await settle();
  assert.equal(posts().length, 3);
  assert.deepEqual(posts().map((p) => p.data.requestId), [undefined, undefined, undefined]);
});

test('api:call and api:service-intent answer not_available until they are served', async () => {
  const { call, posts, open } = setup();
  await open();
  call(MSG.CALL, { service: 'Users', action: 'current', params: {}, requestId: 1 });
  call(MSG.SERVICE_INTENT, { applicationId: 'Commerce', action: 'list-products', params: {}, requestId: 2 });
  await settle();

  assert.equal(posts()[0].data.name, MSG.CALL_COMPLETED);
  assert.deepEqual(posts()[0].data.message, { error: { status: true, code: 501, message: 'not_available' } });
  assert.equal(posts()[1].data.name, MSG.RUN_CONSOLE_COMPLETED);
  assert.equal(posts()[1].data.message.error.code, 'not_available');
  assert.equal(typeof posts()[1].data.message.error.message, 'string');
});

test('the four refused names answer with their usual reply and not_available', async () => {
  const { call, posts, open } = setup();
  await open();
  const table = [
    [MSG.RUN_INTENT, MSG.RUN_COMPLETED],
    [MSG.CREATE_POINTER, MSG.POINTER_CREATED],
    [MSG.RUN, MSG.RUN_COMPLETED],
    [MSG.RUN_CONSOLE, MSG.RUN_CONSOLE_COMPLETED],
  ];
  for (const [index, [name]] of table.entries()) call(name, { requestId: index + 1 });
  await settle();

  assert.deepEqual(posts().map((p) => p.data.name), table.map(([, reply]) => reply));
  for (const { data } of posts()) {
    assert.equal(data.message.error.code, 'not_available');
    assert.equal(typeof data.message.error.message, 'string');
  }
});

test('api:run-command and unknown names are ignored', async () => {
  const { call, posts, open } = setup();
  await open();
  call(MSG.RUN_COMMAND, { requestId: 1, command: 'x' });
  call('api:invented', { requestId: 2 });
  call('host:consent', { requestId: 3 });
  call(MSG.PONG, { requestId: 4 });
  call('__proto__', { requestId: 5 });
  call('toString', { requestId: 6 });
  await settle();
  assert.deepEqual(posts(), []);
});

test('a message with no name is ignored without throwing', async () => {
  const { send, posts, open, bridge } = setup();
  const junk = [
    undefined, null, 'text', 42, true, [], [1, 2], {}, { message: {} }, { name: 7, message: {} },
    { name: null, message: {} }, { name: {}, message: {} }, { name: MSG.PING }, { name: MSG.PING, message: null },
    { name: MSG.PING, message: 'x' }, { name: MSG.PING, message: [1] },
    { name: MSG.HELLO }, { name: MSG.AUTH, message: 'sign-out' },
    Object.create(null),
  ];
  for (const [index, data] of junk.entries()) assert.doesNotThrow(() => send(data), `before: junk[${index}]`);
  await settle();
  assert.deepEqual(posts(), []);
  assert.equal(bridge.state.bound, null);

  await open();
  for (const [index, data] of junk.entries()) assert.doesNotThrow(() => send(data), `after: junk[${index}]`);
  await settle();
  assert.deepEqual(posts(), []);
});

test('a hostile event does not throw out of the listener', async () => {
  const { host, posts, open } = setup();
  await open();
  const throwing = { get data() { throw new Error('boom'); }, origin: APP_ORIGIN, source: host.parent };
  assert.doesNotThrow(() => { for (const listener of [...host.listeners]) listener(throwing); });
  assert.doesNotThrow(() => { for (const listener of [...host.listeners]) listener(null); });
  assert.doesNotThrow(() => { for (const listener of [...host.listeners]) listener(undefined); });
  await settle();
  assert.deepEqual(posts(), []);
});

// ---------------------------------------------------------------------------
// Sign-out and pushes
// ---------------------------------------------------------------------------

test('sign-out pushes auth signedIn:false, then answers host:auth-completed', async () => {
  const auth = fakeAuth({ session: SESSION });
  const maker = fakeMaker();
  const { call, posts, open, bridge } = setup({ auth, maker });
  await open();
  assert.equal(bridge.state.signedIn, true);

  call(MSG.AUTH, { action: 'sign-out', requestId: 21 });
  await settle();

  assert.equal(auth.signOutCalls, 1);
  assert.equal(maker.connections[0].closed, 1, 'the master connection is closed');
  assert.equal(posts().length, 2);
  assert.equal(posts()[0].data.name, MSG.TRIGGER);
  assert.equal(posts()[0].data.requestId, undefined, 'a push answers nothing');
  assert.deepEqual(posts()[0].data.message, { action: 'auth', data: { signedIn: false, user: null, network: null } });
  assert.equal(posts()[1].data.name, MSG.AUTH_COMPLETED);
  assert.equal(posts()[1].data.requestId, 21);
  assert.deepEqual(posts()[1].data.message, { ok: true });
  assert.deepEqual(bridge.state, { bound: { origin: APP_ORIGIN, app: APP }, signedIn: false, user: null, network: null });
});

test('sign-out while signed out still answers ok', async () => {
  const auth = fakeAuth();
  const { call, posts, open } = setup({ auth });
  await open();
  call(MSG.AUTH, { action: 'sign-out', requestId: 2 });
  await settle();
  assert.equal(auth.signOutCalls, 1);
  assert.deepEqual(posts().map((p) => p.data.name), [MSG.TRIGGER, MSG.AUTH_COMPLETED]);
  assert.deepEqual(posts()[1].data.message, { ok: true });
});

test('an unknown host:auth action answers not_available', async () => {
  const auth = fakeAuth();
  const { call, posts, open } = setup({ auth });
  await open();
  call(MSG.AUTH, { action: 'sign-in', requestId: 3 });
  call(MSG.AUTH, { requestId: 4 });
  await settle();
  assert.equal(auth.signOutCalls, 0);
  assert.deepEqual(posts().map((p) => [p.data.name, p.data.requestId]), [[MSG.AUTH_COMPLETED, 3], [MSG.AUTH_COMPLETED, 4]]);
  assert.equal(posts()[0].data.message.error.code, 'not_available');
});

test('pushAuth says the current state, with a reason when there is one', async () => {
  const { posts, open, bridge } = setup({ auth: fakeAuth({ session: SESSION }) });
  await open();
  bridge.pushAuth();
  bridge.pushAuth('session_expired');
  assert.deepEqual(posts()[0].data.message, {
    action: 'auth',
    data: { signedIn: true, user: { id: 'u1', name: 'Ada Lovelace' }, network: { id: 'n1', name: 'Roomful' } },
  });
  assert.equal(posts()[1].data.message.data.reason, 'session_expired');
  assert.ok(posts().every((p) => p.data.name === MSG.TRIGGER && p.data.requestId === undefined));
});

test('pushCommerce sends the event name and its data, and the event name wins', async () => {
  const { posts, open, bridge } = setup();
  await open();
  bridge.pushCommerce('order-updated', { orderId: 'o1', status: 'paid' });
  bridge.pushCommerce('cart-updated', { event: 'forged', count: 2 });
  assert.equal(posts()[0].data.name, MSG.TRIGGER);
  assert.deepEqual(posts()[0].data.message, {
    action: 'commerce', data: { event: 'order-updated', orderId: 'o1', status: 'paid' },
  });
  assert.deepEqual(posts()[1].data.message.data, { event: 'cart-updated', count: 2 });
});

test('a push before the host is bound and ready goes nowhere', async () => {
  const { posts, bridge, host } = setup();
  bridge.pushAuth();
  bridge.pushCommerce('order-updated', {});
  assert.deepEqual(posts(), []);
  assert.deepEqual(host.posted, []);
});

test('an outbound payload that carries a credential is replaced and logged', async () => {
  const { posts, open, bridge, logs } = setup();
  await open();
  bridge.pushCommerce('order-updated', { nested: { session_token: 'sekret-value-1' } });

  assert.equal(posts().length, 1);
  assert.equal(posts()[0].data.name, MSG.TRIGGER);
  assert.deepEqual(posts()[0].data.message, { error: { code: 'internal', message: 'blocked outbound credential' } });
  assert.equal(posts()[0].targetOrigin, APP_ORIGIN);
  assert.ok(!JSON.stringify(posts()).includes('sekret-value-1'));
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'error');
  assert.ok(!logs[0].message.includes('sekret-value-1'), 'the log names the key, never the value');
  assert.match(logs[0].message, /session_token/);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('start is idempotent and stop removes the listener and closes the master connection', async () => {
  const auth = fakeAuth({ session: SESSION });
  const maker = fakeMaker();
  const { bridge, host, hello, call, posts, open } = setup({ auth, maker });
  bridge.start();
  assert.equal(host.listeners.size, 1);
  await open();

  await bridge.stop();
  assert.equal(host.listeners.size, 0);
  assert.equal(maker.connections[0].closed, 1);
  assert.equal(bridge.state.signedIn, false);

  hello();
  call(MSG.PING, { requestId: 1 });
  await settle();
  assert.deepEqual(posts(), [], 'a stopped bridge answers nothing');
  await assert.doesNotReject(() => bridge.stop(), 'stop is idempotent');
});

test('a stopped bridge cannot be started again', async () => {
  const { bridge, host } = setup();
  await bridge.stop();
  assert.throws(() => bridge.start(), /cannot be started again/);
  assert.equal(host.listeners.size, 0);
});

test('stop while the master is still connecting closes it and sends no api:ready', async () => {
  const gate = deferred();
  const maker = fakeMaker({ connect: () => gate.promise });
  const { bridge, hello, posts } = setup({ auth: fakeAuth({ session: SESSION }), maker });
  hello();
  await settle();
  assert.equal(maker.connections.length, 1);

  const stopping = bridge.stop();
  assert.equal(maker.connections[0].closed, 1, 'the half-open connection is closed at once');
  gate.resolve(INFO);
  await stopping;
  await settle();
  assert.deepEqual(posts(), []);
  assert.equal(bridge.state.signedIn, false);
});

test('stop while the resolver is still answering binds nothing', async () => {
  const gate = deferred();
  const resolver = { async resolve() { await gate.promise; return APP; } };
  const { bridge, hello, posts } = setup({ resolver });
  hello();
  await settle();
  await bridge.stop();
  gate.resolve();
  await settle();
  assert.deepEqual(posts(), []);
  assert.equal(bridge.state.bound, null);
});

test('the constructor refuses a missing window, resolver, auth or makeConnection', () => {
  const ok = {
    win: FakeWindowPair().host,
    resolver: fakeResolver(),
    auth: fakeAuth(),
    makeConnection: () => ({}),
    config: { hostOrigin: HOST_ORIGIN },
  };
  assert.doesNotThrow(() => new HostBridge(ok));
  for (const key of ['win', 'resolver', 'auth', 'makeConnection']) {
    assert.throws(() => new HostBridge({ ...ok, [key]: undefined }), TypeError, key);
  }
  assert.throws(() => new HostBridge(), TypeError);
});

test('the factories for the later tasks are accepted and not called by the skeleton', async () => {
  const called = [];
  const { open, call, posts } = setup({
    auth: fakeAuth({ session: SESSION }),
    makeServices: () => { called.push('services'); },
    makeGuru: () => { called.push('guru'); },
    makeGrants: () => { called.push('grants'); },
    commerce: {},
    permissions: {},
  });
  await open();
  call(MSG.AUTH, { action: 'sign-out', requestId: 1 });
  await settle();
  assert.deepEqual(called, []);
  assert.equal(posts().at(-1).data.name, MSG.AUTH_COMPLETED);
});

// ---------------------------------------------------------------------------
// The default services factory
// ---------------------------------------------------------------------------

test('the default makeServices serves over the master socket for the app slug, with the Valu origins', () => {
  const socket = { emit: async () => ({ data: {} }), userId: 'u1', selfUserId: 'u1', networkId: 'n1' };
  const fetchImpl = async () => ({ ok: true });
  const services = defaultMakeServices(fetchImpl)({ socket }, APP);

  assert.equal(services.socket, socket);
  assert.equal(services.transport.applicationId, 'demo', 'the slug, stamped by the host');
  assert.deepEqual({ ...services.transport.config }, { webBase: 'https://live.valuverse.io', apiGate: 'https://api.roomful.net' });
  assert.equal(services.cache, null, 'no cache in the host');
});
