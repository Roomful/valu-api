// ===========================================================================
// The two doors: a socket this package opens from a session, and one it adopts
// because the runtime already has it (docs/connecting.md).
//
// What is actually under test here is that nothing above the door can tell
// which one was used — so every behavioural assertion is made through the
// ordinary function surface, not against the connection's internals.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openValuSocket, adoptValuSocket } from '../src/socket/open.js';
import { ValuSocketConnection } from '../src/socket/ValuSocketConnection.js';
import { SocketIoSocketAdapter } from '../src/socket/SocketIoSocketAdapter.js';
import { BrowserSocketAdapter } from '../src/socket/BrowserSocketAdapter.js';
import { NodeSocketAdapter } from '../src/socket/NodeSocketAdapter.js';
import { isValuSocket, VALU_SOCKET } from '../src/socket/ValuSocket.js';
import { connectValuServices, createValuServices } from '../src/services/api.js';
import { ERROR_CODES } from '../src/Errors.js';
import {
  Responder, FakeWebSocketService, FakeRoomfulConnection, FakeIoSocket,
  fakeIo, readyIo, fakeBootstrapFetch,
} from './helpers/fakes.js';

const SESSION = 'sess-7f3c-NOT-A-REAL-TOKEN';

/**
 * Let the microtasks run. `connect()` awaits before it builds the socket, so a
 * test that wants to drive the handshake by hand has to wait for it to exist.
 */
const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/** The RPC behind `Users.current` and `Users.get`, as the platform answers it. */
const USERS_RPC = 'social:getUsersSimpleInfo';
const currentUser = () => new Responder({
  [USERS_RPC]: { data: { users: [{ id: 'user-1', firstName: 'Ada', lastName: 'Lovelace' }] } },
});

// ---------------------------------------------------------------------------
// Door two: adopt a socket that is already authorized.
// ---------------------------------------------------------------------------

test('an already-adapted socket is used as it is, never wrapped twice', async () => {
  const responder = new Responder();
  const browser = new BrowserSocketAdapter({ socket: new FakeWebSocketService(responder), userId: 'u-1' });
  const node = new NodeSocketAdapter({ connection: new FakeRoomfulConnection(responder) });
  const connection = new ValuSocketConnection({ sessionId: SESSION, io: fakeIo(responder) });

  for (const socket of [browser, node, connection]) {
    assert.equal(adoptValuSocket(socket), socket, 'identity — consumers key per-connection state on it');
    assert.equal(await openValuSocket({ socket }), socket);
  }

  // An UNBRANDED socket that satisfies the interface is indistinguishable from
  // a RoomfulConnectionManager, so it is not guessed at — it goes through the
  // node adapter, which keeps its identity reachable as `underlying`.
  const thirdParty = { emit: async () => ({}), userId: 'u-9', networkId: 'roomful', selfUserId: 'u-9' };
  assert.equal(isValuSocket(thirdParty), false, 'the brand, not a shape');
  assert.equal(adoptValuSocket(thirdParty).underlying, thirdParty,
    'wrapped, but a consumer keying on `underlying ?? socket` sees one connection');
});

test('each kind of connection reaches its own adapter', async () => {
  const responder = currentUser();

  const appService = new FakeWebSocketService(responder);
  const fromApp = adoptValuSocket(appService, { userId: 'user-1' });
  assert.ok(fromApp instanceof BrowserSocketAdapter);
  assert.equal(fromApp.transport, appService);

  const ioSocket = new FakeIoSocket(responder).connect();
  const fromIo = adoptValuSocket(ioSocket, { userId: 'user-1' });
  assert.ok(fromIo instanceof SocketIoSocketAdapter);
  assert.equal(fromIo.transport, ioSocket);

  const connection = new FakeRoomfulConnection(responder);
  const fromNode = adoptValuSocket(connection);
  assert.ok(fromNode instanceof NodeSocketAdapter);
  assert.equal(fromNode.underlying, connection);

  // And all three answer the same function identically — which is the only
  // reason the sorting above is allowed to be invisible to a caller.
  for (const socket of [fromApp, fromIo, fromNode]) {
    const valu = createValuServices({ socket, cache: null });
    assert.equal((await valu.data.Users.current()).user.id, 'user-1');
  }
});

test('a socket.io socket adds the envelope exactly once, and never twice', async () => {
  const responder = currentUser();
  const ioSocket = new FakeIoSocket(responder).connect();
  const socket = adoptValuSocket(ioSocket, { userId: 'user-1' });

  await socket.emit('social:getUsersSimpleInfo', { ids: ['u-1'] });

  assert.deepEqual(ioSocket.wire[0], {
    ns: 'social:getUsersSimpleInfo',
    payload: { data: { ids: ['u-1'] } },
  }, 'the payload is wrapped once — a second {data} answers "not found" for a user that exists');
});

test('the socket.io adapter answers in the envelope when the ack cannot come', async () => {
  // `no-ack`: the platform simply never answers, so the adapter's own timer is
  // the only thing that can settle the call.
  const responder = new Responder({ 'x:y': 'no-ack', 'a:b': 'throw' });
  const ioSocket = new FakeIoSocket(responder).connect();
  const socket = new SocketIoSocketAdapter({ socket: ioSocket, userId: 'u-1' });

  assert.equal((await socket.emit('x:y', {}, 10)).error.code, ERROR_CODES.TIMEOUT);
  assert.equal((await socket.emit('a:b')).error.code, ERROR_CODES.DISCONNECTED);

  ioSocket.connected = false;
  const ack = await socket.emit('x:y');
  assert.equal(ack.error.code, ERROR_CODES.DISCONNECTED);
  assert.match(ack.error.message, /not connected/, 'refused now, rather than after a 30s wait for a lost ack');
});

test('the socket.io adapter takes its identity from user_info, not from a guess', () => {
  const ioSocket = new FakeIoSocket(new Responder()).connect();
  const socket = new SocketIoSocketAdapter({ socket: ioSocket, userId: 'stale-guess' });

  ioSocket.ready({ userId: 'user-42', networkId: 'texpo' });

  assert.equal(socket.selfUserId, 'user-42');
  assert.equal(socket.networkId, 'texpo', 'a socket that reconnected elsewhere must not keep the old network');
});

test('the doors refuse what they cannot sort out', async () => {
  assert.throws(() => adoptValuSocket(null), /needs a socket/);
  assert.throws(() => adoptValuSocket({ userId: 'u-1' }), /no emit\(\)/);
  await assert.rejects(() => openValuSocket({}), /needs `socket`.*or.*`sessionId`/s);
  await assert.rejects(
    () => openValuSocket({ socket: new FakeRoomfulConnection(new Responder()), sessionId: SESSION }),
    /both `socket` and `sessionId`/,
  );
  assert.throws(() => new ValuSocketConnection({}), /needs a sessionId/);
  assert.throws(() => new SocketIoSocketAdapter({ socket: new FakeWebSocketService(new Responder()) }),
    /needs a socket\.io socket/);
});

// ---------------------------------------------------------------------------
// Door one: open it, and authorize it.
// ---------------------------------------------------------------------------

test('the handshake is the one the platform already answers', async () => {
  const responder = new Responder();
  const io = readyIo(responder);

  const socket = await openValuSocket({ sessionId: SESSION, io, bootstrap: false });

  const [{ url, options }] = io.calls;
  assert.match(url, /^wss:\/\/api\.roomful\.net\?sessionId=/);
  assert.ok(url.includes(encodeURIComponent(SESSION)), 'the credential rides the handshake query');
  assert.equal(options.path, '/socket', 'not the socket.io default');
  assert.deepEqual(options.transports, ['websocket']);
  assert.equal(options.upgrade, false, 'polling would re-send the session on every XHR');
  assert.equal(options.autoConnect, false, 'listeners first, so a same-tick user_info is not missed');
  assert.equal(io.last.connects, 1);
  assert.equal(socket.state, 'ready');
});

test('connect resolves on user_info, and takes its identity from it', async () => {
  const responder = new Responder();
  const io = fakeIo(responder);
  const connection = new ValuSocketConnection({ sessionId: SESSION, io, bootstrap: false });

  const ready = connection.connect();
  await flush();
  assert.equal(connection.state, 'connecting');
  assert.equal(connection.connected, false, 'not ready until the platform says who you are');

  io.last.ready({ userId: 'user-99', networkId: 'texpo', name: 'Grace Hopper' });
  assert.equal(await ready, connection, 'connect resolves the connection itself');

  assert.equal(connection.state, 'ready');
  assert.equal(connection.connected, true);
  assert.equal(connection.selfUserId, 'user-99');
  assert.equal(connection.userId, 'user-99');
  assert.equal(connection.networkId, 'texpo');
  assert.equal(connection.displayName, 'Grace Hopper');
  assert.equal(connection.user.id, 'user-99');
  assert.equal(connection.network.fullName, 'Roomful');
  assert.ok(connection.connectedAt > 0);

  // Idempotent: a second connect() is the same handshake, not another one.
  assert.equal(await connection.connect(), connection);
  assert.equal(io.calls.length, 1);
});

test('the bootstrap resolves the network, and may redirect the host', async () => {
  const responder = new Responder();
  const io = readyIo(responder, { networkId: 'texpo' });
  const fetchImpl = fakeBootstrapFetch({
    data: { networkId: 'texpo', endpoint: 'https://zeta.roomful.net' },
  });

  const connection = await new ValuSocketConnection({ sessionId: SESSION, io, fetchImpl }).connect();

  const [{ url, options }] = fetchImpl.calls;
  assert.match(url, /\/api\/v0\/publicRpc\/init\.client$/);
  assert.equal(options.headers['X-Session-Id'], SESSION, 'the session authenticates the bootstrap');
  assert.equal(connection.host, 'zeta.roomful.net');
  assert.match(io.calls[0].url, /^wss:\/\/zeta\.roomful\.net\?/, 'the socket follows the redirect');
  assert.equal(connection.networkId, 'texpo');
});

test('a bootstrap that fails costs the network id and nothing else', async () => {
  const responder = new Responder();
  const io = readyIo(responder);
  const fetchImpl = fakeBootstrapFetch({ status: 401 });

  const connection = await new ValuSocketConnection({ sessionId: SESSION, io, fetchImpl }).connect();

  assert.equal(connection.state, 'ready', 'the handshake carries the credential, not the bootstrap');
  assert.match(connection.describe().lastError, /init\.client HTTP 401/,
    'recorded, because a 401 here is the clearest "this session is dead" there is');
});

test('a handshake the platform never answers fails, and says what that means', async () => {
  const io = fakeIo(new Responder());
  const connection = new ValuSocketConnection({
    sessionId: SESSION, io, bootstrap: false, readyTimeoutMs: 20,
  });

  await assert.rejects(() => connection.connect(), (error) => {
    assert.match(error.message, /user_info timeout after 20ms/);
    assert.match(error.message, /host=api\.roomful\.net/);
    assert.match(error.message, /rejected session/, 'the likely cause, not just the symptom');
    assert.ok(!error.message.includes(SESSION), 'a rejection is the most-logged value this object produces');
    return true;
  });
  assert.equal(connection.state, 'failed');
});

test('the session id is never readable back off the connection', async () => {
  const responder = new Responder();
  const io = readyIo(responder);
  const connection = await new ValuSocketConnection({ sessionId: SESSION, io, bootstrap: false }).connect();

  const described = JSON.stringify(connection.describe());
  assert.ok(!described.includes(SESSION), 'describe() is meant to be safe to print');
  assert.match(described, /redacted/);
  assert.equal(connection.sessionId, undefined, 'there is no getter, by design');
  // Not on the object at all — including as an own enumerable property that a
  // structured log or a dev-tools snapshot would pick up.
  assert.ok(!JSON.stringify(Object.keys(connection)).includes('session'));
});

test('calls over an opened connection never carry the credential', async () => {
  const responder = currentUser();
  const io = readyIo(responder);
  const valu = await connectValuServices({ sessionId: SESSION, io, bootstrap: false, cache: null });

  await valu.data.Users.current();
  await valu.Users.get({ userId: 'user-2' });

  const onTheWire = JSON.stringify(io.last.wire);
  assert.ok(!onTheWire.includes(SESSION), 'the session authorizes the socket; it is not a call parameter');
  assert.ok(onTheWire.length > 2, 'and the calls did happen');
});

test('an emit over a closed connection answers 503 rather than hanging', async () => {
  const responder = currentUser();
  const io = readyIo(responder);
  const connection = await new ValuSocketConnection({ sessionId: SESSION, io, bootstrap: false }).connect();

  await connection.close();

  assert.equal(connection.state, 'closed');
  assert.equal((await connection.emit(USERS_RPC)).error.code, ERROR_CODES.DISCONNECTED);
  assert.equal(io.last.closed, true);
});

test('resource:updated reaches the subscriber, and stops when it unsubscribes', async () => {
  const responder = new Responder();
  const io = readyIo(responder);
  const connection = await new ValuSocketConnection({ sessionId: SESSION, io, bootstrap: false }).connect();

  const seen = [];
  const off = connection.onResourceUpdated((payload) => seen.push(payload));
  io.last.push('resource:updated', { data: { resource: { id: 'r-1' } } });
  off();
  io.last.push('resource:updated', { data: { resource: { id: 'r-2' } } });

  assert.deepEqual(seen.map((p) => p.data.resource.id), ['r-1']);
});

test('any platform push can be subscribed to, and arrives once per handler', async () => {
  const responder = new Responder();
  const io = readyIo(responder);
  const connection = await new ValuSocketConnection({ sessionId: SESSION, io, bootstrap: false }).connect();

  const first = [];
  const second = [];
  connection.on('channel:onMessageCreated', (p) => first.push(p));
  connection.on('channel:onMessageCreated', (p) => second.push(p));
  io.last.push('channel:onMessageCreated', { data: { id: 'm-1' } });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1, 'a second handler must not make the platform push arrive twice');
});

test('a connection that drops and re-authorizes says so', async () => {
  const responder = new Responder();
  const io = readyIo(responder);
  const connection = await new ValuSocketConnection({
    sessionId: SESSION, io, bootstrap: false, recoveryTimeoutMs: 50_000,
  }).connect();

  const recoveries = [];
  connection.onReconnected((info) => recoveries.push(info));

  io.last.drop('transport close');
  assert.equal(connection.state, 'reconnecting');
  assert.equal(connection.connected, false);

  io.last.reopen();
  io.last.ready({ userId: 'user-1', networkId: 'roomful' });

  assert.equal(connection.state, 'ready');
  assert.equal(recoveries.length, 1, 'once — on re-authorization, not on the bare transport connect');
  await connection.close();
});

test('a drop that never recovers is declared lost, once', async () => {
  const responder = new Responder();
  const io = readyIo(responder);
  const lost = [];
  const connection = await new ValuSocketConnection({
    sessionId: SESSION, io, bootstrap: false, recoveryTimeoutMs: 5,
    onConnectionLost: (reason) => lost.push(reason),
  }).connect();

  io.last.drop('transport error');
  io.last.drop('transport error');
  await new Promise((resolve) => { setTimeout(resolve, 40); });

  assert.equal(lost.length, 1, 'the owner is told once, so it can rebuild and re-verify the session');
  assert.match(lost[0], /connection lost: transport error/);
  assert.equal(connection.state, 'failed');
});

// ---------------------------------------------------------------------------
// connectValuServices — the one call that covers both doors.
// ---------------------------------------------------------------------------

test('connectValuServices opens the connection, owns it, and closes it', async () => {
  const responder = currentUser();
  const io = readyIo(responder);

  const valu = await connectValuServices({ sessionId: SESSION, io, bootstrap: false });

  assert.equal((await valu.data.Users.current()).user.id, 'user-1');
  assert.ok(valu.connection instanceof ValuSocketConnection);
  assert.equal(valu.socket, valu.connection, 'the socket it opened is the socket it serves over');
  assert.equal(valu.transport.supportsPush, true, 'a socket.io socket can always subscribe');

  await valu.close();
  assert.equal(io.last.closed, true);
});

test('connectValuServices never closes a connection it was handed', async () => {
  const responder = currentUser();
  const appService = new FakeWebSocketService(responder);

  const valu = await connectValuServices({ socket: appService, userId: 'user-1' });

  assert.equal((await valu.data.Users.current()).user.id, 'user-1');
  assert.equal(valu.connection, null, 'adopted, not owned');
  assert.equal(valu.socket.transport, appService);

  await valu.close();   // the application's socket is still the application's
  assert.equal((await appService.emitAsync(USERS_RPC)).data.users[0].id, 'user-1');
});

test('a reconnect drops the caches nothing can vouch for any more', async () => {
  // `Users.current` resolves the socket's own id, so the answer must keep
  // carrying it; what changes between calls is the name, which is what a
  // second RPC would reveal.
  let serial = 0;
  const responder = new Responder({
    [USERS_RPC]: () => ({ data: { users: [{ id: 'user-1', name: `read-${++serial}` }] } }),
  });
  const io = readyIo(responder);
  const valu = await connectValuServices({
    sessionId: SESSION, io, bootstrap: false, recoveryTimeoutMs: 50_000,
  });

  assert.equal((await valu.data.Users.current()).user.name, 'read-1');
  assert.equal((await valu.data.Users.current()).user.name, 'read-1', 'served from cache — one RPC so far');
  assert.equal(responder.callsTo(USERS_RPC).length, 1);

  io.last.drop();
  io.last.reopen();
  io.last.ready();

  assert.equal((await valu.data.Users.current()).user.name, 'read-2',
    'anything cached predates the gap, and nothing says what changed during it');
  await valu.close();
});

// ---------------------------------------------------------------------------
// docs/connecting.md — the claims that can rot.
// ---------------------------------------------------------------------------

test('the connecting guide still describes this package', async () => {
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(new URL('../docs/connecting.md', import.meta.url), 'utf8');
  const { catalogSummary } = await import('../src/services/descriptors.js');

  assert.match(doc, new RegExp(`${catalogSummary().total} functions`));
  // The two doors, by the names a caller types.
  for (const name of ['openValuSocket', 'connectValuServices', 'adoptValuSocket', 'ValuSocketConnection']) {
    assert.match(doc, new RegExp(name));
  }
  // The adoption table: every row's class is one this package exports, and the
  // sorting the row claims is the sorting `adoptValuSocket` performs.
  const responder = new Responder();
  const rows = [
    [new FakeWebSocketService(responder), BrowserSocketAdapter, 'BrowserSocketAdapter'],
    [new FakeIoSocket(responder), SocketIoSocketAdapter, 'SocketIoSocketAdapter'],
    [new FakeRoomfulConnection(responder), NodeSocketAdapter, 'NodeSocketAdapter'],
  ];
  for (const [input, adapter, name] of rows) {
    assert.ok(adoptValuSocket(input, { userId: 'u-1' }) instanceof adapter, name);
    assert.match(doc, new RegExp(name));
  }
  // The handshake path and the timeout the doc quotes.
  assert.match(doc, /`\/socket`/);
  assert.match(doc, new RegExp(`${ValuSocketConnection.name}`));
  assert.match(doc, /user_info/);
  // And the rule the doc is most likely to outlive: no third-party socket yet.
  assert.match(doc, /third-party/i);
  assert.equal(VALU_SOCKET, Symbol.for('valu.socket'));
});
