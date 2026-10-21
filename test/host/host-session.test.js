// ===========================================================================
// HostSession — the master connection of the signed-in user (spec §4.4, §4.11):
// open, drop, the state an app is told, a refused session after the first
// connect, a reconnect that may have changed who the user is.
//
// The connection is `fakeMaker`'s, which a test moves with `setState` and
// `reconnected`; `keepHandlers` lets a test fire events at a connection the
// session has let go of.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HostSession, SUPERSEDED, connectionStateOf, failureOf } from '../../src/host/HostSession.js';
import { INFO, codedError, deferred, fakeMaker, settle } from '../helpers/hostBridgeFakes.js';

/** A session over `maker`, recording what it tells its owner. */
function sessionOn(maker = fakeMaker(), { online = () => true } = {}) {
  const told = { states: [], reconnected: [], expired: 0, logs: [] };
  const session = new HostSession({
    makeConnection: (sessionId) => maker.make(sessionId),
    log: (level, message) => told.logs.push({ level, message }),
    online: () => online(),
    onState: (state) => told.states.push(state),
    onReconnected: (change) => told.reconnected.push(change),
    onExpired: () => { told.expired += 1; },
  });
  return { session, maker, told };
}

test('connectionStateOf says ready, reconnecting or offline, and nothing for idle or closed', () => {
  assert.equal(connectionStateOf('ready'), 'ready');
  for (const state of ['connecting', 'reconnecting', 'failed']) {
    assert.equal(connectionStateOf(state), 'reconnecting', state);
    assert.equal(connectionStateOf(state, true), 'reconnecting', state);
    assert.equal(connectionStateOf(state, false), 'offline', state);
  }
  assert.equal(connectionStateOf('ready', false), 'ready', 'a link that is up is up, whatever the browser thinks');
  assert.equal(connectionStateOf('idle'), null);
  assert.equal(connectionStateOf('closed'), null);
  assert.equal(connectionStateOf('nonsense'), null);
  assert.equal(connectionStateOf(undefined), null);
});

test('failureOf is a refused session or unavailable, with a fixed message', () => {
  assert.deepEqual(failureOf('session_expired'), { code: 'session_expired', message: 'the session is no longer valid' });
  for (const code of ['unavailable', 'timeout', undefined, null, 5, {}, 'sess-SECRET']) {
    assert.deepEqual(failureOf(code), { code: 'unavailable', message: 'the connection to Valu is unavailable' });
  }
  assert.ok(Object.isFrozen(failureOf('unavailable')));
});

test('a new session is signed out, with nothing known', () => {
  const { session } = sessionOn();
  assert.equal(session.signedIn, false);
  assert.equal(session.state, 'signed_out');
  assert.equal(session.connection, null);
  assert.equal(session.sessionId, null);
  assert.equal(session.masterUser, null);
  assert.equal(session.lastError, null);
  assert.equal(session.networkId(), null);
  assert.deepEqual(session.identity(), { user: null, network: null });
});

test('open connects, adopts who user_info says the user is, and answers null', async () => {
  const { session, maker, told } = sessionOn();
  assert.equal(await session.open('sess-SECRET-1'), null);
  assert.deepEqual(maker.sessions, ['sess-SECRET-1']);
  assert.equal(session.signedIn, true);
  assert.equal(session.state, 'ready');
  assert.equal(session.connection, maker.connections[0]);
  assert.equal(session.sessionId, 'sess-SECRET-1');
  assert.deepEqual(session.masterUser, INFO.user);
  assert.deepEqual(session.identity(), {
    user: { id: 'u1', name: 'Ada Lovelace' }, network: { id: 'n1', name: 'Roomful' },
  });
  assert.equal(session.networkId(), 'n1');
  assert.deepEqual(told.states, [], 'the first connection is the caller\'s to announce');
});

test('identity is a copy, and a network the socket facade names wins', async () => {
  const { session, maker } = sessionOn();
  await session.open('s');
  session.identity().user.name = 'changed';
  assert.equal(session.identity().user.name, 'Ada Lovelace');
  maker.connections[0].socket.networkId = 'n7';
  assert.equal(session.networkId(), 'n7', 'the facade follows user_info');
});

test('open answers session_expired for a refused session and unavailable for anything else', async () => {
  for (const [error, expected] of [
    [codedError('session_expired'), 'session_expired'],
    [codedError('unavailable'), 'unavailable'],
    [new TypeError('boom'), 'unavailable'],
    [codedError('weird'), 'unavailable'],
  ]) {
    const { session, maker, told } = sessionOn(fakeMaker({ error }));
    assert.equal(await session.open('s'), expected);
    assert.equal(session.signedIn, false);
    assert.equal(session.connection, null);
    assert.equal(session.sessionId, null);
    assert.equal(maker.connections[0].closed, 1, 'the failed connection is closed');
    assert.equal(session.lastError.code, expected);
    assert.equal(told.logs.length, 1);
    assert.equal(told.logs[0].level, 'warn');
    assert.equal(told.logs[0].message, `the master did not accept the session (${expected})`, 'the reason, never the raw code');
  }
});

test('open answers unavailable when the connection cannot even be made, and logs only the code', async () => {
  const session = new HostSession({
    makeConnection: () => { throw Object.assign(new Error('secret sess-SECRET-1'), { code: 'weird' }); },
    log: (level, message) => { assert.ok(!message.includes('SECRET')); },
  });
  assert.equal(await session.open('sess-SECRET-1'), 'unavailable');
});

test('a drop while connecting makes open answer SUPERSEDED, and the session stays signed out', async () => {
  const connecting = deferred();
  const { session, maker } = sessionOn(fakeMaker({ connect: async () => { await connecting.promise; return INFO; } }));
  const opening = session.open('s');
  await settle();
  await session.drop();
  connecting.resolve();
  assert.equal(await opening, SUPERSEDED);
  assert.equal(session.signedIn, false);
  assert.equal(maker.connections[0].closed, 1);
  assert.equal(session.state, 'signed_out');
});

test('a failure after a drop is SUPERSEDED too, and sets no error', async () => {
  const connecting = deferred();
  const { session } = sessionOn(fakeMaker({ connect: async () => { await connecting.promise; throw codedError('session_expired'); } }));
  const opening = session.open('s');
  await settle();
  await session.drop();
  connecting.resolve();
  assert.equal(await opening, SUPERSEDED);
  assert.equal(session.lastError, null);
});

test('drop forgets the user and closes the connection; with session_expired it keeps that as the error', async () => {
  const { session, maker } = sessionOn();
  await session.open('s');
  await session.drop();
  assert.equal(maker.connections[0].closed, 1);
  assert.equal(session.signedIn, false);
  assert.deepEqual([session.sessionId, session.masterUser, session.connection, session.lastError], [null, null, null, null]);
  assert.deepEqual(session.identity(), { user: null, network: null });
  assert.equal(session.state, 'signed_out');
  await session.drop(); // idempotent

  await session.open('s2');
  await session.drop('session_expired');
  assert.deepEqual(session.lastError, { code: 'session_expired', message: 'the session is no longer valid' });
  await session.open('s3');
  assert.equal(session.lastError, null, 'a session that comes up clears it');
  await session.drop('something else');
  assert.equal(session.lastError, null);
});

test('drop never rejects, even when the connection will not close', async () => {
  const logs = [];
  const maker = fakeMaker();
  const session = new HostSession({
    makeConnection: (id) => {
      const connection = maker.make(id);
      connection.close = async () => { throw new Error('secret sess-SECRET-1'); };
      return connection;
    },
    log: (level, message) => logs.push(message),
  });
  await session.open('s');
  await session.drop();
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes('SECRET'));
});

test('state changes are mapped, told once each, and the last error follows the link', async () => {
  const { session, maker, told } = sessionOn();
  await session.open('s');
  const master = maker.connections[0];

  master.setState('reconnecting');
  master.setState('connecting');
  master.setState('failed', codedError('unavailable'));
  master.setState('idle');
  assert.deepEqual(told.states, ['reconnecting']);
  assert.equal(session.state, 'reconnecting');
  assert.equal(session.lastError.code, 'unavailable');
  assert.equal(session.signedIn, true, 'a lost link is not a sign-out');

  master.setState('ready');
  assert.deepEqual(told.states, ['reconnecting', 'ready']);
  assert.equal(session.lastError, null);
  assert.equal(told.expired, 0);
});

test('a link that is down while the browser is offline is offline', async () => {
  let online = true;
  const { session, maker, told } = sessionOn(fakeMaker(), { online: () => online });
  await session.open('s');
  online = false;
  maker.connections[0].setState('reconnecting');
  online = true;
  maker.connections[0].setState('connecting');
  maker.connections[0].setState('ready');
  assert.deepEqual(told.states, ['offline', 'reconnecting', 'ready']);
});

test('a failed connection whose error is a refused session expires the session, once per event', async () => {
  const { session, maker, told } = sessionOn();
  await session.open('s');
  maker.connections[0].setState('failed', codedError('session_expired'));
  assert.equal(told.expired, 1);
  assert.deepEqual(told.states, [], 'not a connection state: the owner signs the user out');
  assert.deepEqual(session.lastError, { code: 'session_expired', message: 'the session is no longer valid' });
});

test('a failed connection with no usable error is just a lost link', async () => {
  const { session, maker, told } = sessionOn();
  await session.open('s');
  maker.connections[0].setState('failed', null);
  maker.connections[0].setState('ready');
  maker.connections[0].setState('failed', new Error('no code'));
  assert.equal(told.expired, 0);
  assert.deepEqual(told.states, ['reconnecting', 'ready', 'reconnecting']);
  assert.equal(session.lastError.code, 'unavailable');
  await session.drop(); // a lost link is retried: stop the retries
});

test('a reconnect refreshes who the user is and says whether it changed', async () => {
  const { session, maker, told } = sessionOn();
  await session.open('s');
  const master = maker.connections[0];

  master.reconnected({ ...INFO }); // the same
  master.reconnected({ ...INFO, user: { id: 'u1', name: 'Ada Lovelace', extra: 1 } }); // the same as far as it shows
  assert.deepEqual(told.reconnected, [{ changed: false }, { changed: false }]);

  master.reconnected({ userId: 'u1', networkId: 'n1', user: { id: 'u1', name: 'Ada King' }, network: INFO.network });
  assert.equal(told.reconnected[2].changed, true, 'a new name');
  assert.deepEqual(session.identity().user, { id: 'u1', name: 'Ada King' });
  assert.equal(session.masterUser.name, 'Ada King');

  master.reconnected({ userId: 'u1', networkId: 'n2', user: { id: 'u1', name: 'Ada King' }, network: { id: 'n2', fullName: 'Other' } });
  assert.equal(told.reconnected[3].changed, true, 'a new network');
  assert.deepEqual(session.identity().network, { id: 'n2', name: 'Other' });
});

test('a reconnect that says nothing keeps what is known, and clears the link state and error', async () => {
  const { session, maker, told } = sessionOn();
  await session.open('s');
  const master = maker.connections[0];
  master.setState('failed', codedError('unavailable'));
  master.reconnected(undefined);
  assert.deepEqual(told.reconnected, [{ changed: false }]);
  assert.equal(session.identity().user.name, 'Ada Lovelace');
  assert.equal(session.state, 'ready');
  assert.equal(session.lastError, null);
});

test('a connection that has been let go of is not listened to', async () => {
  const maker = fakeMaker();
  maker.keepHandlers = true;
  const { session, told } = sessionOn(maker);
  await session.open('first');
  const stale = maker.connections[0];
  await session.drop();
  await session.open('second');
  assert.equal(maker.connections.length, 2);

  stale.setState('reconnecting');
  stale.setState('failed', codedError('session_expired'));
  stale.reconnected({ ...INFO, networkId: 'n9', network: { id: 'n9' } });
  assert.deepEqual(told, { states: [], reconnected: [], expired: 0, logs: [] });
  assert.equal(session.state, 'ready');
  assert.equal(session.identity().network.id, 'n1');

  await session.drop();
  maker.connections[1].setState('reconnecting');
  assert.deepEqual(told.states, [], 'nor one that was dropped');
});

test('a connection without subscriptions still opens', async () => {
  const session = new HostSession({
    makeConnection: () => ({ connect: async () => INFO, close: async () => {}, socket: {} }),
    log: () => {},
  });
  assert.equal(await session.open('s'), null);
  assert.equal(session.signedIn, true);
});

// ---------------------------------------------------------------------------
// A lost master is connected again by itself
// ---------------------------------------------------------------------------

/** A session whose clock is the mock one and whose jitter is `random` (0.5: none). */
function retrying({ script = [], online = () => true, random = () => 0.5 } = {}, t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const maker = fakeMaker();
  maker.script = script;
  const told = { states: [], reconnected: [], expired: 0 };
  const session = new HostSession({
    makeConnection: (sessionId) => maker.make(sessionId),
    log: () => {},
    online: () => online(),
    random,
    onState: (state) => told.states.push(state),
    onReconnected: (change) => told.reconnected.push(change),
    onExpired: () => { told.expired += 1; },
  });
  return { session, maker, told };
}

/** Advance the mock clock and let the retry it fires run. */
const tick = async (t, ms) => {
  t.mock.timers.tick(ms);
  await settle();
};

const lose = (master) => master.setState('failed', codedError('unavailable'));

test('a lost master is connected again by itself, backing off 1 s, 2 s, 4 s ... capped at 30 s', async (t) => {
  const { session, maker } = retrying({ script: Array(8).fill('fail') }, t);
  await session.open('s');
  const master = maker.connections[0];
  assert.equal(master.connects, 1);

  lose(master);
  let connects = 1;
  for (const delay of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]) {
    await tick(t, delay - 1);
    assert.equal(master.connects, connects, `${delay} ms is not reached yet`);
    await tick(t, 1);
    connects += 1;
    assert.equal(master.connects, connects, `retried after ${delay} ms`);
  }
  await session.drop();
});

for (const [name, random, delay] of [['low', () => 0, 800], ['high', () => 0.9999, 1200]]) {
  test(`the retry delay carries +-20 % jitter (${name} end: ${delay} ms)`, async (t) => {
    const { session, maker } = retrying({ random }, t);
    await session.open('s');
    const master = maker.connections[0];
    lose(master);
    await tick(t, delay - 2);
    assert.equal(master.connects, 1, 'not yet');
    await tick(t, 2);
    assert.equal(master.connects, 2, `retried at ${delay} ms`);
    await session.drop();
  });
}

test('a retry that succeeds is a reconnect: the owner hears ready and what user_info now says', async (t) => {
  const fresh = { userId: 'u1', networkId: 'n2', user: INFO.user, network: { id: 'n2', fullName: 'Other' } };
  const { session, maker, told } = retrying({ script: [fresh] }, t);
  await session.open('s');
  lose(maker.connections[0]);
  await tick(t, 1000);

  assert.deepEqual(told.states, ['reconnecting', 'ready']);
  assert.deepEqual(told.reconnected, [{ changed: true }]);
  assert.equal(session.identity().network.id, 'n2');
  assert.equal(session.state, 'ready');
  assert.equal(session.lastError, null);
  await tick(t, 100_000);
  assert.equal(maker.connections[0].connects, 2, 'and nothing is retried once it is back');
});

test('after a reconnect the backoff starts over', async (t) => {
  const { session, maker } = retrying({ script: ['fail', 'fail', 'ok'] }, t);
  await session.open('s');
  const master = maker.connections[0];
  lose(master);
  await tick(t, 1000);
  await tick(t, 2000);
  await tick(t, 4000);
  assert.equal(master.connects, 4);
  assert.equal(master.state, 'ready');

  lose(master);
  await tick(t, 999);
  assert.equal(master.connects, 4);
  await tick(t, 1);
  assert.equal(master.connects, 5, 'a second again');
  await session.drop();
});

test('a reconnect with no state change before it still starts the backoff over', async (t) => {
  const { session, maker } = retrying({ script: ['fail', 'fail'] }, t);
  await session.open('s');
  const master = maker.connections[0];
  lose(master);
  await tick(t, 1000);
  await tick(t, 2000);
  assert.equal(master.connects, 3);
  master.reconnected(INFO); // the master says it is back, without a state event first
  lose(master);
  await tick(t, 999);
  assert.equal(master.connects, 3);
  await tick(t, 1);
  assert.equal(master.connects, 4, 'a second again, not 4 s');
  await session.drop();
});

test('a new session starts the backoff over: its first retry is a second, not the last session\'s 30 s', async (t) => {
  const { session, maker } = retrying({ script: Array(12).fill('fail') }, t);
  await session.open('s');
  const first = maker.connections[0];
  lose(first);
  for (const delay of [1000, 2000, 4000, 8000, 16_000, 30_000]) await tick(t, delay); // now at the cap
  assert.equal(first.connects, 7);
  await session.drop(); // the user signs out

  await session.open('s2');
  const second = maker.connections[1];
  lose(second);
  await tick(t, 999);
  assert.equal(second.connects, 1);
  await tick(t, 1);
  assert.equal(second.connects, 2, 'the first retry of the new session is at 1 s');
  await tick(t, 1999);
  assert.equal(second.connects, 2);
  await tick(t, 1);
  assert.equal(second.connects, 3, 'and the next at 2 s: the exponent is its own');
  await session.drop();
});

test('retries are never given up: forty failures in a row are all retried', async (t) => {
  const { session, maker } = retrying({ script: Array(60).fill('fail') }, t);
  await session.open('s');
  const master = maker.connections[0];
  lose(master);
  for (let i = 0; i < 40; i += 1) await tick(t, 30_000);
  assert.ok(master.connects >= 41, `${master.connects} connects`);
  assert.equal(session.signedIn, true);
  assert.equal(session.state, 'reconnecting');
  await session.drop();
});

test('a retry that finds the session refused expires it, and stops', async (t) => {
  const { session, maker, told } = retrying({ script: ['expire'] }, t);
  await session.open('s');
  const master = maker.connections[0];
  lose(master);
  await tick(t, 1000);
  assert.equal(told.expired, 1);
  assert.deepEqual(session.lastError, { code: 'session_expired', message: 'the session is no longer valid' });
  await tick(t, 100_000);
  assert.equal(master.connects, 2, 'no retry after that, even before the owner has dropped the session');
  await session.drop('session_expired'); // what the owner does
});

test('a master that is lost again while it is being retried does not stack timers', async (t) => {
  const { session, maker } = retrying({ script: ['fail'] }, t);
  await session.open('s');
  const master = maker.connections[0];
  lose(master);
  lose(master);
  lose(master);
  await tick(t, 1000); // one retry, which fails
  assert.equal(master.connects, 2);
  await tick(t, 1999);
  assert.equal(master.connects, 2, 'the next is booked once, 2 s after the first failed');
  await tick(t, 1);
  assert.equal(master.connects, 3, 'one at a time, on the backoff');
  await session.drop();
});

test('a master that comes back by itself (a call replaced it) cancels the retry', async (t) => {
  const { session, maker } = retrying({}, t);
  await session.open('s');
  const master = maker.connections[0];
  lose(master);
  master.setState('connecting');
  master.setState('ready');
  await tick(t, 100_000);
  assert.equal(master.connects, 1, 'nothing was retried');
  await session.drop();
});

test('drop stops the retries, and so does a session that was replaced', async (t) => {
  const { session, maker } = retrying({}, t);
  await session.open('s');
  const first = maker.connections[0];
  lose(first);
  await session.drop();
  await tick(t, 100_000);
  assert.equal(first.connects, 1);

  await session.open('s2');
  const second = maker.connections[1];
  lose(second);
  await session.drop();
  await session.open('s3');
  await tick(t, 100_000);
  assert.equal(second.connects, 1, 'the retry of a session that is gone does not touch the new one');
  assert.equal(maker.connections[2].connects, 1);
  await session.drop();
});

test('nothing is retried while the browser is offline, and the network coming back retries at once', async (t) => {
  let online = false;
  const { session, maker, told } = retrying({}, t);
  const offlineSession = new HostSession({
    makeConnection: (id) => maker.make(id),
    log: () => {},
    online: () => online,
    random: () => 0.5,
    onState: (state) => told.states.push(state),
    onReconnected: (change) => told.reconnected.push(change),
  });
  assert.ok(session);
  await offlineSession.open('s');
  const master = maker.connections[0];
  lose(master);
  assert.deepEqual(told.states, ['offline']);
  await tick(t, 100_000);
  assert.equal(master.connects, 1, 'paused');

  online = true;
  offlineSession.networkChanged();
  await settle();
  assert.equal(master.connects, 2, 'retried at once, not after a backoff');
  assert.deepEqual(told.states, ['offline', 'reconnecting', 'ready']);
  assert.deepEqual(told.reconnected, [{ changed: false }]);
  await offlineSession.drop();
});

test('a retry that is due when the network is gone waits for it', async (t) => {
  let online = true;
  const { maker, told } = retrying({}, t);
  const session = new HostSession({
    makeConnection: (id) => maker.make(id), log: () => {}, online: () => online, random: () => 0.5, onState: (state) => told.states.push(state),
  });
  await session.open('s');
  const master = maker.connections[0];
  lose(master);
  online = false;
  await tick(t, 1000); // the timer fires with no network: nothing is tried
  assert.equal(master.connects, 1);
  await tick(t, 100_000);
  assert.equal(master.connects, 1);
  online = true;
  session.networkChanged();
  await settle();
  assert.equal(master.connects, 2);
  assert.equal(session.state, 'ready');
  await session.drop();
});

test('networkChanged says offline when the network goes and the master state when it returns', async (t) => {
  let online = true;
  const { maker, told } = retrying({}, t);
  const session = new HostSession({
    makeConnection: (id) => maker.make(id), log: () => {}, online: () => online, random: () => 0.5, onState: (state) => told.states.push(state),
  });
  session.networkChanged();
  assert.deepEqual(told.states, [], 'signed out: nothing to say');

  await session.open('s');
  session.networkChanged();
  assert.deepEqual(told.states, [], 'online and ready: nothing changed');
  online = false;
  session.networkChanged();
  session.networkChanged();
  assert.deepEqual(told.states, ['offline'], 'offline, whatever the socket still believes, once');
  assert.equal(session.state, 'offline');
  online = true;
  session.networkChanged();
  assert.deepEqual(told.states, ['offline', 'ready']);
  await session.drop();
});

// ---------------------------------------------------------------------------
// Resuming a stored session: signed in at once, confirmed by the master
// ---------------------------------------------------------------------------

const STORED = Object.freeze({ userId: 'u1', networkId: 'net-1' });
const FROM_STORAGE = { user: { id: 'u1', name: null }, network: { id: 'net-1', name: null } };

/** A session whose clock is the mock one, with `opens` scripting how each connect ends. */
function resuming(t, { opens = [], online = () => true, random = () => 0.5, clock = true } = {}) {
  if (clock) t.mock.timers.enable({ apis: ['setTimeout'] });
  const maker = fakeMaker();
  maker.opens = opens;
  const told = { states: [], opened: 0, reconnected: [], expired: 0, logs: [] };
  const session = new HostSession({
    makeConnection: (sessionId) => maker.make(sessionId),
    log: (level, message) => told.logs.push({ level, message }),
    online: () => online(),
    random,
    onState: (state) => told.states.push(state),
    onOpened: () => { told.opened += 1; },
    onReconnected: (change) => told.reconnected.push(change),
    onExpired: () => { told.expired += 1; },
  });
  return { session, maker, told };
}

test('resume is signed in at once, as storage knows the user, and the master confirms it', async (t) => {
  const opening = deferred();
  const { session, maker, told } = resuming(t, { opens: [opening.promise] });

  const first = session.resume('sess-SECRET-1', STORED);
  assert.equal(session.signedIn, true, 'signed in before the master has answered');
  assert.equal(session.state, 'connecting');
  assert.equal(session.sessionId, 'sess-SECRET-1');
  assert.deepEqual(session.identity(), FROM_STORAGE, 'ids from storage; the names come with user_info');
  assert.equal(session.networkId(), 'net-1');
  assert.equal(session.connection, maker.connections[0]);
  assert.equal(session.lastError, null);

  opening.resolve('ok');
  assert.equal(await first, null);
  assert.equal(session.state, 'ready');
  assert.deepEqual(session.identity(), { user: { id: 'u1', name: 'Ada Lovelace' }, network: { id: 'n1', name: 'Roomful' } });
  assert.deepEqual(session.masterUser, INFO.user);
  assert.deepEqual([told.states, told.opened, told.expired], [[], 0, 0], 'the first attempt is the caller\'s to tell');
  await session.drop();
});

test('resume answers unavailable but stays signed in, and retries 1 s, 2 s, 4 s ... capped at 30 s', async (t) => {
  const { session, maker, told } = resuming(t, { opens: Array(9).fill('fail') });
  assert.equal(await session.resume('s', STORED), 'unavailable');
  const master = maker.connections[0];
  assert.equal(session.signedIn, true, 'a master that cannot be reached is not a sign-out');
  assert.equal(session.state, 'reconnecting');
  assert.deepEqual(session.lastError, { code: 'unavailable', message: 'the connection to Valu is unavailable' });
  assert.deepEqual(session.identity(), FROM_STORAGE);
  assert.equal(master.closed, 0, 'the connection is kept and tried again');
  assert.deepEqual(told.states, []);

  let connects = 1;
  for (const delay of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]) {
    await tick(t, delay - 1);
    assert.equal(master.connects, connects, `${delay} ms is not reached yet`);
    await tick(t, 1);
    connects += 1;
    assert.equal(master.connects, connects, `retried after ${delay} ms`);
  }
  assert.deepEqual([told.states, told.opened, told.expired], [[], 0, 0], 'still reconnecting: nothing new to say');
  assert.equal(session.signedIn, true);
  await session.drop();
});

for (const [name, random, delay] of [['low', () => 0, 800], ['high', () => 0.9999, 1200]]) {
  test(`a resume retry carries +-20 % jitter (${name} end: ${delay} ms)`, async (t) => {
    const { session, maker } = resuming(t, { opens: ['fail', 'fail'], random });
    await session.resume('s', STORED);
    await tick(t, delay - 2);
    assert.equal(maker.connections[0].connects, 1, 'not yet');
    await tick(t, 2);
    assert.equal(maker.connections[0].connects, 2, `retried at ${delay} ms`);
    await session.drop();
  });
}

test('a resume retry that opens tells the owner once, with user_info adopted, and stops retrying', async (t) => {
  const { session, maker, told } = resuming(t, { opens: ['fail', 'fail', 'ok'] });
  await session.resume('s', STORED);
  await tick(t, 1000);
  assert.equal(told.opened, 0);
  await tick(t, 2000);
  assert.equal(told.opened, 1);
  assert.equal(session.state, 'ready');
  assert.equal(session.lastError, null);
  assert.deepEqual(session.identity().user, { id: 'u1', name: 'Ada Lovelace' });
  assert.deepEqual(told.states, [], 'the owner announces the link with the user');
  await tick(t, 100_000);
  assert.equal(maker.connections[0].connects, 3, 'no retry once it is open');

  // From here it is a session like any other: a loss is a reconnect.
  maker.script = ['ok'];
  lose(maker.connections[0]);
  await tick(t, 1000);
  assert.deepEqual(told.states, ['reconnecting', 'ready']);
  assert.equal(told.reconnected.length, 1);
  await session.drop();
});

test('a resume refused on the first attempt answers session_expired and leaves the drop to the owner', async (t) => {
  const { session, maker, told } = resuming(t, { opens: ['expire'] });
  assert.equal(await session.resume('s', STORED), 'session_expired');
  assert.equal(told.expired, 0, 'the caller has the answer in hand');
  assert.deepEqual(session.lastError, { code: 'session_expired', message: 'the session is no longer valid' });
  await tick(t, 100_000);
  assert.equal(maker.connections[0].connects, 1, 'a refused session is not retried');
  await session.drop('session_expired');
  assert.equal(session.signedIn, false);
});

test('a resume refused on a retry expires the session, once, and stops', async (t) => {
  const { session, maker, told } = resuming(t, { opens: ['fail', 'expire'] });
  await session.resume('s', STORED);
  await tick(t, 1000);
  assert.equal(told.expired, 1);
  assert.deepEqual(session.lastError, { code: 'session_expired', message: 'the session is no longer valid' });
  await tick(t, 100_000);
  assert.equal(maker.connections[0].connects, 2);
  assert.equal(told.expired, 1, 'once, though both the state and the attempt said so');
  await session.drop('session_expired');
});

test('a master a call brought up while the resume waited to retry confirms it at once', async (t) => {
  const { session, maker, told } = resuming(t, { opens: ['fail', 'ok'] });
  await session.resume('s', STORED);
  const master = maker.connections[0];
  await master.connect(); // what MasterConnection does for a call that needs a socket
  await settle();
  assert.equal(told.opened, 1);
  assert.equal(session.state, 'ready');
  const connects = master.connects;
  await tick(t, 100_000);
  assert.equal(master.connects, connects, 'the retry that was due is not run');
  await session.drop();
});

test('nothing is retried while the browser is offline, and the network coming back retries at once', async (t) => {
  let online = true;
  const { session, maker, told } = resuming(t, { opens: ['fail', 'ok'], online: () => online });
  const first = session.resume('s', STORED);
  online = false;
  session.networkChanged();
  assert.deepEqual(told.states, ['offline'], 'the browser says so, even before the first answer');
  assert.equal(await first, 'unavailable');
  assert.equal(session.state, 'offline');
  await tick(t, 100_000);
  assert.equal(maker.connections[0].connects, 1, 'no timer while offline');

  online = true;
  session.networkChanged();
  await settle();
  assert.equal(maker.connections[0].connects, 2, 'retried the moment the network came back');
  assert.equal(told.opened, 1);
  assert.deepEqual(told.states, ['offline', 'reconnecting']);
  await session.drop();
});

test('drop ends a resume: its first answer is SUPERSEDED, and no retry or timer is left', async (t) => {
  const opening = deferred();
  const { session, maker, told } = resuming(t, { opens: [opening.promise] });
  const first = session.resume('s', STORED);
  await session.drop();
  opening.resolve('fail');
  assert.equal(await first, SUPERSEDED);
  assert.equal(session.signedIn, false);
  assert.equal(session.lastError, null);

  const again = resuming(t, { opens: ['fail', 'ok'], clock: false });
  await again.session.resume('s', STORED);
  await again.session.drop();
  await tick(t, 100_000);
  assert.equal(again.maker.connections[0].connects, 1, 'the booked retry was cancelled');
  assert.deepEqual([told.opened, again.told.opened], [0, 0]);
  assert.equal(maker.connections[0].closed, 1);
});

test('a master that opens without saying who the user is keeps what storage knew', async () => {
  const maker = fakeMaker({ connect: async () => undefined });
  const session = new HostSession({ makeConnection: (id) => maker.make(id), log: () => {} });
  assert.equal(await session.resume('s', STORED), null);
  assert.equal(session.state, 'ready');
  assert.deepEqual(session.identity(), FROM_STORAGE);
  await session.drop();
});

test('resume answers unavailable when the connection cannot even be made, and is not signed in', async () => {
  const session = new HostSession({
    makeConnection: () => { throw codedError('boom'); }, log: () => {},
  });
  assert.equal(await session.resume('s', STORED), 'unavailable');
  assert.equal(session.signedIn, false);
  assert.equal(session.connection, null);
});
