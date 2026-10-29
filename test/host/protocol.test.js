import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_VERSION, EMBEDDED_PROTOCOL_VERSION, MSG, HOST_ERRORS, POPUP_MSG, CONNECTION_STATE, toParent, parseAppMessage,
  assertNoHostLeak, identityOf,
} from '../../src/host/protocol.js';
import {
  FakeStorage, FakeGuruSocket, fakeGuruWebSocket, FakeWindowPair, fakeResolveFetch, fakeAuthFetch,
} from '../helpers/hostFakes.js';

// ---------------------------------------------------------------------------
// protocol.js
// ---------------------------------------------------------------------------

test('the protocol constants are frozen and hold the wire names', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.ok(Object.isFrozen(MSG));
  assert.ok(Object.isFrozen(HOST_ERRORS));
  assert.deepEqual(MSG, {
    HELLO: 'host:hello',
    ERROR: 'host:error',
    AUTH: 'host:auth',
    AUTH_COMPLETED: 'host:auth-completed',
    PING: 'host:ping',
    PONG: 'host:pong',
    CALL: 'api:call',
    CALL_COMPLETED: 'api:call-completed',
    READY: 'api:ready',
    TRIGGER: 'api:trigger',
    SERVICE_INTENT: 'api:service-intent',
    RUN_CONSOLE_COMPLETED: 'api:run-console-completed',
    RUN_INTENT: 'api:run-intent',
    RUN_COMPLETED: 'api:run-completed',
    CREATE_POINTER: 'api:create-pointer',
    POINTER_CREATED: 'api:pointer-created',
    RUN: 'api:run',
    RUN_CONSOLE: 'api:run-console',
    RUN_COMMAND: 'api:run-command',
    CONSENT: 'host:consent',
    CONSENT_COMPLETED: 'host:consent-completed',
  });
  assert.equal(new Set(Object.values(MSG)).size, Object.keys(MSG).length, 'no two keys share a name');
  assert.deepEqual(Object.values(HOST_ERRORS).sort(), [
    'unknown_app', 'nested', 'protocol_unsupported', 'sign_in_required',
    'consent_required', 'forbidden', 'not_available', 'busy', 'disconnected', 'host_restarted',
    'host_unreachable', 'popup_blocked', 'cancelled', 'timeout', 'master_mismatch', 'not_a_member',
    'session_expired', 'unknown_function', 'invalid_token', 'signed_out_elsewhere', 'unavailable',
    'invalid_request', 'validation_failed', 'permission_not_declared',
  ].sort());
  for (const [key, code] of Object.entries(HOST_ERRORS)) {
    assert.equal(key, code.toUpperCase(), `${key} is the upper-case spelling of its code`);
  }
});

test('the popup message types and the connection states hold the wire names', () => {
  assert.ok(Object.isFrozen(POPUP_MSG));
  assert.deepEqual(POPUP_MSG, { CONSENT: 'valu-host:consent', TOKEN: 'valu-host:token' });
  assert.ok(Object.isFrozen(CONNECTION_STATE));
  assert.deepEqual(CONNECTION_STATE, {
    CONNECTING: 'connecting', READY: 'ready', RECONNECTING: 'reconnecting', OFFLINE: 'offline', SIGNED_OUT: 'signed_out',
  });
});

test('parseAppMessage rejects non-objects and missing name', () => {
  for (const data of [
    undefined, null, 'api:call', 42, true, [], ['api:call', {}],
    {}, { message: {} },
    { name: 7, message: {} },
    { name: 'api:call' },
    { name: 'api:call', message: null },
    { name: 'api:call', message: 'x' },
    { name: 'api:call', message: [] },
  ]) {
    assert.equal(parseAppMessage(data), null, JSON.stringify(data));
  }
});

test('parseAppMessage reads requestId from inside message', () => {
  const message = { service: 'Users', action: 'current', requestId: 7 };
  assert.deepEqual(parseAppMessage({ name: MSG.CALL, message }), { name: 'api:call', message, requestId: 7 });
  // Absent is absent: the caller decides what an unnumbered request means.
  assert.equal(parseAppMessage({ name: MSG.HELLO, message: { protocol: 1 } }).requestId, undefined);
  // And a value that is not a number is handed through, not coerced.
  assert.equal(parseAppMessage({ name: MSG.CALL, message: { requestId: '7' } }).requestId, '7');
});

test('toParent puts requestId at the top level', () => {
  const message = { data: { ok: true } };
  assert.deepEqual(toParent(MSG.CALL_COMPLETED, message, 12), {
    target: 'valuApi', name: 'api:call-completed', message, requestId: 12,
  });
  // A push has no request to answer; the key is still there, so the shape is fixed.
  const push = toParent(MSG.TRIGGER, { action: 'auth' });
  assert.ok('requestId' in push);
  assert.equal(push.requestId, undefined);
});

test('assertNoHostLeak throws on session_token nested in data', () => {
  assert.throws(
    () => assertNoHostLeak({ data: { session_token: 'x' } }, 'api:call-completed'),
    /api:call-completed.*"data\.session_token"/,
  );
});

test('assertNoHostLeak knows the host credential keys, in any case, at any depth', () => {
  for (const payload of [
    { session_token: 'x' },
    { Token: 'x' },
    { 'X-Session-Id': 'x' },
    { x: { 'x-session-id': 'x' } },
    { data: { oneTimeToken: 'x' } },
    { data: { deeply: { nested: { ONETIMETOKEN: 'x' } } } },
    { list: [{ ok: 1 }, { session_token: 'x' }] },
    // the keys assertNoCredentialLeak already refuses stay refused
    { sessionId: 'x' },
    { nested: { Authorization: 'Bearer x' } },
    { refresh_token: 'x' },
  ]) {
    assert.throws(() => assertNoHostLeak(payload), /would send|credential/, JSON.stringify(payload));
  }
  // The path names the array index too.
  assert.throws(() => assertNoHostLeak({ list: [{ ok: 1 }, { token: 'x' }] }), /"list\.1\.token"/);
});

test('assertNoHostLeak matches whole keys, returns the payload, and survives cycles', () => {
  const clean = { data: { tokenType: 'bearer', tokens: 3, sessionTokenCount: 1, userId: 'u1', name: 'session_token' } };
  assert.equal(assertNoHostLeak(clean, 'x'), clean);
  assert.equal(assertNoHostLeak(null), null);
  assert.equal(assertNoHostLeak('session_token'), 'session_token');
  const cyclic = { a: {} };
  cyclic.a.back = cyclic;
  assert.equal(assertNoHostLeak(cyclic), cyclic);
  cyclic.a.session_token = 'x';
  assert.throws(() => assertNoHostLeak(cyclic), /"a\.session_token"/);
});

// ---------------------------------------------------------------------------
// FakeWindowPair
// ---------------------------------------------------------------------------

test('FakeWindowPair delivers only to matching targetOrigin', () => {
  const { app, host } = new FakeWindowPair();
  const got = [];
  host.addEventListener('message', (event) => got.push(event));

  // The app page writes to the iframe: a message TO host, from app.
  host.postMessage({ name: 'host:hello', message: {} }, host.origin);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].data, { name: 'host:hello', message: {} });
  assert.equal(got[0].origin, app.origin);
  assert.equal(got[0].source, app);

  host.postMessage({ name: 'x', message: {} }, 'https://other');
  assert.equal(got.length, 1, 'a mismatched targetOrigin is dropped');
  assert.deepEqual(host.dropped.map((d) => d.targetOrigin), ['https://other']);

  host.postMessage({ name: 'y', message: {} }, '*');
  assert.equal(got.length, 2, "'*' reaches whoever is there");
  host.postMessage({ name: 'z', message: {} });
  assert.equal(got.length, 2, 'no targetOrigin is not a wildcard');
  host.postMessage({ name: 'w', message: {} }, app.origin);
  assert.equal(got.length, 2, "the caller's own origin is not the called window's");
});

test('FakeWindowPair: the host answers its parent by calling app.postMessage, and each window records the calls made on it', () => {
  const { app, host } = new FakeWindowPair({ appOrigin: 'https://a.example', hostOrigin: 'https://h.example' });
  assert.equal(app.origin, 'https://a.example');
  assert.equal(host.origin, 'https://h.example');
  const got = [];
  app.addEventListener('message', (event) => got.push(event));

  // `host.parent.postMessage(msg, boundOrigin)` in the host's code.
  app.postMessage({ target: 'valuApi', name: 'api:ready', message: {}, requestId: 1 }, 'https://a.example');
  app.postMessage({ name: 'leak' }, '*');
  app.postMessage({ name: 'wrong' }, 'https://h.example');
  assert.equal(got.length, 2);
  assert.equal(got[0].origin, 'https://h.example');
  assert.equal(got[0].source, host);
  assert.deepEqual(got[0].data, { target: 'valuApi', name: 'api:ready', message: {}, requestId: 1 });
  assert.deepEqual(app.posted.map((p) => p.targetOrigin), ['https://a.example', '*', 'https://h.example']);
  assert.deepEqual(app.dropped.map((d) => d.data.name), ['wrong']);
  assert.deepEqual(host.posted, [], 'nothing was posted to the host');
});

test('FakeWindowPair: both directions round-trip, each with the other side as source', () => {
  const { app, host } = new FakeWindowPair();
  const toHost = [];
  const toApp = [];
  host.addEventListener('message', (event) => {
    toHost.push(event);
    // The host answers whoever wrote to it, at that sender's origin.
    event.source.postMessage({ name: 'answer', message: {} }, event.origin);
  });
  app.addEventListener('message', (event) => toApp.push(event));

  host.postMessage({ name: 'ask', message: {} }, host.origin);
  assert.equal(toHost.length, 1);
  assert.equal(toApp.length, 1);
  assert.equal(toApp[0].data.name, 'answer');
  assert.equal(toApp[0].origin, host.origin);
  assert.equal(toApp[0].source, host);
  assert.equal(host.posted.length, 1, 'the ask was a call on host');
  assert.equal(app.posted.length, 1, 'the answer was a call on app');
});

test('FakeWindowPair: delivery is synchronous, structured-cloned, and removable', () => {
  const { app, host } = new FakeWindowPair();
  let seen;
  const listener = (event) => { seen = event.data; };
  host.addEventListener('message', listener);
  host.addEventListener('click', () => {});
  assert.equal(host.listeners.size, 1, 'only message listeners are kept');
  const sent = { name: 'api:call', message: { params: { a: 1 } } };
  host.postMessage(sent, '*');
  assert.deepEqual(seen, sent);
  assert.notEqual(seen, sent, 'the receiver gets a copy, as a real postMessage gives');
  assert.notEqual(seen.message, sent.message);
  assert.throws(() => host.postMessage({ fn() {} }, '*'), { name: 'DataCloneError' });
  assert.throws(() => app.postMessage({ fn() {} }, '*'), { name: 'DataCloneError' });

  seen = undefined;
  host.removeEventListener('message', listener);
  host.postMessage(sent, '*');
  assert.equal(seen, undefined);
});

test('FakeWindowPair: the frame relationships a nesting check reads', () => {
  const { app, host } = new FakeWindowPair();
  assert.equal(host.parent, app);
  assert.equal(host.top, app);
  assert.equal(app.parent, app);
  assert.equal(app.top, app);
  assert.deepEqual(app.frames, [host]);
  const stranger = {};
  host.top = stranger;
  assert.equal(host.top, stranger, 'top is settable, for the nested case');
  assert.equal(host.parent, app);
});

test('FakeWindowPair works called with or without new, and each call is its own pair', () => {
  const plain = FakeWindowPair({ appOrigin: 'https://a.example', hostOrigin: 'https://h.example' });
  assert.equal(plain.app.origin, 'https://a.example');
  assert.equal(plain.host.origin, 'https://h.example');
  assert.equal(plain.host.parent, plain.app);
  assert.deepEqual(plain.app.frames, [plain.host]);
  const defaults = FakeWindowPair();
  assert.equal(defaults.app.origin, 'https://demo-ws-1.valuguru.app');
  assert.equal(defaults.host.origin, 'https://valuguru.texpo.io');
  const viaNew = new FakeWindowPair();
  assert.notEqual(viaNew.app, defaults.app);
  const got = [];
  defaults.host.addEventListener('message', (event) => got.push(event));
  viaNew.host.postMessage({ name: 'x', message: {} }, '*');
  assert.deepEqual(got, [], 'one pair never delivers into another');
});

test('FakeWindowPair.dispatch delivers any event, for a third window', () => {
  const { host } = new FakeWindowPair();
  const got = [];
  host.addEventListener('message', (event) => got.push(event));
  const third = { postMessage() {} };
  const data = { name: 'host:hello', message: {} };
  host.dispatch({ data, origin: 'https://other-ws-1.valuguru.app', source: third });
  assert.equal(got.length, 1);
  assert.equal(got[0].data, data, 'dispatch hands the event over as given');
  assert.equal(got[0].origin, 'https://other-ws-1.valuguru.app');
  assert.equal(got[0].source, third);
});

// ---------------------------------------------------------------------------
// FakeStorage
// ---------------------------------------------------------------------------

test('FakeStorage behaves like Storage, and throws on request', () => {
  const store = new FakeStorage();
  assert.equal(store.getItem('k'), null);
  store.setItem('k', 1);
  assert.equal(store.getItem('k'), '1', 'values are strings, as in a real Storage');
  assert.equal(store.length, 1);
  assert.equal(store.key(0), 'k');
  store.removeItem('k');
  assert.equal(store.getItem('k'), null);

  const noWrite = new FakeStorage({ throwOn: 'set' });
  assert.throws(() => noWrite.setItem('k', 'v'), { name: 'QuotaExceededError' });
  assert.equal(noWrite.getItem('k'), null);
  noWrite.removeItem('k');

  const noRead = new FakeStorage({ throwOn: 'get' });
  noRead.setItem('k', 'v');
  assert.throws(() => noRead.getItem('k'), { name: 'SecurityError' });
  noRead.throwOn = null;
  assert.equal(noRead.getItem('k'), 'v', 'throwOn can be flipped mid-test');
});

// ---------------------------------------------------------------------------
// FakeGuruSocket
// ---------------------------------------------------------------------------

test('FakeGuruSocket records what is sent and delivers what the test scripts', () => {
  const socket = new FakeGuruSocket('wss://guru.test/?token=t');
  assert.equal(socket.url, 'wss://guru.test/?token=t');
  assert.equal(socket.readyState, FakeGuruSocket.CONNECTING);
  assert.throws(() => socket.send('{}'), { name: 'InvalidStateError' });

  const events = [];
  socket.onopen = (e) => events.push(['open', e.type]);
  socket.onmessage = (e) => events.push(['message', JSON.parse(e.data)]);
  socket.onclose = (e) => events.push(['close', e.code]);
  socket.open();
  assert.equal(socket.readyState, FakeGuruSocket.OPEN);

  socket.send(JSON.stringify({ type: 'data_request', requestId: 'r1', op: 'orders.list' }));
  assert.deepEqual(socket.sent, [{ type: 'data_request', requestId: 'r1', op: 'orders.list' }]);
  assert.deepEqual(socket.sentRaw, ['{"type":"data_request","requestId":"r1","op":"orders.list"}']);

  socket.progress('r1', 'queued');
  socket.reply('r1', { data: { rows: [] } });
  socket.reply('r2', { ok: false, error: { code: 'bad', message: 'no' } });
  socket.frame({ type: 'commerce_event', event: 'cart-updated' });
  assert.deepEqual(events, [
    ['open', 'open'],
    ['message', { type: 'data_progress', requestId: 'r1', step: 'queued' }],
    ['message', { type: 'data_response', requestId: 'r1', ok: true, data: { rows: [] } }],
    ['message', { type: 'data_response', requestId: 'r2', ok: false, error: { code: 'bad', message: 'no' } }],
    ['message', { type: 'commerce_event', event: 'cart-updated' }],
  ]);

  socket.drop(1006);
  assert.equal(socket.readyState, FakeGuruSocket.CLOSED);
  assert.deepEqual(events.at(-1), ['close', 1006]);
  socket.send('{}');
  assert.equal(socket.sent.length, 1, 'a closed socket sends nothing');
});

test('FakeGuruSocket.close is the client closing, and fires onclose once', () => {
  const socket = new FakeGuruSocket('wss://guru.test/');
  const closes = [];
  socket.onclose = (e) => closes.push({ code: e.code, reason: e.reason, wasClean: e.wasClean });
  socket.open();
  socket.close(1000, 'bye');
  socket.close(1000, 'again');
  socket.drop();
  assert.deepEqual(closes, [{ code: 1000, reason: 'bye', wasClean: true }]);
  assert.deepEqual(socket.closedWith, { code: 1000, reason: 'bye' });
});

test('fakeGuruWebSocket is a constructor that records every socket it made', async () => {
  const WS = fakeGuruWebSocket();
  const a = new WS('wss://guru.test/?token=1&client=host');
  const b = new WS('wss://guru.test/?token=2&client=host');
  assert.deepEqual(WS.urls, ['wss://guru.test/?token=1&client=host', 'wss://guru.test/?token=2&client=host']);
  assert.deepEqual(WS.sockets, [a, b]);
  assert.equal(WS.last, b);
  assert.ok(a instanceof FakeGuruSocket);
  assert.equal(a.readyState, FakeGuruSocket.CONNECTING, 'nothing opens until the test says so');

  const auto = fakeGuruWebSocket({ autoOpen: true });
  const socket = new auto('wss://guru.test/');
  let opened = 0;
  socket.onopen = () => { opened++; };
  assert.equal(socket.readyState, FakeGuruSocket.CONNECTING);
  await Promise.resolve();
  assert.equal(opened, 1, 'autoOpen opens on the next tick, after the client wired its handlers');
  assert.equal(socket.readyState, FakeGuruSocket.OPEN);
});

// ---------------------------------------------------------------------------
// fetch fakes
// ---------------------------------------------------------------------------

test('fakeResolveFetch answers the resolve lookup from a table', async () => {
  const app = {
    address: 'ws-1/demo', workspaceId: 'ws-1', slug: 'demo', devAppId: null, name: 'Demo', homeNetworkId: 'n1',
  };
  const fetchImpl = fakeResolveFetch({ 'https://demo-ws-1.valuguru.app': app, 'https://gone.valuguru.app': null });
  const url = (origin) => `https://valuguru.texpo.io/api/host/v1/resolve?origin=${encodeURIComponent(origin)}`;

  const hit = await fetchImpl(url('https://demo-ws-1.valuguru.app'));
  assert.equal(hit.ok, true);
  assert.equal(hit.status, 200);
  assert.deepEqual(await hit.json(), { ok: true, app });

  for (const origin of ['https://gone.valuguru.app', 'https://never-heard-of.valuguru.app']) {
    const miss = await fetchImpl(url(origin), { method: 'GET', headers: { Accept: 'application/json' } });
    assert.equal(miss.ok, false);
    assert.equal(miss.status, 404);
    assert.deepEqual(await miss.json(), { ok: false, error: { code: 'unknown_app' } });
  }

  const other = await fetchImpl('https://valuguru.texpo.io/somewhere/else');
  assert.equal(other.status, 500);

  assert.equal(fetchImpl.calls.length, 4);
  assert.deepEqual(fetchImpl.calls[1], {
    url: url('https://gone.valuguru.app'), method: 'GET', headers: { Accept: 'application/json' },
  });
  assert.equal(fetchImpl.calls[0].method, 'GET', 'method defaults to GET');
});

test('fakeAuthFetch signals 401 in the body, as the master does, and redeems tokens', async () => {
  const ok = fakeAuthFetch();
  const checked = await ok('https://api.roomful.net/api/v1/auth/check', { headers: { 'X-Session-Id': 's1' } });
  assert.equal(checked.status, 200);
  assert.deepEqual(await checked.json(), { data: null, error: { status: false, code: 200, message: '' } });

  const expired = fakeAuthFetch({ check: 401 });
  const rejected = await expired('https://api.roomful.net/api/v1/auth/check', { headers: { 'X-Session-Id': 's1' } });
  assert.equal(rejected.status, 200, 'the HTTP status is 200 even for a rejected session');
  assert.equal(rejected.ok, true);
  assert.deepEqual(await rejected.json(), { error: { status: true, code: 401, message: 'Unauthorized' } });

  const redeemed = await ok('https://api.roomful.net/api/v1/auth/checkOneTimeAuthToken/tok-1', { method: 'POST' });
  assert.equal(redeemed.status, 200);
  assert.deepEqual(await redeemed.json(), {
    data: { user_id: 'u1', session_token: 's1', is_new: false, need_verification: false },
    error: { status: false, code: 200, message: '' },
  });
  assert.deepEqual(ok.calls[1], {
    url: 'https://api.roomful.net/api/v1/auth/checkOneTimeAuthToken/tok-1', method: 'POST', headers: undefined,
  });
  assert.deepEqual(ok.calls[0].headers, { 'X-Session-Id': 's1' });
  assert.equal(ok.calls[0].method, 'GET');

  const bad = { error: { status: true, code: 400, message: 'Not found' } };
  const refusing = fakeAuthFetch({ redeem: bad });
  const refused = await refusing('https://api.roomful.net/api/v1/auth/checkOneTimeAuthToken/nope', { method: 'POST' });
  assert.equal(refused.status, 200);
  assert.deepEqual(await refused.json(), bad);

  const unknown = await ok('https://api.roomful.net/api/v1/auth/nothing');
  assert.equal(unknown.status, 500);
  // check is a knob a test can turn mid-way: a session that was good and then is not.
  ok.check = 401;
  assert.equal((await (await ok('https://api.roomful.net/api/v1/auth/check')).json()).error.code, 401);
});

test('identityOf: a user or a network as an app is told it, {id, name}, or null without an id', () => {
  assert.deepEqual(identityOf({ id: 'u1', name: 'Ada', email: 'ada@example.test' }), { id: 'u1', name: 'Ada' });
  assert.deepEqual(identityOf({ id: 'u1' }), { id: 'u1', name: null });
  assert.deepEqual(identityOf({ id: 'u1', name: '' }), { id: 'u1', name: null });
  assert.deepEqual(identityOf({ id: 'u1', name: 5 }), { id: 'u1', name: null });
  for (const value of [undefined, null, 'u1', ['u1'], {}, { id: '' }, { id: 5 }, { name: 'Ada' }]) {
    assert.equal(identityOf(value), null, JSON.stringify(value));
  }
});

test('the embedded protocol has its own version, 1: a bump of the host protocol does not move it', () => {
  assert.equal(EMBEDDED_PROTOCOL_VERSION, 1);
});
