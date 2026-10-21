// ===========================================================================
// HostAuth — redeem, restore and sign out.
//
// The master is `fakeAuthFetch` (it answers HTTP 200 for every verdict and
// signals it in the JSON body, as the real one does), the storage is
// `FakeStorage` behind the real `SessionStore`, and the master socket is a
// hand-rolled connection: `HostAuth` only needs its `connect`, `switchNetwork`
// and `close`, and the real `MasterConnection` has its own tests.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HostAuth, INVALID_TOKEN, REDEEM_TIMEOUT_MS } from '../../src/host/HostAuth.js';
import { SessionStore } from '../../src/host/SessionStore.js';
import { FakeStorage, fakeAuthFetch } from '../helpers/hostFakes.js';

const TOKEN = 'one-time-4c1f-NOT-A-REAL-TOKEN';
const SESSION = 'sess-9d2e-NOT-A-REAL-SESSION';
const SWITCHED = 'sess-77aa-SWITCHED-NOT-REAL';

const redeemBody = (data, error = { status: false, code: 200, message: '' }) => ({ data, error });
const VALID = redeemBody({ user_id: 'u1', session_token: SESSION, is_new: false, need_verification: false });
const BAD_TOKEN = { error: { status: true, code: 400, message: 'Not found' } };

/** A `Response`-alike for the cases `fakeAuthFetch` does not make. */
const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => { if (body instanceof Error) throw body; return body; },
});

/** A `makeConnection` over hand-rolled connections; `made` is every one built. */
function connections({ networkId = 'n1', userId = 'u1', switchTo = SWITCHED, connectError, switchError } = {}) {
  const made = [];
  const make = (sessionId) => {
    const events = [];
    const connection = {
      sessionId,
      events,
      async connect() {
        events.push('connect');
        if (connectError) throw connectError;
        return { userId, networkId, user: { id: userId }, network: { id: networkId } };
      },
      async switchNetwork(target) {
        events.push(`switch:${target}`);
        if (switchError) throw switchError;
        return { sessionId: switchTo };
      },
      async close() { events.push('close'); },
    };
    made.push(connection);
    return connection;
  };
  make.made = made;
  return make;
}

const coded = (code, message = code) => Object.assign(new Error(message), { code });

function setup({ fetchImpl, connection, ...options } = {}) {
  const storage = new FakeStorage();
  const sessionStore = new SessionStore({ storage });
  const fetch = fetchImpl ?? fakeAuthFetch({ redeem: VALID });
  const makeConnection = connection ?? connections();
  const auth = new HostAuth({ sessionStore, fetchImpl: fetch, makeConnection, ...options });
  return { auth, sessionStore, storage, fetch, makeConnection };
}

/** Rejection of `promise`, or fail the test. */
async function rejection(promise) {
  try { await promise; } catch (error) { return error; }
  assert.fail('expected the promise to reject');
}

// ---- redeem: the request ---------------------------------------------------

test('redeem posts the token to the master with an empty JSON body and no credential', async () => {
  const bodies = [];
  const inner = fakeAuthFetch({ redeem: VALID });
  const fetchImpl = (url, options) => { bodies.push(options?.body); return inner(url, options); };
  fetchImpl.calls = inner.calls;
  const { auth } = setup({ fetchImpl });

  await auth.redeem(TOKEN, { homeNetworkId: 'n1' });

  assert.equal(inner.calls.length, 1);
  assert.equal(inner.calls[0].url, `https://api.roomful.net/api/v1/auth/checkOneTimeAuthToken/${TOKEN}`);
  assert.equal(inner.calls[0].method, 'POST');
  assert.deepEqual(inner.calls[0].headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(bodies, ['{}']);
});

test('redeem encodes the token into the path, and talks to the master it was given', async () => {
  const { auth, fetch } = setup({ master: 'dev.roomful.net' });
  await auth.redeem('a/b?c d', { homeNetworkId: 'n1' });
  assert.equal(fetch.calls[0].url, 'https://dev.roomful.net/api/v1/auth/checkOneTimeAuthToken/a%2Fb%3Fc%20d');
});

// ---- redeem: the verdict ---------------------------------------------------

test('redeem rejects invalid_token when error.status is true', async () => {
  const fetchImpl = fakeAuthFetch({ redeem: BAD_TOKEN });
  const { auth, sessionStore, makeConnection } = setup({ fetchImpl });

  const error = await rejection(auth.redeem(TOKEN, { homeNetworkId: 'n1' }));

  assert.equal(error.code, 'invalid_token');
  assert.equal(INVALID_TOKEN, 'invalid_token');
  assert.ok(!error.message.includes(TOKEN), 'the message does not carry the token');
  assert.equal(makeConnection.made.length, 0, 'no connection is opened for a bad token');
  assert.equal(sessionStore.load(), null);
});

test('redeem rejects invalid_token for anything that is not a clean 2xx with a user', async () => {
  for (const [label, answer] of [
    ['non-2xx with a good-looking body', response(500, VALID)],
    ['a 2xx whose error says no, even with a user', response(200, redeemBody({ user_id: 'u1', session_token: SESSION }, { status: true, code: 400, message: 'x' }))],
    ['no user_id', response(200, redeemBody({ session_token: SESSION }))],
    ['an empty user_id', response(200, redeemBody({ user_id: '', session_token: SESSION }))],
    ['no session_token', response(200, redeemBody({ user_id: 'u1' }))],
    ['null data', response(200, redeemBody(null))],
    ['a body that is not an object', response(200, 'ok')],
    ['no error block', response(200, { data: { user_id: 'u1', session_token: SESSION } })],
    ['a body that is not JSON', response(200, new SyntaxError('Unexpected token <'))],
  ]) {
    const { auth, sessionStore, makeConnection } = setup({ fetchImpl: async () => answer });
    const error = await rejection(auth.redeem(TOKEN, { homeNetworkId: 'n1' }));
    assert.equal(error.code, 'invalid_token', label);
    assert.equal(makeConnection.made.length, 0, label);
    assert.equal(sessionStore.load(), null, label);
  }
});

test('redeem rejects invalid_token for a token that is not a string, without asking the master', async () => {
  const { auth, fetch } = setup();
  for (const token of ['', undefined, null, 5, {}]) {
    const error = await rejection(auth.redeem(token, { homeNetworkId: 'n1' }));
    assert.equal(error.code, 'invalid_token');
  }
  assert.equal(fetch.calls.length, 0);
});

test('redeem rejects unavailable, not invalid_token, when the master cannot be reached', async () => {
  const fetchImpl = async () => { throw new TypeError(`Failed to fetch ${TOKEN}`); };
  const { auth, sessionStore, makeConnection } = setup({ fetchImpl });

  const error = await rejection(auth.redeem(TOKEN, { homeNetworkId: 'n1' }));

  assert.equal(error.code, 'unavailable');
  assert.ok(!error.message.includes(TOKEN), 'the fetch error\'s own message is not passed on');
  assert.equal(error.cause, undefined);
  assert.equal(makeConnection.made.length, 0);
  assert.equal(sessionStore.load(), null);
});

// ---- redeem: the network ---------------------------------------------------

test('redeem stores without switching when networks match', async () => {
  const connection = connections({ networkId: 'n1' });
  const { auth, sessionStore } = setup({ connection });

  const result = await auth.redeem(TOKEN, { homeNetworkId: 'n1' });

  assert.deepEqual(result, { userId: 'u1', sessionId: SESSION, networkId: 'n1' });
  assert.equal(connection.made.length, 1);
  assert.equal(connection.made[0].sessionId, SESSION, 'the temporary connection runs on the redeemed session');
  assert.deepEqual(connection.made[0].events, ['connect', 'close']);
  assert.equal(sessionStore.load().userId, 'u1');
  assert.equal(sessionStore.get('n1').sessionId, SESSION);
});

test('redeem switches network when user_info differs from home', async () => {
  const connection = connections({ networkId: 'n1', switchTo: SWITCHED });
  const { auth, sessionStore } = setup({ connection });

  const result = await auth.redeem(TOKEN, { homeNetworkId: 'n2' });

  assert.deepEqual(result, { userId: 'u1', sessionId: SWITCHED, networkId: 'n2' });
  assert.deepEqual(connection.made[0].events, ['connect', 'switch:n2', 'close']);
  assert.equal(sessionStore.get('n2').sessionId, SWITCHED, 'the switched session is the one stored, under the home network');
  assert.equal(sessionStore.get('n1'), null, 'the network the session came in on is not stored');
});

test('redeem without a home network stores under the network user_info reports', async () => {
  const connection = connections({ networkId: 'n7' });
  const { auth, sessionStore } = setup({ connection });

  assert.deepEqual(await auth.redeem(TOKEN), { userId: 'u1', sessionId: SESSION, networkId: 'n7' });
  assert.deepEqual(connection.made[0].events, ['connect', 'close']);
  assert.equal(sessionStore.get('n7').sessionId, SESSION);

  assert.deepEqual(await auth.redeem(TOKEN, {}), { userId: 'u1', sessionId: SESSION, networkId: 'n7' });
});

test('redeem rejects not_a_member when the master refuses the switch, and stores nothing', async () => {
  const connection = connections({ networkId: 'n1', switchError: coded('not_a_member', 'network:switch to n2 failed: forbidden') });
  const { auth, sessionStore } = setup({ connection });

  const error = await rejection(auth.redeem(TOKEN, { homeNetworkId: 'n2' }));

  assert.equal(error.code, 'not_a_member');
  assert.deepEqual(connection.made[0].events, ['connect', 'switch:n2', 'close'], 'the temporary connection is closed on failure too');
  assert.equal(sessionStore.load(), null);
});

test('redeem passes a switch that could not be made on as unavailable', async () => {
  const connection = connections({ networkId: 'n1', switchError: coded('unavailable') });
  const { auth, sessionStore } = setup({ connection });

  assert.equal((await rejection(auth.redeem(TOKEN, { homeNetworkId: 'n2' }))).code, 'unavailable');
  assert.deepEqual(connection.made[0].events, ['connect', 'switch:n2', 'close']);
  assert.equal(sessionStore.load(), null);
});

test('redeem passes on why the connection could not be had, and closes it', async () => {
  const connection = connections({ connectError: coded('unavailable', 'master unavailable: timeout') });
  const { auth, sessionStore } = setup({ connection });

  assert.equal((await rejection(auth.redeem(TOKEN, { homeNetworkId: 'n1' }))).code, 'unavailable');
  assert.deepEqual(connection.made[0].events, ['connect', 'close']);
  assert.equal(sessionStore.load(), null);
});

test('redeem waits for the temporary connection to close before it resolves', async () => {
  const log = [];
  const makeConnection = () => ({
    async connect() { return { userId: 'u1', networkId: 'n1' }; },
    async switchNetwork() { throw new Error('not called'); },
    async close() { await Promise.resolve(); await Promise.resolve(); log.push('closed'); },
  });
  const { auth } = setup({ connection: makeConnection });
  await auth.redeem(TOKEN, { homeNetworkId: 'n1' });
  assert.deepEqual(log, ['closed']);
});

test('a close that throws does not turn a good redeem into a failure, nor hide the real error', async () => {
  const throwingClose = (inner) => (sessionId) => {
    const connection = inner(sessionId);
    connection.close = async () => { throw new Error('close blew up'); };
    return connection;
  };

  const ok = setup({ connection: throwingClose(connections({ networkId: 'n1' })) });
  assert.equal((await ok.auth.redeem(TOKEN, { homeNetworkId: 'n1' })).sessionId, SESSION);

  const failing = setup({ connection: throwingClose(connections({ switchError: coded('not_a_member') })) });
  assert.equal((await rejection(failing.auth.redeem(TOKEN, { homeNetworkId: 'n2' }))).code, 'not_a_member');
});

test('redeem rejects unavailable when there is no network to store the session under', async () => {
  const connection = connections({ networkId: null });
  const { auth, sessionStore } = setup({ connection });

  const error = await rejection(auth.redeem(TOKEN));

  assert.equal(error.code, 'unavailable');
  assert.ok(!error.message.includes(SESSION));
  assert.equal(sessionStore.load(), null);
  assert.deepEqual(connection.made[0].events, ['connect', 'close']);
});

test('redeeming for a second network of the same user keeps the first', async () => {
  const { auth, sessionStore } = setup({ connection: connections({ networkId: 'n1' }) });
  await auth.redeem(TOKEN, { homeNetworkId: 'n1' });
  await auth.redeem(TOKEN, { homeNetworkId: 'n2' });
  assert.deepEqual(Object.keys(sessionStore.load().sessions).sort(), ['n1', 'n2']);
});

// ---- redeem: bounded ---------------------------------------------------------

/** Whether a promise has settled, without waiting for it. */
async function settledYet(promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  return done;
}

test('redeem gives up after 15 s with code timeout when the master never answers, and stores nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(REDEEM_TIMEOUT_MS, 15_000);
  const { auth, sessionStore } = setup({ fetchImpl: () => new Promise(() => {}) });

  const redeeming = auth.redeem(TOKEN, { homeNetworkId: 'n1' });
  const outcome = rejection(redeeming);
  t.mock.timers.tick(REDEEM_TIMEOUT_MS - 1);
  assert.equal(await settledYet(redeeming), false, 'one millisecond short: still waiting');
  t.mock.timers.tick(1);

  const error = await outcome;
  assert.equal(error.code, 'timeout');
  assert.ok(!error.message.includes(TOKEN), 'the token is not in the error');
  assert.equal(sessionStore.load(), null);
});

test('the bound covers the whole redeem: a connection that hangs times out too, and is closed when it ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const hanging = new Promise((resolve) => { release = resolve; });
  const makeConnection = connections();
  const slow = (sessionId) => {
    const connection = makeConnection(sessionId);
    const { connect } = connection;
    connection.connect = async () => { await hanging; return connect(); };
    return connection;
  };
  const { auth, sessionStore } = setup({ connection: slow });

  const outcome = rejection(auth.redeem(TOKEN, { homeNetworkId: 'n1' }));
  await settledYet(Promise.resolve());
  t.mock.timers.tick(REDEEM_TIMEOUT_MS);
  assert.equal((await outcome).code, 'timeout');

  release(); // the master answers at last, after the caller was told it timed out
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  assert.equal(sessionStore.load(), null, 'a redeem that ran out of time stores nothing, even when it finishes');
  assert.deepEqual(makeConnection.made[0].events, ['connect', 'close'], 'and its temporary connection is closed');
});

test('redeemTimeoutMs bounds the redeem, and its timer does not outlive a redeem that finished', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
  const before = timers();
  const { auth } = setup();
  await auth.redeem(TOKEN, { homeNetworkId: 'n1' });
  assert.equal(timers(), before, 'a 15 s timer left behind would hold a page, and a test process, open');

  const quick = setup({ fetchImpl: () => new Promise(() => {}), redeemTimeoutMs: 5 });
  assert.equal((await rejection(quick.auth.redeem(TOKEN))).code, 'timeout');
});

// ---- restore ---------------------------------------------------------------

/** A store that already holds a session for n1. */
function signedIn(options = {}) {
  const context = setup(options);
  context.sessionStore.set({ userId: 'u1', networkId: 'n1', sessionId: SESSION });
  return context;
}

test('restore returns the session on 200', async () => {
  const { auth, fetch, sessionStore } = signedIn();

  assert.deepEqual(await auth.restore({ homeNetworkId: 'n1' }), { userId: 'u1', sessionId: SESSION, networkId: 'n1' });

  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'https://api.roomful.net/api/v1/auth/check');
  assert.equal(fetch.calls[0].method, 'GET');
  assert.deepEqual(fetch.calls[0].headers, { 'X-Session-Id': SESSION });
  assert.equal(sessionStore.get('n1').sessionId, SESSION, 'a good session stays stored');
});

test('restore clears on 401', async () => {
  const { auth, fetch, sessionStore } = signedIn();
  fetch.check = 401;

  assert.equal(await auth.restore({ homeNetworkId: 'n1' }), null);
  assert.equal(sessionStore.load(), null);
});

test('restore asks the master about the stored session of the home network', async () => {
  const { auth, fetch, sessionStore } = signedIn();
  sessionStore.set({ userId: 'u1', networkId: 'n2', sessionId: SWITCHED });

  assert.deepEqual(await auth.restore({ homeNetworkId: 'n2' }), { userId: 'u1', sessionId: SWITCHED, networkId: 'n2' });
  assert.deepEqual(fetch.calls[0].headers, { 'X-Session-Id': SWITCHED });
});

test('restore is null, and asks nothing, when the home network has no session', async () => {
  const { auth, fetch } = signedIn();
  assert.equal(await auth.restore({ homeNetworkId: 'n9' }), null);
  assert.equal(await auth.restore({ homeNetworkId: 'constructor' }), null);
  assert.equal(fetch.calls.length, 0);

  const empty = setup();
  assert.equal(await empty.auth.restore({ homeNetworkId: 'n1' }), null);
  assert.equal(await empty.auth.restore(), null);
  assert.equal(empty.fetch.calls.length, 0);
});

test('restore without a home network uses the only stored network, and none when there are several', async () => {
  const { auth, fetch, sessionStore } = signedIn();
  assert.deepEqual(await auth.restore({}), { userId: 'u1', sessionId: SESSION, networkId: 'n1' });
  assert.deepEqual(await auth.restore(), { userId: 'u1', sessionId: SESSION, networkId: 'n1' });
  assert.equal(fetch.calls.length, 2);

  sessionStore.set({ userId: 'u1', networkId: 'n2', sessionId: SWITCHED });
  assert.equal(await auth.restore({}), null);
  assert.equal(fetch.calls.length, 2, 'two candidates: it does not guess');
  assert.equal(sessionStore.get('n1').sessionId, SESSION, 'and it does not clear either');
});

const UNCHECKED = { userId: 'u1', sessionId: SESSION, networkId: 'n1' };

test('restore answers the stored session, unchecked, when the check cannot be made: it is not a refusal', async () => {
  const { auth, sessionStore } = signedIn({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });

  assert.deepEqual(await auth.restore({ homeNetworkId: 'n1' }), UNCHECKED);
  assert.equal(sessionStore.get('n1').sessionId, SESSION, 'the session may still be fine; the master connection tells');
});

test('restore answers the stored session when the master answers non-2xx', async () => {
  for (const status of [500, 502, 503]) {
    const { auth, sessionStore } = signedIn({ fetchImpl: async () => response(status, { error: { status: true, code: status } }) });
    assert.deepEqual(await auth.restore({ homeNetworkId: 'n1' }), UNCHECKED, String(status));
    assert.equal(sessionStore.get('n1').sessionId, SESSION, String(status));
  }
});

test('restore answers the stored session when the answer is not JSON', async () => {
  const { auth, sessionStore } = signedIn({ fetchImpl: async () => response(200, new SyntaxError('Unexpected token <')) });
  assert.deepEqual(await auth.restore({ homeNetworkId: 'n1' }), UNCHECKED);
  assert.equal(sessionStore.get('n1').sessionId, SESSION);
});

test('stored is what restore would ask about, read from storage without asking the master', async () => {
  const { auth, fetch, sessionStore } = signedIn();
  assert.deepEqual(auth.stored({ homeNetworkId: 'n1' }), UNCHECKED);
  assert.deepEqual(auth.stored(), UNCHECKED, 'the only stored network');
  assert.equal(auth.stored({ homeNetworkId: 'n9' }), null);
  sessionStore.set({ userId: 'u1', networkId: 'n2', sessionId: SWITCHED });
  assert.equal(auth.stored({}), null, 'two candidates: it does not guess');
  assert.equal(auth.stored({ homeNetworkId: null }), null);
  assert.deepEqual(auth.stored({ homeNetworkId: 'n2' }), { userId: 'u1', sessionId: SWITCHED, networkId: 'n2' });
  assert.equal(setup().auth.stored({ homeNetworkId: 'n1' }), null);
  assert.equal(fetch.calls.length, 0, 'nothing is asked');
});

test('restore reads a refusal from the body whatever the HTTP status says', async () => {
  const { auth, sessionStore } = signedIn({ fetchImpl: async () => response(401, { error: { status: true, code: 401, message: 'Unauthorized' } }) });
  assert.equal(await auth.restore({ homeNetworkId: 'n1' }), null);
  assert.equal(sessionStore.load(), null);
});

test('restore does not clear a session that was replaced while it was asking', async () => {
  // Another tab signed in during the round trip; the 401 is about the old one.
  const storage = new FakeStorage();
  const sessionStore = new SessionStore({ storage });
  sessionStore.set({ userId: 'u1', networkId: 'n1', sessionId: SESSION });
  const fetchImpl = async () => {
    sessionStore.set({ userId: 'u1', networkId: 'n1', sessionId: SWITCHED });
    return response(200, { error: { status: true, code: 401, message: 'Unauthorized' } });
  };
  const auth = new HostAuth({ sessionStore, fetchImpl, makeConnection: connections() });

  assert.equal(await auth.restore({ homeNetworkId: 'n1' }), null);
  assert.equal(sessionStore.get('n1').sessionId, SWITCHED);
});

test('restore talks to the master it was given', async () => {
  const { auth, fetch } = signedIn({ master: 'dev.roomful.net' });
  await auth.restore({ homeNetworkId: 'n1' });
  assert.equal(fetch.calls[0].url, 'https://dev.roomful.net/api/v1/auth/check');
});

// ---- sign out --------------------------------------------------------------

test('signOut clears the store and never asks the master, so the user\'s Valu Social sign-in survives', async () => {
  const { auth, sessionStore, storage, fetch } = signedIn();
  sessionStore.set({ userId: 'u1', networkId: 'n2', sessionId: SWITCHED });

  await auth.signOut();

  assert.equal(sessionStore.load(), null);
  assert.equal(storage.getItem('valu-host:session'), null);
  assert.equal(fetch.calls.length, 0, 'clearing storage is all it does: the session is the user\'s own and is not revoked');
  assert.equal(await auth.restore({ homeNetworkId: 'n1' }), null);
});

// ---- construction ----------------------------------------------------------

test('HostAuth needs a store, a fetch and a way to open a connection', () => {
  const sessionStore = new SessionStore({ storage: new FakeStorage() });
  const fetchImpl = fakeAuthFetch();
  const makeConnection = connections();
  assert.throws(() => new HostAuth({ fetchImpl, makeConnection }), TypeError);
  assert.throws(() => new HostAuth({ sessionStore, makeConnection }), TypeError);
  assert.throws(() => new HostAuth({ sessionStore, fetchImpl }), TypeError);
  assert.throws(() => new HostAuth(), TypeError);
});

test('the fetch is called detached, so a bound fetch and a bare one both work', async () => {
  let receiver = 'unset';
  const fetchImpl = async function fetchLike(url, options) {
    receiver = this;
    return fakeAuthFetch({ redeem: VALID })(url, options);
  };
  const { auth } = setup({ fetchImpl });
  await auth.redeem(TOKEN, { homeNetworkId: 'n1' });
  assert.notEqual(receiver, auth, 'it is never called as a method of HostAuth (an unbound browser fetch would throw Illegal invocation)');
});
