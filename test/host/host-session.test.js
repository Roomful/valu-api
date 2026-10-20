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
