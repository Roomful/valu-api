// ===========================================================================
// HostBridge — the host iframe's message handler: handshake, binding, the
// nesting rule, the dispatch table, sign-out, ping and pushes (spec §4.3,
// §4.5). What `api:call`, `api:service-intent` and `host:consent` do is in
// `host-bridge-calls.test.js`; the sign-in token channel is a later task.
//
// Everything runs on the fakes and the harness in `test/helpers/hostBridgeFakes.js`
// (`setup`, `fakeResolver`, `fakeAuth`, `fakeMaker`); `settle()` lets the bridge's
// async steps finish. Replies are read from `app.posted`, and sent into the host
// with `host.dispatch`; one test runs the round trip through `host.postMessage`
// and an app listener.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HostBridge, defaultMakeServices } from '../../src/host/HostBridge.js';
import { AppResolver } from '../../src/host/AppResolver.js';
import { HostAuth } from '../../src/host/HostAuth.js';
import { SessionStore } from '../../src/host/SessionStore.js';
import { MSG, HOST_ERRORS, PROTOCOL_VERSION } from '../../src/host/protocol.js';
import { FakeWindowPair, FakeStorage, fakeResolveFetch, fakeAuthFetch } from '../helpers/hostFakes.js';
import {
  APP_ORIGIN, HOST_ORIGIN, OTHER_ORIGIN, LOCAL_ORIGIN, APP, INFO, SESSION,
  settle, deferred, codedError, fakeResolver, fakeAuth, fakeMaker, setup,
} from '../helpers/hostBridgeFakes.js';

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
    host: { protocol: 1, mode: 'dedicated', signedIn: false, user: null, network: null, connection: 'signed_out' },
  });
  assert.deepEqual(bridge.state, {
    bound: { origin: APP_ORIGIN, app: APP }, signedIn: false, user: null, network: null, connection: 'signed_out', lastError: null,
  });
});

test('round trip: the app page writes to the iframe and its own listener hears the host answer', async () => {
  const { app, host, bridge } = setup({ auth: fakeAuth({ session: SESSION }) });
  const heard = [];
  app.addEventListener('message', (event) => heard.push(event));

  host.postMessage({ name: MSG.HELLO, message: { protocol: PROTOCOL_VERSION, client: 'test' } }, HOST_ORIGIN);
  await settle();
  assert.equal(heard.length, 1);
  assert.equal(heard[0].origin, HOST_ORIGIN, 'the host answers from its own origin');
  assert.equal(heard[0].source, host);
  assert.equal(heard[0].data.name, MSG.READY);
  assert.equal(heard[0].data.message.host.signedIn, true);

  host.postMessage({ name: MSG.PING, message: { requestId: 5 } }, HOST_ORIGIN);
  assert.equal(heard.length, 2);
  assert.equal(heard[1].data.name, MSG.PONG);
  assert.equal(heard[1].data.requestId, 5);
  assert.deepEqual(app.dropped, [], 'every reply reached the app: none was aimed at another origin');
  assert.equal(bridge.state.bound.origin, APP_ORIGIN);
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
  const { hello, send, posts, open, resolver, bridge } = setup();
  await open();
  const sentBefore = posts().length;

  // The forged event: another origin, but the parent window as its source.
  hello({}, { origin: OTHER_ORIGIN });
  hello({ protocol: 99 }, { origin: OTHER_ORIGIN });
  send({ name: MSG.PING, message: { requestId: 1 } }, { origin: OTHER_ORIGIN });
  await settle();

  assert.equal(posts().length, sentBefore, 'the bound origin receives nothing new');
  assert.ok(posts().every((p) => p.targetOrigin !== OTHER_ORIGIN), 'nothing is posted to the stranger');
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
    connection: 'ready',
  });
  assert.deepEqual(bridge.state, {
    bound: { origin: APP_ORIGIN, app: APP },
    signedIn: true,
    user: { id: 'u1', name: 'Ada Lovelace' },
    network: { id: 'n1', name: 'Roomful' },
    connection: 'ready',
    lastError: null,
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
  assert.deepEqual(posts()[1].data.message, {
    action: 'auth', data: { signedIn: false, user: null, network: null, reason: 'session_expired' },
  }, 'and told why, right after api:ready');
  assert.equal(posts().length, 2);
});

// A stored session (spec §4.11): api:ready waits at most readyWaitMs (5 s) for the master; a master
// that cannot be reached is not a sign-out, and is tried again until it opens or refuses the session.

const STORED_USER = { id: 'u1', name: null };
const FULL = { signedIn: true, user: { id: 'u1', name: 'Ada Lovelace' }, network: { id: 'n1', name: 'Roomful' } };
/** What the host pushed after api:ready, as `[action, data]`. */
const pushed = (posts) => posts.filter((p) => p.data.name === MSG.TRIGGER).map((p) => [p.data.message.action, p.data.message.data]);

test('a stored session whose master cannot be reached stays signed in, is told unavailable, and is retried', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const auth = fakeAuth({ session: SESSION });
  const maker = fakeMaker();
  maker.opens = ['fail', 'ok'];
  const { hello, posts, logs, bridge } = setup({ auth, maker });
  hello();
  await settle();

  assert.equal(auth.signOutCalls, 0, 'unreachable is not expired');
  assert.equal(maker.connections[0].closed, 0, 'the connection is kept, to be tried again');
  assert.equal(posts()[0].data.name, MSG.READY);
  assert.deepEqual(posts()[0].data.message.host, {
    protocol: 1, mode: 'dedicated', signedIn: true, user: STORED_USER, network: null, connection: 'reconnecting',
  }, 'signed in, as storage knows the user');
  assert.deepEqual(pushed(posts()), [
    ['auth', { signedIn: true, user: STORED_USER, network: null, reason: 'unavailable' }],
  ]);
  assert.equal(bridge.state.signedIn, true);
  assert.equal(bridge.state.connection, 'reconnecting');
  assert.ok(logs.every((l) => !l.message.includes('sess-SECRET-1')));

  t.mock.timers.tick(1200); // the first retry: 1 s, +-20 %
  await settle();
  assert.equal(maker.connections[0].connects, 2);
  assert.deepEqual(pushed(posts()).slice(1), [['auth', FULL], ['connection', { state: 'ready' }]], 'then who the user is, then ready');
  assert.equal(bridge.state.connection, 'ready');
  await bridge.stop();
});

test('api:ready waits at most readyWaitMs (5 s) for a slow master, then says connecting with the stored user', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const opening = deferred();
  const maker = fakeMaker();
  maker.opens = [opening.promise];
  const { hello, posts, bridge } = setup({ auth: fakeAuth({ session: { ...SESSION, networkId: 'net-1' } }), maker });
  hello();
  await settle();
  t.mock.timers.tick(4999);
  await settle();
  assert.deepEqual(posts(), [], 'not before the 5 s');

  t.mock.timers.tick(1);
  await settle();
  assert.equal(posts().length, 1);
  assert.deepEqual(posts()[0].data.message.host, {
    protocol: 1, mode: 'dedicated', signedIn: true, user: STORED_USER, network: { id: 'net-1', name: null }, connection: 'connecting',
  });

  opening.resolve('ok');
  await settle();
  assert.deepEqual(pushed(posts()), [['auth', FULL], ['connection', { state: 'ready' }]]);
  assert.equal(bridge.state.connection, 'ready');
  await bridge.stop();
});

test('a slow master that fails after api:ready is pushed reconnecting, then ready when a retry opens it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const opening = deferred();
  const maker = fakeMaker();
  maker.opens = [opening.promise, 'fail', 'ok'];
  const { hello, posts, bridge } = setup({ auth: fakeAuth({ session: SESSION }), maker });
  hello();
  await settle();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(posts()[0].data.message.host.connection, 'connecting');

  opening.resolve('fail');
  await settle();
  t.mock.timers.tick(1200); // 1 s, +-20 %: fails again
  await settle();
  t.mock.timers.tick(2400); // 2 s, +-20 %: opens
  await settle();
  assert.deepEqual(pushed(posts()), [
    ['connection', { state: 'reconnecting' }],
    ['auth', { signedIn: true, user: STORED_USER, network: null, reason: 'unavailable' }],
    ['auth', FULL],
    ['connection', { state: 'ready' }],
  ], 'connecting (in api:ready), reconnecting (before the unavailable auth), ready');
  assert.equal(maker.connections[0].connects, 3);
  await bridge.stop();
});

test('a stored session the master refuses during the retries is signed out, as at the hello', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const auth = fakeAuth({ session: SESSION });
  const maker = fakeMaker();
  maker.opens = ['fail', 'expire'];
  const { hello, call, posts, bridge } = setup({ auth, maker });
  hello();
  await settle();
  t.mock.timers.tick(1200);
  await settle();

  assert.equal(bridge.state.signedIn, false);
  assert.equal(auth.signOutCalls, 1, 'the refused session is forgotten');
  assert.equal(maker.connections[0].closed, 1);
  assert.deepEqual(pushed(posts()).slice(1), [
    ['auth', { signedIn: false, user: null, network: null, reason: 'session_expired' }],
    ['connection', { state: 'signed_out' }],
  ]);
  t.mock.timers.tick(100_000);
  await settle();
  assert.equal(maker.connections[0].connects, 2, 'and nothing is retried after that');
  call(MSG.CALL, { service: 'Users', action: 'current', requestId: 3 });
  await settle();
  assert.equal(posts().at(-1).data.message.error.message, 'sign_in_required');
});

test('a slow master that refuses the session after api:ready signs the user out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const opening = deferred();
  const auth = fakeAuth({ session: SESSION });
  const maker = fakeMaker();
  maker.opens = [opening.promise];
  const { hello, posts, bridge } = setup({ auth, maker });
  hello();
  await settle();
  t.mock.timers.tick(5000);
  await settle();
  opening.resolve('expire');
  await settle();
  assert.equal(bridge.state.signedIn, false);
  assert.equal(auth.signOutCalls, 1);
  assert.deepEqual(pushed(posts()), [
    ['auth', { signedIn: false, user: null, network: null, reason: 'session_expired' }],
    ['connection', { state: 'signed_out' }],
  ]);
});

test('stop ends the retries of a stored session and the wait for api:ready, and leaves no timer', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
  const before = timers();
  const retrying = fakeMaker();
  retrying.opens = ['fail'];
  const failing = setup({ auth: fakeAuth({ session: SESSION }), maker: retrying });
  failing.hello();
  await settle();
  const slow = fakeMaker();
  slow.opens = [new Promise(() => {})];
  const waiting = setup({ auth: fakeAuth({ session: SESSION }), maker: slow });
  waiting.hello();
  await settle();
  assert.ok(timers() >= before + 2, 'a retry is booked, and api:ready is waited for');

  await failing.bridge.stop();
  await waiting.bridge.stop();
  assert.equal(timers(), before, 'nothing is left to fire');
  assert.deepEqual(waiting.posts(), [], 'a stopped host says nothing');
});

test('the network coming back retries a stored session that was waiting at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const maker = fakeMaker();
  maker.opens = ['fail', 'ok'];
  const env = setup({ auth: fakeAuth({ session: SESSION }), maker });
  env.host.navigator = { onLine: false };
  env.hello();
  await settle();
  assert.equal(env.posts()[0].data.message.host.connection, 'offline');
  t.mock.timers.tick(100_000);
  await settle();
  assert.equal(maker.connections[0].connects, 1, 'nothing is tried while the browser is offline');

  env.host.navigator.onLine = true;
  env.host.fire('online');
  await settle();
  assert.equal(maker.connections[0].connects, 2);
  assert.deepEqual(pushed(env.posts()).slice(-2), [['auth', FULL], ['connection', { state: 'ready' }]]);
  await env.bridge.stop();
});

test('a stored session that could not be checked is resumed, not signed out', async () => {
  const storage = new FakeStorage();
  const sessionStore = new SessionStore({ storage });
  sessionStore.set({ userId: 'u1', networkId: 'net-1', sessionId: 'sess-REAL' });
  const maker = fakeMaker();
  const down = async () => { throw new TypeError('Failed to fetch'); };
  const auth = new HostAuth({ sessionStore, fetchImpl: down, makeConnection: (id) => maker.make(id) });
  const { hello, last, bridge } = setup({ auth, sessionStore, maker });
  hello();
  await settle();
  assert.equal(last().data.message.host.signedIn, true, 'the master socket said it stands');
  assert.deepEqual(maker.sessions, ['sess-REAL']);
  assert.equal(sessionStore.get('net-1').sessionId, 'sess-REAL');
  await bridge.stop();
});

test('a restore that never answers falls back on what storage holds after restoreTimeoutMs', async () => {
  const auth = fakeAuth({ restore: () => new Promise(() => {}), stored: SESSION });
  const maker = fakeMaker();
  const { hello, posts, bridge } = setup({ auth, maker, config: { restoreTimeoutMs: 15 } });
  hello();
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  assert.equal(posts()[0].data.name, MSG.READY);
  assert.equal(posts()[0].data.message.host.signedIn, true);
  assert.deepEqual(maker.sessions, ['sess-SECRET-1'], 'resumed unchecked: the master connection is what tells');
  await bridge.stop();
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
  // The synchronous replies come first; a call and an intent are answered when their work ends.
  assert.deepEqual(replies.map((p) => p.data.requestId).sort((a, b) => a - b), [7, 8, 9, 10, 11, 12, 13, 14]);
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
  call(MSG.CONSENT_COMPLETED, { requestId: 3 });
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

test('sign-out pushes auth signedIn:false and connection signed_out, then answers host:auth-completed', async () => {
  const auth = fakeAuth({ session: SESSION });
  const maker = fakeMaker();
  const { call, posts, open, bridge } = setup({ auth, maker });
  await open();
  assert.equal(bridge.state.signedIn, true);

  call(MSG.AUTH, { action: 'sign-out', requestId: 21 });
  await settle();

  assert.equal(auth.signOutCalls, 1);
  assert.equal(maker.connections[0].closed, 1, 'the master connection is closed');
  assert.equal(posts().length, 3);
  assert.equal(posts()[0].data.name, MSG.TRIGGER);
  assert.equal(posts()[0].data.requestId, undefined, 'a push answers nothing');
  assert.deepEqual(posts()[0].data.message, { action: 'auth', data: { signedIn: false, user: null, network: null } });
  assert.deepEqual(posts()[1].data.message, { action: 'connection', data: { state: 'signed_out' } });
  assert.equal(posts()[2].data.name, MSG.AUTH_COMPLETED);
  assert.equal(posts()[2].data.requestId, 21);
  assert.deepEqual(posts()[2].data.message, { ok: true });
  assert.deepEqual(bridge.state, {
    bound: { origin: APP_ORIGIN, app: APP }, signedIn: false, user: null, network: null, connection: 'signed_out', lastError: null,
  });
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
  const { posts, bridge } = setup();
  bridge.pushAuth();
  bridge.pushCommerce('order-updated', {});
  assert.deepEqual(posts(), []);
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

test('the factories are lazy: a handshake, a ping and a sign-out call none of them', async () => {
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

// ---------------------------------------------------------------------------
// The config, and the dev gate
// ---------------------------------------------------------------------------

test('dev is on only for the boolean true: a truthy string or number does not open the resolver bypass', async () => {
  const claim = { app: 'ws_evil/steal' };
  for (const dev of ['false', 'true', 'yes', '1', 1, 2, {}, [], () => true, 'dev']) {
    const resolver = fakeResolver({});
    const { hello, last, bridge } = setup({ appOrigin: LOCAL_ORIGIN, resolver, config: { dev } });
    hello(claim);
    await settle();
    assert.equal(resolver.calls.length, 1, `dev: ${String(dev)} still asks the resolver`);
    assert.equal(last().data.name, MSG.ERROR, `dev: ${String(dev)}`);
    assert.equal(last().data.message.code, HOST_ERRORS.UNKNOWN_APP, `dev: ${String(dev)}`);
    assert.equal(bridge.state.bound, null, `dev: ${String(dev)}`);
  }
  for (const dev of [undefined, null, false, 0, '']) {
    const resolver = fakeResolver({});
    const { hello, last } = setup({ appOrigin: LOCAL_ORIGIN, resolver, config: { dev } });
    hello(claim);
    await settle();
    assert.equal(last().data.message.code, HOST_ERRORS.UNKNOWN_APP, `dev: ${String(dev)}`);
  }

  const on = setup({ appOrigin: LOCAL_ORIGIN, resolver: fakeResolver({}), config: { dev: true } });
  on.hello(claim);
  await settle();
  assert.equal(on.last().data.message.applicationId, 'ws_evil/steal', 'the one value that does turn it on');
});

test('dev does not open the dev ancestors either, unless it is the boolean true', async () => {
  for (const dev of ['false', 1, {}]) {
    const { hello, last } = setup({
      appOrigin: LOCAL_ORIGIN, ancestors: [LOCAL_ORIGIN], resolver: fakeResolver({ [LOCAL_ORIGIN]: APP }), config: { dev },
    });
    hello();
    await settle();
    assert.equal(last().data.message.code, HOST_ERRORS.NESTED, `dev: ${String(dev)}`);
  }
});

test('the config is copied at construction: changing the object afterwards changes nothing', async () => {
  const config = { dev: false, allowedAncestors: ['https://*.valuguru.app'] };
  const resolver = fakeResolver({});
  const { hello, last } = setup({ appOrigin: LOCAL_ORIGIN, resolver, config });
  config.dev = true;
  config.allowedAncestors.push('http://localhost:*');
  hello({ app: 'ws_evil/steal' });
  await settle();
  assert.equal(last().data.message.code, HOST_ERRORS.UNKNOWN_APP);
  assert.equal(resolver.calls.length, 1);
});

test('a missing or mistyped config value takes its default: undefined does not become a zero timeout', async () => {
  // The session takes 30 ms to check. A restore timeout of 0 (or 1) would call
  // the user signed out; the 5 s default lets it finish.
  const slowSession = () => new Promise((resolve) => { setTimeout(() => resolve(SESSION), 30); });
  const bad = [undefined, null, 0, -5, NaN, Infinity, '10', '', {}, [], true];
  for (const restoreTimeoutMs of bad) {
    const { hello, last, maker } = setup({
      auth: fakeAuth({ restore: slowSession }), config: { restoreTimeoutMs, readyWaitMs: restoreTimeoutMs },
    });
    hello();
    await new Promise((resolve) => { setTimeout(resolve, 80); });
    assert.equal(last().data.name, MSG.READY, `restoreTimeoutMs: ${String(restoreTimeoutMs)}`);
    assert.equal(last().data.message.host.signedIn, true, `restoreTimeoutMs: ${String(restoreTimeoutMs)}`);
    assert.equal(maker.sessions.length, 1);
  }
});

test('stop clears the timers of a handshake that is still waiting on the resolver or the restore', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
  const before = timers();
  const resolving = setup({ resolver: { resolve: () => new Promise(() => {}) } });
  resolving.hello();
  await settle();
  const restoring = setup({ auth: fakeAuth({ restore: () => new Promise(() => {}) }) });
  restoring.hello();
  await settle();
  assert.ok(timers() > before, 'the two waits are bounded by timers');

  await resolving.bridge.stop();
  await restoring.bridge.stop();
  assert.equal(timers(), before, 'a stopped host leaves no timer behind');
  assert.deepEqual([...resolving.posts(), ...restoring.posts()], []);
});

test('a missing origin list takes its default and cannot throw inside the queue', async () => {
  const ancestors = ['https://demo-ws-1.valuguru.app'];
  const { hello, last, logs } = setup({
    ancestors, config: { allowedAncestors: undefined, devAncestors: undefined, signInOrigins: undefined },
  });
  hello();
  await settle();
  assert.equal(last().data.name, MSG.READY);
  assert.deepEqual(logs, []);
});

test('a mistyped origin list is empty, so it refuses: it never widens to the default', async () => {
  // The default would let this ancestor in; a list that is not a list must not.
  const ancestors = ['https://demo-ws-1.valuguru.app'];
  for (const allowedAncestors of [null, 'https://demo-ws-1.valuguru.app', 7, true, {}, { length: 1, 0: 'https://demo-ws-1.valuguru.app' }]) {
    const { hello, last, logs } = setup({ ancestors, config: { allowedAncestors } });
    hello();
    await settle();
    assert.equal(last().data.message.code, HOST_ERRORS.NESTED, `allowedAncestors: ${JSON.stringify(allowedAncestors)}`);
    assert.deepEqual(logs, [], 'refused without throwing inside the queue');
  }

  // The dev list the same way: dev is on, the ancestor is a localhost one, the list is mistyped.
  for (const devAncestors of [null, 'http://localhost:*', 5, {}]) {
    const { hello, last } = setup({
      appOrigin: LOCAL_ORIGIN, ancestors: [LOCAL_ORIGIN], resolver: fakeResolver({ [LOCAL_ORIGIN]: APP }), config: { dev: true, devAncestors },
    });
    hello();
    await settle();
    assert.equal(last().data.message.code, HOST_ERRORS.NESTED, `devAncestors: ${JSON.stringify(devAncestors)}`);
  }

  // A list with nothing usable in it allows nobody, the same.
  for (const allowedAncestors of [[], [123, null, {}]]) {
    const { hello, last } = setup({ ancestors, config: { allowedAncestors } });
    hello();
    await settle();
    assert.equal(last().data.message.code, HOST_ERRORS.NESTED, JSON.stringify(allowedAncestors));
  }
});

test('a timeout above what a timer holds is capped, not passed on', async () => {
  // setTimeout fires a delay above 2^31-1 at once (with a warning), so a restore
  // timeout of 1e12 would have called the user signed out immediately.
  const slowSession = () => new Promise((resolve) => { setTimeout(() => resolve(SESSION), 30); });
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    timers.push(ms);
    return realSetTimeout(fn, ms, ...rest);
  };
  try {
    for (const restoreTimeoutMs of [1e12, 2 ** 31, Number.MAX_SAFE_INTEGER, 1.7976931348623157e308]) {
      timers.length = 0;
      const { hello, last, maker } = setup({
        auth: fakeAuth({ restore: slowSession }), config: { restoreTimeoutMs, resolveTimeoutMs: restoreTimeoutMs },
      });
      hello();
      await new Promise((resolve) => { realSetTimeout(resolve, 80); });
      assert.equal(last().data.message.host.signedIn, true, `restoreTimeoutMs: ${restoreTimeoutMs}`);
      assert.equal(maker.sessions.length, 1);
      assert.ok(timers.every((ms) => ms <= 2_147_483_647), `a timer was armed above the cap: ${timers.join(', ')}`);
      assert.ok(timers.includes(2_147_483_647), 'the capped value is the largest a timer holds');
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('the constructor takes a missing, null or non-object config as all defaults', async () => {
  for (const config of [undefined, null, 'dev', 7, []]) {
    const { app, host } = FakeWindowPair({ appOrigin: APP_ORIGIN, hostOrigin: HOST_ORIGIN });
    const bridge = new HostBridge({
      win: host, resolver: fakeResolver(), auth: fakeAuth(), makeConnection: () => ({}), config, log: () => {},
    });
    bridge.start();
    host.dispatch({ data: { name: MSG.HELLO, message: { protocol: 1 } }, origin: APP_ORIGIN, source: app });
    await settle();
    assert.equal(app.posted.at(-1).data.name, MSG.READY, `config: ${String(config)}`);
  }
});

// ---------------------------------------------------------------------------
// The resolver is bounded
// ---------------------------------------------------------------------------

test('a resolver that never answers gives resolve_unavailable after resolveTimeoutMs and does not wedge the next hello', async () => {
  const late = deferred();
  const resolver = {
    calls: [],
    resolve(origin) {
      resolver.calls.push(origin);
      return resolver.calls.length === 1 ? late.promise : Promise.resolve(APP);
    },
  };
  const { hello, posts, bridge, logs } = setup({ resolver, config: { resolveTimeoutMs: 15 } });

  hello();
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].data.name, MSG.ERROR);
  assert.equal(posts()[0].data.message.code, 'resolve_unavailable');
  assert.equal(posts()[0].targetOrigin, APP_ORIGIN);
  assert.equal(bridge.state.bound, null, 'a timed-out resolve binds nothing');
  assert.equal(logs.length, 1);

  // The queue moved on: the next hello is resolved, and answered.
  hello();
  await settle();
  assert.equal(posts().at(-1).data.name, MSG.READY);
  assert.equal(bridge.state.bound.origin, APP_ORIGIN);

  // The first lookup finishing now changes nothing.
  late.resolve({ ...APP, address: 'ws_late/stale' });
  await settle();
  assert.equal(posts().length, 2);
  assert.equal(bridge.state.bound.app.address, 'ws_1/demo');
});

test('a resolver that answers in time leaves no timer behind', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
  const before = timers();
  const { hello, names } = setup({ resolver: fakeResolver({ [APP_ORIGIN]: null }) });
  hello();
  await settle();
  assert.deepEqual(names(), [MSG.ERROR]);
  assert.equal(timers(), before, 'the 10 s resolve timer is cleared when the lookup answers');
});

// ---------------------------------------------------------------------------
// Order of the hello checks
// ---------------------------------------------------------------------------

test('a hello from another origin is dropped before any refusal is considered', async () => {
  const { host, hello, posts, open } = setup();
  await open();
  host.top = {}; // from now on this page is nested: the bound origin hears about it, a stranger hears nothing

  hello({}, { origin: OTHER_ORIGIN });
  hello({ protocol: 99 }, { origin: OTHER_ORIGIN });
  await settle();
  assert.deepEqual(posts(), [], 'not even a nested error for a stranger');

  hello();
  await settle();
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].data.message.code, HOST_ERRORS.NESTED);
  assert.equal(posts()[0].targetOrigin, APP_ORIGIN);
});

// ---------------------------------------------------------------------------
// 127.0.0.1, and the protocol field
// ---------------------------------------------------------------------------

test('dev: a hello from http://127.0.0.1 may claim an app and its ancestors are allowed', async () => {
  const origin = 'http://127.0.0.1:5173';
  const resolver = fakeResolver({});
  const dev = setup({ appOrigin: origin, ancestors: [origin], resolver, config: { dev: true } });
  dev.hello({ app: 'ws_9/playground' });
  await settle();
  assert.deepEqual(resolver.calls, []);
  assert.equal(dev.last().data.name, MSG.READY);
  assert.equal(dev.last().data.message.applicationId, 'ws_9/playground');
  assert.equal(dev.last().targetOrigin, origin);

  const prod = setup({ appOrigin: origin, ancestors: [origin], resolver: fakeResolver({ [origin]: APP }) });
  prod.hello({ app: 'ws_9/playground' });
  await settle();
  assert.equal(prod.last().data.message.code, HOST_ERRORS.NESTED, 'a 127.0.0.1 ancestor is not allowed in production');

  const claimOnly = setup({ appOrigin: origin, resolver: fakeResolver({}) });
  claimOnly.hello({ app: 'ws_9/playground' });
  await settle();
  assert.equal(claimOnly.last().data.message.code, HOST_ERRORS.UNKNOWN_APP, 'and a claim from it is not honoured in production');
});

test('a hello with no protocol, or one that is not a number, is served as protocol 1', async () => {
  for (const protocol of [undefined, null, '1', '2', 'two', NaN, {}, [], true, 0, -1, 1]) {
    const { hello, posts, last } = setup();
    hello({ protocol });
    await settle();
    assert.equal(posts().length, 1, `protocol: ${String(protocol)}`);
    assert.equal(last().data.name, MSG.READY, `protocol: ${String(protocol)}`);
    assert.equal(last().data.message.host.protocol, PROTOCOL_VERSION);
  }
  const noField = setup();
  noField.send({ name: MSG.HELLO, message: {} });
  await settle();
  assert.equal(noField.last().data.name, MSG.READY, 'a hello with an empty message is a hello');
});
