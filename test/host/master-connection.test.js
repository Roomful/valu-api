// ===========================================================================
// MasterConnection — the host's wrapper around the `{sessionId}` door.
//
// Two kinds of test, on purpose. The ones about what a CALLER sees (hold a call
// while the socket reconnects, answer 503 after the grace, deliver pushes) run
// the real `ValuSocketConnection` over `FakeIoSocket`, so they cannot pass
// against a wrapper that only works with a friendly double. The ones about what
// the wrapper does to the INSTANCE (close it, replace it, classify why it
// failed) use a scripted instance through `createConnection`, because the real
// one cannot be made to fail on demand: its watchdog is 120 s and its
// handshake timeout 20 s.
//
// Nothing here waits on a real clock longer than a few tens of milliseconds.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MasterConnection, MASTER_UNAVAILABLE, NETWORK_SWITCH,
} from '../../src/host/MasterConnection.js';
import { ValuSocketConnection } from '../../src/socket/ValuSocketConnection.js';
import { isValuSocket } from '../../src/socket/ValuSocket.js';
import { HOST_ERRORS } from '../../src/host/protocol.js';
import { Responder, readyIo, fakeIo } from '../helpers/fakes.js';
import { fakeAuthFetch } from '../helpers/hostFakes.js';

const SESSION = 'sess-9d2e-NOT-A-REAL-TOKEN';
const USER = { userId: 'u1', networkId: 'n1' };

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const PENDING = Symbol('pending');
/** What `promise` settled to, or PENDING if it had not within `ms`. */
const peek = (promise, ms = 50) => Promise.race([promise, sleep(ms).then(() => PENDING)]);

/** A master over the real connection, on fake sockets. */
function realMaster({ responder, io, fetchImpl, ...options } = {}) {
  const answers = responder ?? new Responder({ x: { data: { ok: true } } });
  const socketFactory = io ?? readyIo(answers, USER);
  const fetcher = fetchImpl ?? fakeAuthFetch();
  const master = new MasterConnection({
    sessionId: SESSION, io: socketFactory, fetchImpl: fetcher, ...options,
  });
  return { master, responder: answers, io: socketFactory, fetchImpl: fetcher };
}

/** The `GET …/auth/check` requests a fake fetch saw (the real connection's init.client POST is not one). */
const checks = (fetchImpl) => fetchImpl.calls.filter((call) => call.url.endsWith('/api/v1/auth/check'));

// ---------------------------------------------------------------------------
// A scripted instance, for the tests about what the wrapper does to it.
// ---------------------------------------------------------------------------

class FakeConnection {
  state = 'idle';
  closeCalls = 0;
  emits = [];
  selfUserId = 'u1';
  userId = 'u1';
  networkId = 'n1';
  user = { id: 'u1' };
  network = { id: 'n1' };
  #handlers = new Map();
  #reconnected = new Set();

  constructor(options, script, index) {
    this.options = options;
    this.script = script;
    this.index = index;
  }

  async connect() {
    await this.script.connect?.(this);
    this.state = 'ready';
    return this;
  }

  emit(ns, data, timeoutMs) {
    this.emits.push({ ns, data, timeoutMs });
    if (this.script.emit) return this.script.emit(this, ns, data, timeoutMs);
    return Promise.resolve({ data: { from: this.index } });
  }

  on(event, handler) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(handler);
    return () => this.#handlers.get(event).delete(handler);
  }

  onReconnected(handler) {
    this.#reconnected.add(handler);
    return () => this.#reconnected.delete(handler);
  }

  async close() {
    this.closeCalls++;
    this.state = 'closed';
  }

  // The test's side.
  push(event, payload) {
    for (const handler of [...(this.#handlers.get(event) ?? [])]) handler(payload);
  }

  drop(reason = 'transport close') {
    this.state = 'reconnecting';
    this.push('disconnect', reason);
  }

  reconnect() {
    this.state = 'ready';
    for (const handler of [...this.#reconnected]) handler({ selfUserId: 'u1', networkId: 'n1' });
  }

  /** What the instance's 120 s watchdog does, without the 120 s. */
  lose(reason = 'connection lost: transport close') {
    this.state = 'failed';
    this.options.onConnectionLost(reason);
  }
}

/** A `createConnection` that builds scripted instances and remembers them. */
function fakeConnections(script = {}) {
  const instances = [];
  const create = (options) => {
    const instance = new FakeConnection(options, script, instances.length);
    instances.push(instance);
    return instance;
  };
  create.instances = instances;
  return create;
}

/** A master over scripted instances. */
function scriptedMaster({ script, fetchImpl, ...options } = {}) {
  const createConnection = fakeConnections(script);
  const fetcher = fetchImpl ?? fakeAuthFetch();
  const master = new MasterConnection({
    sessionId: SESSION, io: () => { throw new Error('the scripted instance never opens a socket'); },
    fetchImpl: fetcher, createConnection, ...options,
  });
  return { master, instances: createConnection.instances, fetchImpl: fetcher };
}

const rejection = async (promise) => {
  try { await promise; } catch (error) { return error; }
  return assert.fail('expected a rejection');
};

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

test('connect resolves user and network from user_info', async () => {
  const { master, io } = realMaster();
  assert.equal(master.state, 'idle');

  const info = await master.connect();

  assert.equal(info.userId, 'u1');
  assert.equal(info.networkId, 'n1');
  assert.equal(info.user.id, 'u1');
  assert.equal(info.network.id, 'n1');
  assert.equal(master.state, 'ready');
  assert.ok(master.socket instanceof ValuSocketConnection, 'the default instance is valu-api\'s own door');
  assert.ok(isValuSocket(master.socket));
  assert.match(io.last.url, /^wss:\/\/api\.roomful\.net\?sessionId=/, 'the host defaults to the production master');
  await master.close();
});

test('connect is idempotent: concurrent callers share one socket, a later one resolves at once', async () => {
  const { master, io } = realMaster();

  const [first, second] = await Promise.all([master.connect(), master.connect()]);
  assert.deepEqual(first, second);
  assert.equal((await master.connect()).userId, 'u1');

  assert.equal(io.sockets.length, 1, 'one handshake, however many callers');
  await master.close();
});

test('connect passes the session, io, host and fetch to the instance exactly as given', async () => {
  const fetchImpl = fakeAuthFetch();
  const io = () => { throw new Error('unused'); };
  const { master, instances } = scriptedMaster({ fetchImpl, io, host: 'dev.roomful.net' });
  await master.connect();

  const [{ options }] = instances;
  assert.equal(options.sessionId, SESSION);
  assert.equal(options.host, 'dev.roomful.net');
  assert.equal(options.io, io, 'the factory is the caller\'s: valu-api must not fall back to its own import');
  assert.equal(options.fetchImpl, fetchImpl, 'the caller binds fetch; the wrapper must not re-wrap it');
  assert.equal(typeof options.onConnectionLost, 'function');
  await master.close();
});

test('constructing without a session is a TypeError, not a connection that fails later', () => {
  assert.throws(() => new MasterConnection({ io: () => {} }), TypeError);
  assert.throws(() => new MasterConnection({ sessionId: '', io: () => {} }), TypeError);
});

// ---------------------------------------------------------------------------
// Hold while reconnecting
// ---------------------------------------------------------------------------

test('emit during reconnecting is held and answered after reopen', async () => {
  const { master, io, responder } = realMaster();
  await master.connect();

  io.last.drop();
  assert.equal(master.state, 'reconnecting');
  const pending = master.emit('x');

  assert.equal(await peek(pending, 50), PENDING, 'held, not answered 503 at once');
  assert.equal(responder.callsTo('x').length, 0, 'and nothing reached the wire while the socket was down');

  io.last.reopen();
  io.last.ready(USER);

  assert.deepEqual(await pending, { data: { ok: true } });
  assert.equal(responder.callsTo('x').length, 1);
  assert.equal(master.state, 'ready');
  await master.close();
});

test('every call held across one outage is answered, in order, after it', async () => {
  const { master, io, responder } = realMaster({
    responder: new Responder({ x: (data) => ({ data: { echo: data.n } }) }),
  });
  await master.connect();

  io.last.drop();
  const held = [1, 2, 3].map((n) => master.emit('x', { n }));
  io.last.reopen();
  io.last.ready(USER);

  assert.deepEqual((await Promise.all(held)).map((ack) => ack.data.echo), [1, 2, 3]);
  assert.equal(responder.callsTo('x').length, 3);
  await master.close();
});

test('emit answers 503 disconnected after the grace', async () => {
  const { master, io, responder } = realMaster({ reconnectGraceMs: 30 });
  await master.connect();

  io.last.drop();
  const startedAt = Date.now();
  const ack = await master.emit('x');

  assert.equal(ack.error.code, 503);
  assert.equal(ack.error.status, true);
  assert.match(ack.error.message, /disconnected/);
  assert.ok(Date.now() - startedAt >= 25, 'it waited the grace out before answering');
  assert.equal(responder.callsTo('x').length, 0, 'a call that never reached the wire is never sent late');

  io.last.reopen();
  io.last.ready(USER);
  assert.deepEqual(await master.emit('x'), { data: { ok: true } }, 'and the connection is usable once it is back');
  await master.close();
});

test('the hold never outlasts the call\'s own timeout', async () => {
  const { master, io } = realMaster({ reconnectGraceMs: 60_000 });
  await master.connect();

  io.last.drop();
  const startedAt = Date.now();
  const ack = await master.emit('x', {}, 30);

  assert.equal(ack.error.code, 503);
  assert.ok(Date.now() - startedAt < 5_000, 'min(grace, timeout): 30 ms, not a minute');
  await master.close();
});

test('time spent held comes off the ack timeout, so the call still ends inside its own budget', async () => {
  const { master, instances } = scriptedMaster();
  await master.connect();

  instances[0].drop();
  const pending = master.emit('x', {}, 1_000);
  await sleep(40);
  instances[0].reconnect();
  await pending;

  const [{ timeoutMs }] = instances[0].emits;
  assert.ok(timeoutMs < 1_000, `waited 40 ms of 1000, so the instance gets less than 1000 (got ${timeoutMs})`);
  assert.ok(timeoutMs > 0);
  await master.close();
});

test('emit never rejects, whatever the instance does', async () => {
  const { master, instances } = scriptedMaster({
    script: { emit: () => { throw new Error('half torn down'); } },
  });
  await master.connect();

  const ack = await master.emit('x');
  assert.equal(ack.error.code, 503);
  assert.match(ack.error.message, /disconnected/);
  assert.equal(instances.length, 1);
  await master.close();
});

test('emit before connect and after close answers 503 at once', async () => {
  const { master } = realMaster();

  const before = await master.emit('x');
  assert.equal(before.error.code, 503);
  assert.match(before.error.message, /disconnected/);

  await master.connect();
  await master.close();
  const after = await master.emit('x');
  assert.equal(after.error.code, 503);
  assert.match(after.error.message, /disconnected.*closed/);
});

// ---------------------------------------------------------------------------
// Replace on failure
// ---------------------------------------------------------------------------

test('failed state replaces the instance on next emit', async () => {
  const { master, instances } = scriptedMaster();
  await master.connect();
  assert.equal(instances.length, 1);

  instances[0].lose();
  assert.equal(master.state, 'failed');
  assert.equal(instances[0].closeCalls, 1, 'the dead instance is closed when it is declared lost, not left retrying');
  assert.equal(master.socket, null, 'there is no live instance until the next call needs one');
  assert.equal(master.lastError.code, MASTER_UNAVAILABLE);
  assert.match(master.lastError.message, /connection lost/);

  const ack = await master.emit('x');

  assert.equal(instances.length, 2, 'createConnection ran again');
  assert.deepEqual(ack, { data: { from: 1 } }, 'the call was answered by the new instance');
  assert.equal(instances[0].emits.length, 0);
  assert.equal(instances[1].options.sessionId, SESSION, 'with the same session');
  assert.equal(master.state, 'ready');
  assert.equal(master.socket, instances[1]);
  await master.close();
});

test('calls made while the replacement connects share it', async () => {
  let release;
  const { master, instances } = scriptedMaster({
    script: { connect: (instance) => (instance.index === 1 ? new Promise((r) => { release = r; }) : undefined) },
  });
  await master.connect();
  instances[0].lose();

  const calls = [master.emit('a'), master.emit('b'), master.emit('c')];
  assert.equal(await peek(Promise.all(calls), 30), PENDING);
  assert.equal(master.state, 'connecting');
  release();
  const acks = await Promise.all(calls);

  assert.equal(instances.length, 2, 'one replacement, not one per call');
  assert.ok(acks.every((ack) => ack.data.from === 1));
  await master.close();
});

test('a replacement that is slow to connect answers the call 503 while the attempt carries on', async () => {
  const { master, instances } = scriptedMaster({
    reconnectGraceMs: 30,
    script: { connect: (instance) => (instance.index === 1 ? new Promise(() => {}) : undefined) },
  });
  await master.connect();
  instances[0].lose();

  const ack = await master.emit('x');
  assert.equal(ack.error.code, 503);
  assert.equal(master.state, 'connecting', 'still trying; the caller has stopped waiting');
  await master.close();
  assert.equal(instances[1].closeCalls, 1, 'closing the master closes the instance still handshaking');
});

test('a replacement that fails leaves the wrapper failed, and the next call replaces again', async () => {
  const { master, instances } = scriptedMaster({
    script: { connect: (instance) => { if (instance.index === 1) throw new Error('handshake failed'); } },
  });
  await master.connect();
  instances[0].lose();

  const ack = await master.emit('x');
  assert.equal(ack.error.code, 503);
  assert.equal(master.state, 'failed');
  assert.equal(instances[1].closeCalls, 1, 'a failed instance is closed too: it would otherwise keep its socket');
  assert.equal(master.lastError.code, MASTER_UNAVAILABLE);

  const retried = await master.emit('x');
  assert.deepEqual(retried, { data: { from: 2 } });
  assert.equal(instances.length, 3);
  await master.close();
});

test('a rejected connect is not sticky: the next connect builds a fresh instance', async () => {
  const { master, instances } = scriptedMaster({
    script: { connect: (instance) => { if (instance.index === 0) throw new Error('refused'); } },
  });

  const error = await rejection(master.connect());
  assert.equal(error.code, MASTER_UNAVAILABLE);
  assert.equal(master.state, 'failed');
  assert.equal(instances[0].closeCalls, 1);

  const info = await master.connect();
  assert.equal(info.userId, 'u1');
  assert.equal(instances.length, 2);
  assert.equal(master.state, 'ready');
  await master.close();
});

test('a state handler that answers a failure by connecting again starts a new attempt, not the old rejection', async () => {
  const { master, instances } = scriptedMaster({
    script: { connect: (instance) => { if (instance.index === 0) throw new Error('refused'); } },
  });
  let retry = null;
  master.onStateChange((state) => { if (state === 'failed') retry = master.connect(); });

  const error = await rejection(master.connect());
  assert.equal(error.code, MASTER_UNAVAILABLE);

  const info = await retry;
  assert.equal(info.userId, 'u1');
  assert.equal(instances.length, 2);
  assert.equal(master.state, 'ready');
  await master.close();
});

test('a reconnect that never re-authorizes is declared lost by the wrapper itself', async () => {
  // The instance clears its own watchdog on the bare socket `connect`, and then
  // waits for `user_info` forever. The wrapper keeps its own.
  const { master, io } = realMaster({ recoveryTimeoutMs: 30 });
  await master.connect();

  io.last.drop();
  io.last.reopen();                       // the transport is back; user_info never follows
  assert.equal(master.state, 'reconnecting');
  await sleep(80);

  assert.equal(master.state, 'failed');
  assert.equal(io.sockets[0].closed, true, 'the zombie socket is closed');
  assert.match(master.lastError.message, /connection lost: transport close/);

  const ack = await master.emit('x');
  assert.deepEqual(ack, { data: { ok: true } }, 'the next call replaced it');
  assert.equal(io.sockets.length, 2);
  await master.close();
});

test('a call held when the connection is declared lost is answered by the replacement, not failed', async () => {
  const { master, io } = realMaster({ recoveryTimeoutMs: 30 });
  await master.connect();

  io.last.drop();
  const held = master.emit('x');             // the default grace: far longer than the 30 ms watchdog
  const ack = await held;

  assert.deepEqual(ack, { data: { ok: true } });
  assert.equal(io.sockets.length, 2, 'the held call waited for the replacement instead of giving up with the old socket');
  assert.equal(io.sockets[0].closed, true);
  await master.close();
});

test('a drop that recovers in time cancels the wrapper\'s watchdog', async () => {
  const { master, io } = realMaster({ recoveryTimeoutMs: 40 });
  await master.connect();

  io.last.drop();
  io.last.reopen();
  io.last.ready(USER);
  await sleep(90);

  assert.equal(master.state, 'ready');
  assert.equal(io.sockets.length, 1);
  await master.close();
});

test('losing the connection mid-handshake fails that attempt instead of hanging it', async () => {
  const { master, instances } = scriptedMaster({
    script: { connect: () => new Promise(() => {}) },
  });

  const attempt = master.connect();
  await sleep(0);
  instances[0].lose('connection lost: transport error');
  const error = await rejection(attempt);

  assert.equal(error.code, MASTER_UNAVAILABLE);
  assert.match(error.message, /connection lost: transport error/);
  assert.equal(master.state, 'failed');
  assert.equal(instances[0].closeCalls, 1);
});

// ---------------------------------------------------------------------------
// 401 classification
// ---------------------------------------------------------------------------

test('connect rejects with session_expired when auth/check says 401', async () => {
  const fetchImpl = fakeAuthFetch({ check: 401 });
  const { master, instances } = scriptedMaster({
    fetchImpl,
    script: { connect: () => { throw new Error('user_info timeout'); } },
  });

  const error = await rejection(master.connect());

  assert.ok(error instanceof Error);
  assert.equal(error.code, 'session_expired');
  assert.equal(error.code, HOST_ERRORS.SESSION_EXPIRED);
  assert.equal(master.state, 'failed');
  assert.equal(master.lastError, error);
  assert.equal(instances[0].closeCalls, 1);
  const [check] = checks(fetchImpl);
  assert.equal(check.url, 'https://api.roomful.net/api/v1/auth/check');
  assert.equal(check.method, 'GET');
  assert.equal(check.headers['X-Session-Id'], SESSION);
});

test('connect rejects with session_expired from the real connection too, without the session in the message', async () => {
  const fetchImpl = fakeAuthFetch({ check: 401 });
  const { master } = realMaster({
    fetchImpl,
    io: () => { throw new Error(`cannot open wss://api.roomful.net?sessionId=${encodeURIComponent(SESSION)}`); },
  });

  const error = await rejection(master.connect());

  assert.equal(error.code, 'session_expired');
  assert.ok(!error.message.includes(SESSION), 'the credential never reaches a message');
  assert.equal(error.cause, undefined, 'and no cause carries the unredacted original');
  assert.equal(checks(fetchImpl).length, 1);
});

test('connect rejects with unavailable when the session is not the problem', async () => {
  const failing = { connect: () => { throw new Error('socket closed'); } };

  const fine = fakeAuthFetch({ check: 200 });
  const ok = scriptedMaster({ fetchImpl: fine, script: failing });
  const refusedNot = await rejection(ok.master.connect());
  assert.equal(refusedNot.code, 'unavailable');
  assert.match(refusedNot.message, /socket closed/);
  assert.equal(checks(fine).length, 1, 'it asked before it answered');

  const down = async () => { throw new TypeError('fetch failed'); };
  const offline = scriptedMaster({ fetchImpl: down, script: failing });
  assert.equal((await rejection(offline.master.connect())).code, 'unavailable', 'a check that cannot run is not a 401');

  const garbled = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('not json'); } });
  const html = scriptedMaster({ fetchImpl: garbled, script: failing });
  assert.equal((await rejection(html.master.connect())).code, 'unavailable', 'nor is a page that is not JSON');
});

test('a check that never answers cannot hold the failure hostage', async () => {
  const hangs = () => new Promise(() => {});
  const { master } = scriptedMaster({
    fetchImpl: hangs,
    authCheckTimeoutMs: 20,
    script: { connect: () => { throw new Error('socket closed'); } },
  });

  const error = await rejection(master.connect());
  assert.equal(error.code, 'unavailable');
  assert.equal(master.state, 'failed');
});

test('a connect that succeeds never asks auth/check', async () => {
  const fetchImpl = fakeAuthFetch({ check: 401 });
  const { master } = scriptedMaster({ fetchImpl });
  await master.connect();
  assert.equal(checks(fetchImpl).length, 0);
  await master.close();
});

test('a dead session is reported, not retried: later calls do not re-handshake it', async () => {
  const fetchImpl = fakeAuthFetch({ check: 401 });
  const { master, instances } = scriptedMaster({
    fetchImpl,
    script: { connect: (instance) => { if (instance.index > 0) throw new Error('refused'); } },
  });
  await master.connect();
  instances[0].lose();

  const first = await master.emit('x');
  assert.equal(first.error.code, 503);
  assert.equal(master.lastError.code, 'session_expired');
  assert.equal(instances.length, 2);

  const second = await master.emit('x');
  assert.equal(second.error.code, 503);
  assert.match(second.error.message, /session expired/);
  assert.equal(instances.length, 2, 'no new instance for a session the master has refused');
  assert.equal(checks(fetchImpl).length, 1);
  await master.close();
});

test('an explicit connect after session_expired is still allowed: the host may have a fresh session in mind', async () => {
  const fetchImpl = fakeAuthFetch({ check: 401 });
  const { master, instances } = scriptedMaster({
    fetchImpl,
    script: { connect: (instance) => { if (instance.index === 1) throw new Error('refused'); } },
  });
  await master.connect();
  instances[0].lose();
  await master.emit('x');
  assert.equal(master.lastError.code, 'session_expired');

  fetchImpl.check = 200;
  const info = await master.connect();
  assert.equal(info.userId, 'u1');
  assert.equal(master.state, 'ready');
  assert.equal(master.lastError, null, 'a connection that works has no last error');
  assert.deepEqual(await master.emit('x'), { data: { from: 2 } }, 'and calls flow again');
  await master.close();
});

// ---------------------------------------------------------------------------
// The state the host reads, and the pushes it forwards
// ---------------------------------------------------------------------------

test('onStateChange reports every transition once, with the state it left', async () => {
  const { master, instances } = scriptedMaster();
  const seen = [];
  const off = master.onStateChange((state, previous) => seen.push(`${previous}>${state}`));

  await master.connect();
  instances[0].drop();
  instances[0].drop();                      // a second drop while down is not a second transition
  instances[0].reconnect();
  instances[0].lose();
  await master.emit('x');
  off();
  await master.close();

  assert.deepEqual(seen, [
    'idle>connecting', 'connecting>ready', 'ready>reconnecting', 'reconnecting>ready',
    'ready>failed', 'failed>connecting', 'connecting>ready',
  ]);
});

test('onStateChange tells a subscriber about close, then lets go of it', async () => {
  const { master } = scriptedMaster();
  const seen = [];
  master.onStateChange((state) => seen.push(state));
  await master.connect();
  await master.close();
  await master.close();                     // idempotent
  assert.deepEqual(seen, ['connecting', 'ready', 'closed']);
  assert.equal(master.state, 'closed');
});

test('onReconnected fires once per recovery with the re-read user_info, and unsubscribes', async () => {
  const { master, io } = realMaster();
  await master.connect();
  const infos = [];
  const off = master.onReconnected((info) => infos.push(info));

  io.last.drop();
  io.last.reopen();
  io.last.ready({ userId: 'u1', networkId: 'n2' });
  assert.equal(infos.length, 1, 'on re-authorization, not on the bare transport connect');
  assert.equal(infos[0].userId, 'u1');
  assert.equal(infos[0].networkId, 'n2');
  assert.equal(infos[0].network.id, 'n2');

  off();
  io.last.drop();
  io.last.reopen();
  io.last.ready(USER);
  assert.equal(infos.length, 1);
  await master.close();
});

test('a handler that throws cannot break the wrapper', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { master, instances } = scriptedMaster();
  master.onStateChange(() => { throw new Error('subscriber bug'); });
  master.onReconnected(() => { throw new Error('subscriber bug'); });

  await master.connect();
  instances[0].drop();
  instances[0].reconnect();

  assert.equal(master.state, 'ready');
  assert.ok(errors.mock.callCount() >= 2, 'reported, not swallowed silently');
  await master.close();
});

test('platform pushes are delegated, and survive the instance being replaced', async () => {
  const { master, instances } = scriptedMaster();
  const seen = [];
  const off = master.on('request:created', (payload) => seen.push(payload));
  await master.connect();

  instances[0].push('request:created', { n: 1 });
  instances[0].lose();
  await master.emit('x');
  instances[1].push('request:created', { n: 2 });
  assert.deepEqual(seen, [{ n: 1 }, { n: 2 }], 'subscribed once, heard from both instances');

  instances[0].push('request:created', { n: 'stale' });
  assert.deepEqual(seen, [{ n: 1 }, { n: 2 }], 'a replaced instance is not listened to');

  master.on('request:created', () => {});
  instances[1].push('request:created', { n: 3 });
  assert.equal(seen.length, 3, 'a second subscriber does not make the first hear a push twice');

  off();
  instances[1].push('request:created', { n: 4 });
  assert.equal(seen.length, 3);
  await master.close();
});

test('pushes subscribed after connect reach the live instance, on the real socket', async () => {
  const { master, io } = realMaster();
  await master.connect();
  const seen = [];
  master.on('channel:onMessageCreated', (payload) => seen.push(payload));

  io.last.push('channel:onMessageCreated', { id: 'm1' });
  assert.deepEqual(seen, [{ id: 'm1' }]);
  await master.close();
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

test('close closes the socket, answers held calls at once, and stops listening', async () => {
  const { master, io } = realMaster();
  await master.connect();
  const seen = [];
  master.on('request:created', (payload) => seen.push(payload));

  io.last.drop();
  const held = master.emit('x');
  await master.close();

  const ack = await peek(held, 100);
  assert.notEqual(ack, PENDING, 'a held call is answered when the master closes, not after its grace');
  assert.equal(ack.error.code, 503);
  assert.equal(io.last.closed, true);
  assert.equal(master.state, 'closed');
  assert.equal(master.socket, null);
  assert.equal(master.lastError, null, 'closing is not an error');
});

test('close during the handshake rejects connect instead of leaving it pending', async () => {
  const { master, instances } = scriptedMaster({ script: { connect: () => new Promise(() => {}) } });

  const attempt = master.connect();
  await sleep(0);
  await master.close();

  const error = await rejection(attempt);
  assert.equal(error.code, MASTER_UNAVAILABLE);
  assert.match(error.message, /closed/);
  assert.equal(instances[0].closeCalls, 1);
  assert.equal(master.state, 'closed');
  assert.equal((await rejection(master.connect())).code, MASTER_UNAVAILABLE, 'and a closed master stays closed');
});

// ---------------------------------------------------------------------------
// network:switch
// ---------------------------------------------------------------------------

test('switchNetwork sends the RPC Valu Social sends', async () => {
  // valusocial-web src/Stores/Application/ApplicationStore.js:731-764, #processNetworkSwitch:
  //   socket.emit('network:switch', { data: { networkId, requestNewSessionId: true } }, ack)
  //   const data = response?.data;  …  sessionId: data.sessionId
  // `emit` here adds the `{data}` envelope itself, so the payload is the inside.
  const responder = new Responder({
    [NETWORK_SWITCH]: () => ({ data: { sessionId: 's2' } }),
  });
  const { master, io } = realMaster({ responder });
  await master.connect();

  const result = await master.switchNetwork('n2');

  assert.equal(NETWORK_SWITCH, 'network:switch');
  assert.deepEqual(result, { sessionId: 's2' });
  assert.deepEqual(io.last.wire.filter((frame) => frame.ns === 'network:switch'), [
    { ns: 'network:switch', payload: { data: { networkId: 'n2', requestNewSessionId: true } } },
  ], 'on the wire: one envelope, requestNewSessionId true, nothing else');
  assert.equal(io.sockets.length, 1, 'switching hands back a session; it does not reconnect this one');
  assert.equal(master.state, 'ready');
  assert.equal(master.socket.networkId, 'n1', 'this connection stays in the network it was in');
  await master.close();
});

test('switchNetwork rejects not_a_member when the master answers without a session', async () => {
  const responder = new Responder({
    [NETWORK_SWITCH]: () => ({ error: { status: true, code: 403, message: 'not a member of this network' } }),
  });
  const { master } = realMaster({ responder });
  await master.connect();

  const error = await rejection(master.switchNetwork('n2'));
  assert.equal(error.code, HOST_ERRORS.NOT_A_MEMBER);
  assert.match(error.message, /n2/);
  assert.match(error.message, /not a member of this network/);

  responder.on(NETWORK_SWITCH, { data: {} });
  assert.equal((await rejection(master.switchNetwork('n2'))).code, HOST_ERRORS.NOT_A_MEMBER,
    'Valu Social treats an answer with no data as a refusal; so does this');
  await master.close();
});

test('switchNetwork rejects unavailable when the call itself could not be made', async () => {
  const { master, io } = realMaster({ reconnectGraceMs: 20 });
  await master.connect();
  io.last.drop();

  const error = await rejection(master.switchNetwork('n2'));
  assert.equal(error.code, MASTER_UNAVAILABLE, 'a dropped socket is not a refusal to join the network');
  assert.equal(io.sockets[0].wire.filter((frame) => frame.ns === 'network:switch').length, 0);
  await master.close();
});

test('switchNetwork is held across a reconnect like any other call', async () => {
  const responder = new Responder({ [NETWORK_SWITCH]: { data: { sessionId: 's2' } } });
  const { master, io } = realMaster({ responder });
  await master.connect();

  io.last.drop();
  const pending = master.switchNetwork('n2');
  assert.equal(await peek(pending, 30), PENDING);
  io.last.reopen();
  io.last.ready(USER);

  assert.deepEqual(await pending, { sessionId: 's2' });
  await master.close();
});

test('switchNetwork needs a network id', async () => {
  const { master } = realMaster();
  await master.connect();
  assert.equal((await rejection(master.switchNetwork(''))).name, 'TypeError');
  assert.equal((await rejection(master.switchNetwork(undefined))).name, 'TypeError');
  await master.close();
});

// ---------------------------------------------------------------------------
// The harness itself: the first test above would pass against a connection
// that never talks to the fake, so pin that the fake socket is what answered.
// ---------------------------------------------------------------------------

test('the real connection is what these tests drive', async () => {
  const io = fakeIo(new Responder({ x: { data: { ok: true } } }));
  const master = new MasterConnection({ sessionId: SESSION, io, fetchImpl: fakeAuthFetch() });
  const attempt = master.connect();
  await sleep(0);

  assert.equal(io.sockets.length, 1, 'connect opened a socket.io socket');
  assert.equal(master.state, 'connecting', 'and is waiting for user_info, as it should');
  io.last.ready(USER);
  await attempt;
  assert.equal(master.state, 'ready');
  await master.close();
});
