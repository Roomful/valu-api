// ===========================================================================
// HostBridge — the sign-in token channel and the resilience wiring (spec §4.3
// "Popup channels", §4.4, §4.11): a popup on a Valu origin posts a one-time
// token to the host iframe, which redeems it and comes up signed in; and what
// the host does when its link to the platform drops, comes back, is refused, or
// when another tab signs the user out.
//
// Runs on the fakes of `test/helpers/hostBridgeFakes.js`: the master is
// `fakeMaker`, whose connections a test moves with `setState` / `reconnected`;
// `auth` is `fakeAuth` (whose `redeem` a test scripts) except in the end-to-end
// cases, which use the real `HostAuth` and `SessionStore` over `FakeStorage`.
// The Guru socket is a fake client; the grants are the real `GrantsStore`.
//
// Reading the pushes: `api:trigger` messages are `{action, data}`; `auth`,
// `connection` and `commerce` are the three actions (protocol.js).
// ===========================================================================
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as CommerceIntents from '../../src/host/CommerceIntents.js';
import { GrantsStore } from '../../src/host/GrantsStore.js';
import { GuruClient, GuruError } from '../../src/host/GuruClient.js';
import { HostAuth } from '../../src/host/HostAuth.js';
import { MSG, POPUP_MSG } from '../../src/host/protocol.js';
import { SESSION_KEY, SessionStore } from '../../src/host/SessionStore.js';
import {
  APP, APP_ORIGIN, INFO, OTHER_ORIGIN, REDEEMED, SESSION, codedError, deferred, fakeAuth, fakeMaker, settle, setup,
} from '../helpers/hostBridgeFakes.js';
import { FakeStorage, fakeAuthFetch } from '../helpers/hostFakes.js';

// ---------------------------------------------------------------------------
// Fakes and helpers
// ---------------------------------------------------------------------------

const MASTER = 'api.roomful.net';
const SIGN_IN = 'https://live.valuverse.io';
const SIGN_IN_ORIGINS = ['https://live.valuverse.io', 'https://valu-social.com', 'https://chabaduniverse.com', 'https://texpo.io'];
const TOKEN = 'ott-SECRET-TOKEN';
const POPUP = { popup: true };

/** Every bridge a test starts, stopped afterwards. */
const bridges = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

/** `services.call(name, params)` answers `answer(name, params)`; every call is recorded. */
function fakeServices(answer = () => ({ data: {} })) {
  const services = {
    calls: [],
    answer,
    call: async (name, params) => {
      services.calls.push({ name, params });
      return services.answer(name, params);
    },
  };
  return services;
}

const LIST = 'valuguru.apps.grants.list';
const GRANT = 'valuguru.apps.grants.grant';

/**
 * A Valu Guru client: `request(op, params)` answers `handlers[op]`; `frame(f)` is
 * what the server pushes; `setState(state, lastError?)` moves it the way
 * `GuruClient` does; `close()` clears the listeners, as `GuruClient.close` does.
 */
function fakeGuru(handlers = {}, { keepListenersOnClose = false } = {}) {
  const stateHandlers = new Set();
  const guru = {
    handlers,
    requests: [],
    closed: 0,
    state: 'idle',
    lastError: null,
    listeners: new Set(),
    async request(op, params) {
      guru.requests.push({ op, params });
      const handler = guru.handlers[op];
      if (handler === undefined) throw new GuruError('unknown_op', `no handler for ${op}`);
      return typeof handler === 'function' ? handler(params) : handler;
    },
    onCommerceEvent(listener) {
      guru.listeners.add(listener);
      return () => guru.listeners.delete(listener);
    },
    onStateChange(handler) {
      stateHandlers.add(handler);
      return () => stateHandlers.delete(handler);
    },
    setState(next, lastError) {
      const previous = guru.state;
      guru.state = next;
      if (lastError !== undefined) guru.lastError = lastError;
      for (const handler of [...stateHandlers]) handler(next, previous);
    },
    close() {
      guru.closed += 1;
      if (!keepListenersOnClose) guru.listeners.clear();
    },
    frame(frame) {
      for (const listener of [...guru.listeners]) listener(frame);
    },
    ops: (op) => guru.requests.filter((request) => request.op === op),
  };
  return guru;
}

/** A Guru whose grants table holds `granted` for this app. */
function guruWithGrants(granted = [], extra = {}, options) {
  return fakeGuru({
    [LIST]: () => ({ grants: granted.map((scope) => ({ scope, appId: APP.address, revokedAt: null })) }),
    [GRANT]: (params) => {
      granted.push(...params.scopes);
      return {};
    },
    ...extra,
  }, options);
}

/** `GrantsStore`s on a clock a test moves. */
const clockedGrants = (clock) => (guru, app) => new GrantsStore({ guru, appAddress: app.address, now: () => clock.now });

/**
 * A bridge on the fakes, the handshake finished. A session is restored at the
 * hello unless `auth` says otherwise (`auth: fakeAuth()` is a signed-out user).
 * `made` records what the bridge built.
 */
async function ready({
  services = fakeServices(), guru = guruWithGrants(), auth = fakeAuth({ session: SESSION }), config = {}, ...options
} = {}) {
  const made = { services: [], guru: [] };
  const env = setup({
    auth,
    makeServices: (connection, app) => { made.services.push({ connection, app }); return services; },
    makeGuru: (session, app) => { made.guru.push({ session, app }); return guru; },
    config: { signInOrigins: SIGN_IN_ORIGINS, ...config },
    ...options,
  });
  bridges.push(env.bridge);
  await env.open();
  return { ...env, services, guru, made };
}

/** The sign-in page's message, as the host iframe hears it: from `origin`, from a window that is not the parent. */
const token = (env, extra = {}, options = {}) => env.host.dispatch({
  data: { type: POPUP_MSG.TOKEN, token: TOKEN, master: MASTER, ...extra },
  // `undefined` is a value a test may mean (an event with no origin), so a default would not do.
  origin: Object.hasOwn(options, 'origin') ? options.origin : SIGN_IN,
  source: Object.hasOwn(options, 'source') ? options.source : POPUP,
});

const ask = (env, service, action, params, requestId = 1) => env.call(MSG.CALL, { service, action, params, requestId });
const intent = (env, applicationId, action, params, requestId = 1) => env.call(
  MSG.SERVICE_INTENT, { applicationId, action, params, requestId },
);
const replies = (env, requestId) => env.posts().map((p) => p.data).filter((data) => data.requestId === requestId);
const replyTo = (env, requestId) => replies(env, requestId)[0];

/** The `api:trigger` messages of one action, in order: `{action, data}`. */
const pushes = (env, action) => env.posts().map((p) => p.data)
  .filter((data) => data.name === MSG.TRIGGER && data.message.action === action)
  .map((data) => data.message);
const authPushes = (env) => pushes(env, 'auth').map((message) => message.data);
const connectionPushes = (env) => pushes(env, 'connection').map((message) => message.data);

const SIGNED_OUT = { signedIn: false, user: null, network: null };
const SIGNED_IN = {
  signedIn: true, user: { id: 'u1', name: 'Ada Lovelace' }, network: { id: 'n1', name: 'Roomful' },
};

/** Everything an app could read or a developer could grep, as one string. */
const everything = (env) => JSON.stringify([env.posts(), env.logs, env.bridge.state]);

const ORDER_FRAME = { type: 'commerce_event', event: 'commerce.order.updated', orderId: 'o1', status: 'paid', appIds: ['demo'] };
const triggers = (env) => pushes(env, 'commerce');

// ---------------------------------------------------------------------------
// The token channel: who may speak
// ---------------------------------------------------------------------------

test('a token posted by the app page is ignored', async () => {
  const auth = fakeAuth();
  const env = await ready({ auth });
  // The app page itself: its own origin, the parent window.
  token(env, {}, { origin: APP_ORIGIN, source: env.app });
  // The app page claiming a sign-in origin: the parent window is never the sign-in window.
  token(env, {}, { origin: SIGN_IN, source: env.app });
  token(env, { cancelled: true }, { origin: SIGN_IN, source: env.app });
  await settle();

  assert.deepEqual(auth.redeemCalls, [], 'nothing was redeemed');
  assert.deepEqual(env.posts(), [], 'and nothing was pushed');
  assert.equal(env.maker.sessions.length, 0);
  assert.equal(env.bridge.state.signedIn, false);
});

test('a token from live.valuverse.io is redeemed and auth signedIn:true is pushed', async () => {
  const services = fakeServices(() => ({ data: { id: 'u1' } }));
  const env = await ready({ auth: fakeAuth(), services });
  token(env);
  await settle();

  assert.deepEqual(env.auth.redeemCalls, [{ token: TOKEN, options: { homeNetworkId: 'net-1' } }], 'the home network of the bound app');
  assert.deepEqual(env.maker.sessions, [REDEEMED.sessionId], 'the master is opened with the session the redeem gave');
  assert.deepEqual(authPushes(env), [SIGNED_IN]);
  assert.equal(env.posts()[0].data.requestId, undefined, 'a push answers nothing');
  assert.equal(env.posts()[0].targetOrigin, APP_ORIGIN);
  assert.deepEqual(connectionPushes(env), [{ state: 'ready' }], 'and the app hears the link is up');
  assert.deepEqual(env.bridge.state.user, SIGNED_IN.user);

  ask(env, 'Users', 'current', {}, 5);
  await settle();
  assert.deepEqual(replyTo(env, 5).message, { data: { id: 'u1' } }, 'calls are served now');
  assert.equal(env.made.services[0].connection, env.maker.connections[0]);
});

test('a token is redeemed for an app with no home network without one', async () => {
  const resolver = { resolve: async () => ({ ...APP, homeNetworkId: null }) };
  const env = await ready({ auth: fakeAuth(), resolver });
  token(env);
  await settle();
  assert.deepEqual(env.auth.redeemCalls, [{ token: TOKEN, options: { homeNetworkId: undefined } }]);
  assert.equal(authPushes(env)[0].signedIn, true);
});

test('a token is accepted from each Valu sign-in origin, with or without a window to name', async () => {
  for (const origin of SIGN_IN_ORIGINS) {
    for (const source of [POPUP, null]) {
      const env = await ready({ auth: fakeAuth() });
      token(env, {}, { origin, source });
      await settle();
      assert.equal(env.auth.redeemCalls.length, 1, `${origin} ${source === null ? '(a popup that already closed)' : ''}`);
      assert.equal(env.bridge.state.signedIn, true);
    }
  }
});

test('a token from an unlisted origin is ignored', async () => {
  const auth = fakeAuth();
  const env = await ready({ auth });
  for (const origin of [
    OTHER_ORIGIN,
    'https://evil.example',
    'https://live.valuverse.io.evil.example', // a look-alike
    'https://evillive.valuverse.io',
    'https://sub.live.valuverse.io',
    'http://live.valuverse.io', // wrong scheme
    'https://live.valuverse.io:8443', // wrong port
    'https://valuguru.texpo.io', // the host's own origin
    'null', // a sandboxed frame
    '*',
    '',
    undefined,
    null,
    { toString: () => SIGN_IN },
    'http://localhost:3005', // dev only
  ]) {
    token(env, {}, { origin });
    token(env, { cancelled: true }, { origin });
  }
  await settle();
  assert.deepEqual(auth.redeemCalls, []);
  assert.deepEqual(env.posts(), []);
  assert.equal(env.bridge.state.signedIn, false);
});

test('the dev sign-in origin is accepted in dev only', async () => {
  const dev = await ready({ auth: fakeAuth(), config: { dev: true } });
  token(dev, {}, { origin: 'http://localhost:3005' });
  await settle();
  assert.equal(dev.auth.redeemCalls.length, 1, 'localhost:3005 in a dev build');

  for (const config of [{}, { dev: 'true' }, { dev: 1 }]) {
    const env = await ready({ auth: fakeAuth(), config });
    token(env, {}, { origin: 'http://localhost:3005' });
    await settle();
    assert.equal(env.auth.redeemCalls.length, 0, `not with dev: ${JSON.stringify(config.dev)}`);
  }
});

test('an empty or mistyped sign-in list allows nobody', async () => {
  for (const signInOrigins of [[], 'https://live.valuverse.io', null, {}, [7, null]]) {
    const env = await ready({ auth: fakeAuth(), config: { signInOrigins } });
    token(env);
    await settle();
    assert.equal(env.auth.redeemCalls.length, 0, JSON.stringify(signInOrigins));
  }
});

test('a token before the handshake is ignored, and so is one while the host is still starting', async () => {
  const resolving = deferred();
  const auth = fakeAuth();
  const env = setup({
    auth, resolver: { resolve: () => resolving.promise }, config: { signInOrigins: SIGN_IN_ORIGINS },
  });
  bridges.push(env.bridge);

  token(env); // no hello yet: nothing is bound
  env.hello();
  await settle();
  token(env); // bound is not known yet: the resolver has not answered
  resolving.resolve(APP);
  await settle(); // bound, restored, ready
  assert.deepEqual(auth.redeemCalls, []);
  assert.equal(env.bridge.state.signedIn, false);
  assert.deepEqual(authPushes(env), []);

  token(env); // now it counts
  await settle();
  assert.equal(auth.redeemCalls.length, 1);
});

test('a token while the stored session is being restored is ignored', async () => {
  const restoring = deferred();
  const auth = fakeAuth({ restore: () => restoring.promise });
  const env = setup({ auth, config: { signInOrigins: SIGN_IN_ORIGINS } });
  bridges.push(env.bridge);
  env.hello();
  await settle();
  token(env);
  await settle();
  assert.deepEqual(auth.redeemCalls, [], 'nothing is served before api:ready');
  restoring.resolve(null);
  await settle();
});

test('a message of another type from a sign-in origin is not a token', async () => {
  const env = await ready({ auth: fakeAuth() });
  for (const data of [
    { type: 'valu-host:tokens', token: TOKEN, master: MASTER },
    { type: 'VALU-HOST:TOKEN', token: TOKEN, master: MASTER },
    { name: MSG.CALL, message: { service: 'Users', action: 'current', requestId: 1 } },
    { token: TOKEN, master: MASTER },
    'valu-host:token',
    null,
  ]) env.host.dispatch({ data, origin: SIGN_IN, source: POPUP });
  await settle();
  assert.deepEqual(env.auth.redeemCalls, []);
  assert.deepEqual(env.posts(), []);
});

// ---------------------------------------------------------------------------
// The token channel: what a token says
// ---------------------------------------------------------------------------

test('master mismatch pushes reason master_mismatch and does not redeem', async () => {
  const env = await ready({ auth: fakeAuth() });
  token(env, { master: 'dev.roomful.net' });
  token(env, { master: undefined });
  token(env, { master: { toString: () => MASTER } });
  await settle();

  assert.deepEqual(env.auth.redeemCalls, [], 'the token is never sent anywhere');
  assert.equal(env.maker.sessions.length, 0);
  assert.deepEqual(authPushes(env), Array(3).fill({ ...SIGNED_OUT, reason: 'master_mismatch' }));
  assert.equal(env.bridge.state.signedIn, false);
});

test('the master a token must name is the configured one', async () => {
  const env = await ready({ auth: fakeAuth(), config: { master: 'dev.roomful.net' } });
  token(env, { master: MASTER });
  token(env, { master: 'dev.roomful.net' });
  await settle();
  assert.equal(env.auth.redeemCalls.length, 1, 'only the matching one');
  assert.deepEqual(authPushes(env).map((data) => data.reason), ['master_mismatch', undefined]);
});

test('cancelled pushes signedIn:false cancelled', async () => {
  const env = await ready({ auth: fakeAuth() });
  token(env, { cancelled: true, token: undefined, master: undefined });
  await settle();
  assert.deepEqual(env.auth.redeemCalls, []);
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'cancelled' }]);
});

test('cancelled is only the boolean true', async () => {
  const env = await ready({ auth: fakeAuth() });
  token(env, { cancelled: 'true', master: undefined });
  token(env, { cancelled: 1, master: undefined });
  await settle();
  assert.deepEqual(authPushes(env).map((data) => data.reason), ['master_mismatch', 'master_mismatch']);
});

test('cancelling while signed in changes nothing: the session stays and the push says so', async () => {
  const auth = fakeAuth({ session: SESSION });
  const env = await ready({ auth });
  token(env, { cancelled: true });
  await settle();
  assert.equal(auth.signOutCalls, 0);
  assert.equal(env.maker.connections[0].closed, 0);
  assert.equal(env.bridge.state.signedIn, true);
  assert.deepEqual(authPushes(env), [{ ...SIGNED_IN, reason: 'cancelled' }], 'signedIn is the state now, not the popup\'s');
});

test('every refusal of a token is pushed as its reason, and no session is opened', async () => {
  for (const [error, reason] of [
    [codedError('not_a_member'), 'not_a_member'],
    [codedError('invalid_token'), 'invalid_token'],
    [codedError('unavailable'), 'unavailable'],
    [codedError('session_expired'), 'session_expired'],
    [codedError('timeout'), 'timeout'],
    [codedError('something_new'), 'unavailable'],
    [new TypeError('boom'), 'unavailable'],
  ]) {
    const auth = fakeAuth({ redeem: () => { throw error; } });
    const env = await ready({ auth });
    token(env);
    await settle();
    assert.equal(auth.redeemCalls.length, 1);
    assert.equal(env.maker.sessions.length, 0, `${reason}: no master`);
    assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason }]);
    assert.equal(auth.signOutCalls, 0, 'a refused token is not a sign-out');
    assert.deepEqual(connectionPushes(env), [], 'a user who was never signed in has no connection to lose');
    assert.equal(env.logs.length, 1, 'and the refusal is logged, by the reason the app is told');
    assert.equal(env.logs[0].level, 'warn');
    assert.equal(env.logs[0].message, `a sign-in token could not be redeemed (${reason})`, 'never the raw code or message');
  }
});

test('not_a_member is pushed when the switch is refused', async () => {
  // The real HostAuth: the redeemed session is in another network, and network:switch refuses it.
  const storage = new FakeStorage();
  const store = new SessionStore({ storage });
  const tempMaker = fakeMaker({ info: { ...INFO, networkId: 'elsewhere' } });
  const auth = new HostAuth({
    sessionStore: store,
    fetchImpl: fakeAuthFetch(),
    makeConnection: (sessionId) => {
      const connection = tempMaker.make(sessionId);
      connection.switchNetwork = async () => { throw codedError('not_a_member'); };
      return connection;
    },
  });
  const env = await ready({ auth });
  token(env);
  await settle();

  assert.equal(tempMaker.connections.length, 1, 'the redeem opened a temporary master');
  assert.equal(tempMaker.connections[0].closed, 1, 'and closed it');
  assert.equal(env.maker.sessions.length, 0, 'the host opened none of its own');
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'not_a_member' }]);
  assert.equal(storage.getItem(SESSION_KEY), null, 'nothing was stored');
});

test('after a not_a_member sign-in, calls answer 401 not_a_member, not sign_in_required', async () => {
  const auth = fakeAuth({ redeem: () => { throw codedError('not_a_member'); } });
  const env = await ready({ auth });
  ask(env, 'Users', 'current', {}, 1);
  await settle();
  assert.deepEqual(replyTo(env, 1).message, { error: { status: true, code: 401, message: 'sign_in_required' } }, 'before: signed out');

  token(env);
  await settle();
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'not_a_member' }]);
  assert.equal(env.bridge.state.signedIn, false, 'the host stays signed out');

  ask(env, 'Users', 'current', {}, 2);
  ask(env, 'Groups', 'list-groups', {}, 3);
  intent(env, 'Commerce', 'list-products', {}, 4);
  intent(env, 'Application', 'get-identity-token', {}, 5);
  env.call(MSG.CONSENT, { scopes: ['rooms:read'], nonce: 'n-1', requestId: 6 });
  await settle();
  for (const id of [2, 3]) {
    assert.deepEqual(replyTo(env, id).message, { error: { status: true, code: 401, message: 'not_a_member' } }, `request ${id}`);
  }
  for (const id of [4, 5]) {
    assert.equal(replyTo(env, id).message.success, false, `request ${id}`);
    assert.equal(replyTo(env, id).message.code, 'not_a_member', `request ${id}`);
    assert.equal(typeof replyTo(env, id).message.error, 'string');
  }
  assert.deepEqual(replyTo(env, 6).message, { approved: false, reason: 'not_a_member' });
  assert.deepEqual(env.services.calls, []);
  assert.deepEqual(env.guru.requests, []);

  // A cancelled popup changes nothing about the user's membership.
  token(env, { cancelled: true });
  await settle();
  ask(env, 'Users', 'current', {}, 7);
  await settle();
  assert.equal(replyTo(env, 7).message.error.message, 'not_a_member');
});

test('not_a_member lasts until the next sign-in attempt starts', async () => {
  const redeeming = deferred();
  let attempt = 0;
  const auth = fakeAuth({
    redeem: () => {
      attempt += 1;
      if (attempt === 1) throw codedError('not_a_member');
      return redeeming.promise;
    },
  });
  const env = await ready({ auth });
  token(env);
  await settle();

  token(env, { token: 'ott-2' }); // the next attempt: the redeem is under way
  await settle();
  ask(env, 'Users', 'current', {}, 1);
  await settle();
  assert.deepEqual(replyTo(env, 1).message, { error: { status: true, code: 401, message: 'sign_in_required' } });

  redeeming.resolve(REDEEMED);
  await settle();
  assert.equal(env.bridge.state.signedIn, true);
  ask(env, 'Users', 'current', {}, 2);
  await settle();
  assert.deepEqual(replyTo(env, 2).message, { data: {} }, 'signed in: the call runs');

  env.call(MSG.AUTH, { action: 'sign-out', requestId: 3 });
  await settle();
  ask(env, 'Users', 'current', {}, 4);
  await settle();
  assert.equal(replyTo(env, 4).message.error.message, 'sign_in_required', 'a later sign-out is a plain one');
});

test('any other refusal of a sign-in leaves calls at sign_in_required', async () => {
  for (const code of ['invalid_token', 'unavailable', 'session_expired']) {
    const env = await ready({ auth: fakeAuth({ redeem: () => { throw codedError(code); } }) });
    token(env);
    await settle();
    ask(env, 'Users', 'current', {}, 1);
    await settle();
    assert.equal(replyTo(env, 1).message.error.message, 'sign_in_required', code);
  }
});

test('a redeemed session the master then refuses is forgotten and pushed as session_expired', async () => {
  const auth = fakeAuth();
  const env = await ready({ auth, maker: fakeMaker({ error: codedError('session_expired') }) });
  token(env);
  await settle();
  assert.equal(auth.signOutCalls, 1, 'the stored session is cleared');
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'session_expired' }]);
  assert.equal(env.maker.connections[0].closed, 1, 'the failed connection is closed');
  assert.deepEqual(env.bridge.state.lastError, { code: 'session_expired', message: 'the session is no longer valid' });
});

test('a redeemed session whose master cannot be reached is kept, and pushed as unavailable', async () => {
  const auth = fakeAuth();
  const env = await ready({ auth, maker: fakeMaker({ error: codedError('unavailable') }) });
  token(env);
  await settle();
  assert.equal(auth.signOutCalls, 0, 'the session may be fine: a reload retries it');
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'unavailable' }]);
  assert.equal(env.bridge.state.signedIn, false);
});

test('a redeem that answers without a session is unavailable', async () => {
  const env = await ready({ auth: fakeAuth({ redeem: () => ({ userId: 'u1', networkId: 'n1' }) }) });
  token(env);
  await settle();
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'unavailable' }]);
  assert.equal(env.maker.sessions.length, 0);
});

test('a bridge whose auth cannot redeem answers unavailable', async () => {
  const auth = fakeAuth();
  auth.redeem = undefined;
  const env = await ready({ auth });
  token(env);
  await settle();
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'unavailable' }]);
});

// ---------------------------------------------------------------------------
// The token channel: a user who is signed in already
// ---------------------------------------------------------------------------

test('a token while signed in replaces the session: sign out first, then redeem', async () => {
  const auth = fakeAuth({ session: SESSION });
  const env = await ready({ auth });
  assert.equal(env.bridge.state.signedIn, true);
  const stale = env.maker.connections[0];

  token(env);
  await settle();

  assert.equal(auth.signOutCalls, 1, 'the old session is forgotten before the new one is stored');
  assert.equal(stale.closed, 1, 'the old connection is closed');
  assert.deepEqual(env.maker.sessions, [SESSION.sessionId, REDEEMED.sessionId]);
  assert.equal(auth.redeemCalls.length, 1);
  assert.deepEqual(authPushes(env), [SIGNED_IN], 'one push: the app is never told it was signed out');
  assert.deepEqual(connectionPushes(env), [], 'the link was up before and is up after');
  assert.equal(env.bridge.state.signedIn, true);
});

test('a replacement token that is refused leaves the user signed out, and says so', async () => {
  let refuse = false;
  const auth = fakeAuth({ session: SESSION, redeem: () => { if (refuse) throw codedError('not_a_member'); return REDEEMED; } });
  const env = await ready({ auth });
  refuse = true;
  token(env);
  await settle();
  assert.equal(env.bridge.state.signedIn, false);
  assert.equal(env.maker.connections[0].closed, 1);
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'not_a_member' }]);
  assert.deepEqual(connectionPushes(env), [{ state: 'signed_out' }]);
});

test('two tokens in a row are redeemed one at a time, in arrival order, and the second wins', async () => {
  const first = deferred();
  const second = deferred();
  const results = [first, second];
  const auth = fakeAuth({ redeem: () => results.shift().promise });
  const env = await ready({ auth });

  token(env, { token: 'ott-1' });
  token(env, { token: 'ott-2' });
  await settle();
  assert.deepEqual(auth.redeemCalls.map((call) => call.token), ['ott-1'], 'the second waits for the first');

  first.resolve({ userId: 'u1', sessionId: 'sess-A', networkId: 'net-1' });
  await settle();
  assert.deepEqual(auth.redeemCalls.map((call) => call.token), ['ott-1', 'ott-2']);
  assert.equal(auth.signOutCalls, 1, 'the first session was signed out for the second');
  second.resolve({ userId: 'u1', sessionId: 'sess-B', networkId: 'net-1' });
  await settle();

  assert.deepEqual(env.maker.sessions, ['sess-A', 'sess-B']);
  assert.equal(env.maker.connections[0].closed, 1);
  assert.equal(env.maker.connections[1].closed, 0);
  assert.equal(env.bridge.state.signedIn, true);
});

test('a sign-out while the token is being redeemed wins: no session comes up, and the stored one is forgotten', async () => {
  const redeeming = deferred();
  const auth = fakeAuth({ redeem: () => redeeming.promise });
  const env = await ready({ auth });
  token(env);
  await settle();
  env.call(MSG.AUTH, { action: 'sign-out', requestId: 9 });
  await settle();
  assert.equal(auth.signOutCalls, 1);
  env.posts().length = 0;

  redeeming.resolve(REDEEMED); // the redeem stored the session just now
  await settle();
  assert.equal(env.maker.sessions.length, 0, 'no master is opened');
  assert.equal(auth.signOutCalls, 2, 'and the session the redeem stored is cleared again');
  assert.deepEqual(env.posts(), [], 'the app is told nothing it was not told');
  assert.equal(env.bridge.state.signedIn, false);
});

test('a sign-out while the master is connecting for a token wins too', async () => {
  const connecting = deferred();
  const auth = fakeAuth();
  const env = await ready({
    auth, maker: fakeMaker({ connect: async () => { await connecting.promise; return INFO; } }),
  });
  token(env);
  await settle();
  assert.equal(env.maker.sessions.length, 1);
  env.call(MSG.AUTH, { action: 'sign-out', requestId: 3 });
  await settle();
  env.posts().length = 0;
  connecting.resolve();
  await settle();
  assert.equal(env.bridge.state.signedIn, false);
  assert.deepEqual(env.posts(), []);
});

test('a bridge stopped while the token is being redeemed opens nothing and says nothing', async () => {
  const redeeming = deferred();
  const env = await ready({ auth: fakeAuth({ redeem: () => redeeming.promise }) });
  token(env);
  await settle();
  await env.bridge.stop();
  redeeming.resolve(REDEEMED);
  await settle();
  assert.equal(env.maker.sessions.length, 0);
  assert.deepEqual(env.posts(), []);
  assert.equal(env.auth.signOutCalls, 0, 'stopping is not signing out: the session the redeem stored stays');
});

// ---------------------------------------------------------------------------
// No secret leaves, or is logged
// ---------------------------------------------------------------------------

test('the token and the sessions never appear in a message, a log line or the state', async () => {
  const leaky = codedError('weird');
  leaky.message = `the master said no to ${TOKEN} for ${REDEEMED.sessionId}`;
  const outcomes = [
    () => REDEEMED, // signed in
    () => { throw codedError('invalid_token'); },
    () => { throw leaky; },
    () => { throw codedError('not_a_member'); },
  ];
  const auth = fakeAuth({ redeem: () => outcomes.shift()() });
  const env = await ready({ auth, maker: fakeMaker({ error: Object.assign(new Error(`connect ${REDEEMED.sessionId}`), { code: 'unavailable' }) }) });
  for (let i = 0; i < 4; i += 1) {
    token(env);
    await settle();
  }
  token(env, { master: `${MASTER}/${TOKEN}` }); // a mismatch must not echo what it was given
  token(env, { cancelled: true });
  await settle();

  assert.ok(env.posts().length >= 5, 'a good many pushes went out');
  assert.ok(env.logs.length >= 1, 'something was logged');
  const text = everything(env);
  assert.ok(!text.includes(TOKEN), 'no token');
  assert.ok(!text.includes('SECRET'), 'no session id');
  assert.ok(!text.includes(REDEEMED.sessionId));
  assert.ok(!text.includes(SESSION.sessionId));
});

test('a signed-in user\'s messages carry no session id either', async () => {
  const env = await ready({ auth: fakeAuth() });
  token(env);
  await settle();
  ask(env, 'Users', 'current', {}, 1);
  token(env, { cancelled: true });
  env.maker.connections[0].setState('reconnecting');
  env.maker.connections[0].reconnected(INFO);
  env.call(MSG.AUTH, { action: 'sign-out', requestId: 2 });
  await settle();
  assert.ok(env.posts().length >= 5);
  const text = everything(env);
  assert.ok(!text.includes('SECRET'));
  assert.ok(!text.includes(TOKEN));
});

// ---------------------------------------------------------------------------
// End to end: the real HostAuth and SessionStore
// ---------------------------------------------------------------------------

/** A real `HostAuth` over a real `SessionStore`; `change()` is another tab's `storage` event. */
function realAuth({ info = { ...INFO, networkId: 'net-1' } } = {}) {
  const storage = new FakeStorage();
  const wired = { handler: null };
  const store = new SessionStore({ storage, subscribe: (handler) => { wired.handler = handler; } });
  const fetchImpl = fakeAuthFetch({
    redeem: { data: { user_id: 'u1', session_token: 'sess-FROM-POPUP' }, error: { status: false, code: 200, message: '' } },
  });
  // `hold.check` is a deferred a test sets to keep the next `auth/check` waiting.
  const hold = { check: null };
  const gated = async (url, options) => {
    if (hold.check && String(url).endsWith('/auth/check')) await hold.check.promise;
    return fetchImpl(url, options);
  };
  const tempMaker = fakeMaker({ info });
  const auth = new HostAuth({ sessionStore: store, fetchImpl: gated, makeConnection: (sessionId) => tempMaker.make(sessionId) });
  const otherTab = new SessionStore({ storage });
  return {
    storage, store, auth, fetchImpl, hold, tempMaker, otherTab, change: () => wired.handler(),
  };
}

test('end to end: a token is redeemed by the real auth, stored, and survives in storage', async () => {
  const real = realAuth();
  const env = await ready({ auth: real.auth, sessionStore: real.store });
  token(env);
  await settle();

  assert.deepEqual(env.maker.sessions, ['sess-FROM-POPUP']);
  assert.deepEqual(authPushes(env), [SIGNED_IN]);
  assert.equal(real.store.get('net-1').sessionId, 'sess-FROM-POPUP');
  assert.ok(real.fetchImpl.calls.some((call) => call.url.includes('checkOneTimeAuthToken')));
  assert.ok(!JSON.stringify(env.logs).includes(TOKEN));
});

// ---------------------------------------------------------------------------
// Another tab: the storage event
// ---------------------------------------------------------------------------

/** A signed-in bridge whose session is the one in storage, as the real auth restored it. */
async function withStoredSession(options = {}) {
  const real = realAuth();
  real.store.set({ userId: 'u1', networkId: 'net-1', sessionId: SESSION.sessionId });
  const env = await ready({ auth: real.auth, sessionStore: real.store, ...options });
  assert.equal(env.bridge.state.signedIn, true, 'restored from storage');
  env.posts().length = 0;
  return { ...env, real };
}

test('external storage change signs this tab out', async () => {
  const env = await withStoredSession();
  const checks = env.real.fetchImpl.calls.length;
  const connection = env.maker.connections[0];

  env.real.storage.removeItem(SESSION_KEY); // another tab signed out
  env.real.change();
  await settle();

  assert.equal(env.bridge.state.signedIn, false);
  assert.equal(connection.closed, 1, 'the master is closed');
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'signed_out_elsewhere' }]);
  assert.deepEqual(connectionPushes(env), [{ state: 'signed_out' }]);
  assert.deepEqual(env.names(), [MSG.TRIGGER, MSG.TRIGGER], 'and nothing is answered: nobody asked');
  assert.equal(env.real.fetchImpl.calls.length, checks, 'nothing is asked of the master');
  assert.equal(env.real.storage.getItem(SESSION_KEY), null);
});

test('a sign-out elsewhere does not clear what the other tab stored since', async () => {
  const env = await withStoredSession();
  // The other tab signed in as somebody else, in another network: our session is gone from the record.
  env.real.otherTab.clear();
  env.real.otherTab.set({ userId: 'u2', networkId: 'other-net', sessionId: 'sess-OTHER-USER' });
  env.real.change();
  await settle();

  assert.equal(env.bridge.state.signedIn, false);
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'signed_out_elsewhere' }]);
  assert.equal(env.real.store.get('other-net').sessionId, 'sess-OTHER-USER', 'their record is theirs');
});

test('a session replaced in storage is dropped and restored from storage', async () => {
  const env = await withStoredSession();
  const stale = env.maker.connections[0];

  env.real.otherTab.set({ userId: 'u1', networkId: 'net-1', sessionId: 'sess-REPLACED' }); // signed in again, there
  env.real.change();
  await settle();

  assert.equal(stale.closed, 1);
  assert.deepEqual(env.maker.sessions, [SESSION.sessionId, 'sess-REPLACED']);
  assert.equal(env.bridge.state.signedIn, true);
  assert.deepEqual(authPushes(env), [SIGNED_IN], 'told who the user is');
  assert.deepEqual(connectionPushes(env), [], 'the link was up and is up');
  const check = env.real.fetchImpl.calls.at(-1);
  assert.equal(check.headers['X-Session-Id'], 'sess-REPLACED', 'the master checked the new session');
});

test('a session replaced by one the master refuses leaves the user signed out', async () => {
  const env = await withStoredSession();
  env.real.otherTab.set({ userId: 'u1', networkId: 'net-1', sessionId: 'sess-REPLACED' });
  env.real.fetchImpl.check = 401; // the replacement was never good
  env.real.change();
  await settle();
  assert.equal(env.bridge.state.signedIn, false);
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'signed_out_elsewhere' }]);
  assert.deepEqual(connectionPushes(env), [{ state: 'signed_out' }]);
});

test('a sign-out while the other tab\'s session is being restored wins', async () => {
  const env = await withStoredSession();
  env.real.otherTab.set({ userId: 'u1', networkId: 'net-1', sessionId: 'sess-REPLACED' });
  env.real.hold.check = deferred(); // the master is slow to say whether the replacement stands
  env.real.change();
  await settle();
  env.call(MSG.AUTH, { action: 'sign-out', requestId: 4 });
  await settle();
  env.posts().length = 0;

  env.real.hold.check.resolve();
  await settle();
  assert.equal(env.maker.sessions.length, 1, 'the restored session was not opened');
  assert.equal(env.bridge.state.signedIn, false);
  assert.deepEqual(env.posts(), []);
});

test('a storage change that leaves this session in place changes nothing', async () => {
  const env = await withStoredSession();
  const checks = env.real.fetchImpl.calls.length;
  // Another tab signed in to ANOTHER network, as the same user: our session is still in the record.
  env.real.otherTab.set({ userId: 'u1', networkId: 'other-net', sessionId: 'sess-OTHER-NET' });
  env.real.change();
  env.real.change();
  await settle();
  assert.equal(env.bridge.state.signedIn, true);
  assert.equal(env.maker.connections[0].closed, 0);
  assert.deepEqual(env.posts(), []);
  assert.equal(env.real.fetchImpl.calls.length, checks);
});

test('a signed-out tab ignores storage changes', async () => {
  const real = realAuth();
  const env = await ready({ auth: real.auth, sessionStore: real.store });
  real.otherTab.set({ userId: 'u1', networkId: 'net-1', sessionId: 'sess-THEIRS' });
  real.change();
  await settle();
  assert.equal(env.bridge.state.signedIn, false);
  assert.deepEqual(env.posts(), []);
  assert.deepEqual(real.fetchImpl.calls, [], 'not even a check');
});

test('storage changes in a burst are judged by what storage says when they run', async () => {
  const env = await withStoredSession();
  env.real.otherTab.set({ userId: 'u1', networkId: 'net-1', sessionId: 'sess-REPLACED' });
  env.real.change();
  env.real.storage.removeItem(SESSION_KEY);
  env.real.change();
  env.real.change();
  await settle();
  assert.equal(env.bridge.state.signedIn, false, 'the last word is a sign-out');
  assert.equal(authPushes(env).at(-1).reason, 'signed_out_elsewhere');
  assert.equal(env.maker.connections.at(-1).closed, 1, 'no connection is left open');
  const open = env.maker.connections.filter((connection) => connection.closed === 0);
  assert.deepEqual(open, []);
});

test('a bridge listens to the session store while it runs and not after it stops', async () => {
  const handlers = new Set();
  const sessionStore = {
    onChange(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    load: () => null,
  };
  const env = setup({ sessionStore, start: false });
  assert.equal(handlers.size, 0, 'not before it starts');
  env.bridge.start();
  env.bridge.start();
  assert.equal(handlers.size, 1, 'once');
  await env.bridge.stop();
  assert.equal(handlers.size, 0);
});

test('a session store that cannot be read, or is not there, is not a sign-out', async () => {
  const fire = [];
  const sessionStore = { onChange: (handler) => { fire.push(handler); return () => {}; } };
  const env = await ready({ sessionStore });
  fire[0]();
  await settle();
  assert.equal(env.bridge.state.signedIn, true, 'a store that cannot say what it holds does not sign anyone out');

  const none = await ready({ sessionStore: null });
  assert.equal(none.bridge.state.signedIn, true, 'and a bridge with no store at all runs');
});

// ---------------------------------------------------------------------------
// The connection: pushes and state
// ---------------------------------------------------------------------------

test('the connection state is pushed as it changes, and only when it changes', async () => {
  const env = await ready();
  const master = env.maker.connections[0];
  assert.equal(env.bridge.state.connection, 'ready');

  master.setState('reconnecting');
  master.setState('connecting'); // a replacement after a drop: still reconnecting to the app
  master.setState('failed', codedError('unavailable'));
  master.setState('connecting');
  master.setState('ready');
  master.setState('failed', codedError('unavailable'));
  await settle();

  assert.deepEqual(connectionPushes(env), [
    { state: 'reconnecting' }, { state: 'ready' }, { state: 'reconnecting' },
  ]);
  assert.equal(env.posts()[0].data.requestId, undefined);
  assert.equal(env.posts()[0].targetOrigin, APP_ORIGIN);
  assert.equal(env.bridge.state.connection, 'reconnecting');
  assert.equal(env.bridge.state.signedIn, true, 'a drop is not a sign-out');
  assert.equal(env.auth.signOutCalls, 0);
});

test('a link that is down while the browser is offline reads offline', async () => {
  const env = await ready();
  const master = env.maker.connections[0];
  env.host.navigator = { onLine: false };
  master.setState('reconnecting');
  master.setState('failed', codedError('unavailable'));
  env.host.navigator = { onLine: true };
  master.setState('connecting');
  master.setState('ready');
  assert.deepEqual(connectionPushes(env).map((data) => data.state), ['offline', 'reconnecting', 'ready']);
});

test('the connection state and the last error are on the bridge state, without secrets', async () => {
  const signedOut = await ready({ auth: fakeAuth() });
  assert.equal(signedOut.bridge.state.connection, 'signed_out');
  assert.equal(signedOut.bridge.state.lastError, null);

  const env = await ready();
  assert.equal(env.bridge.state.connection, 'ready');
  assert.equal(env.bridge.state.lastError, null);
  const leaky = codedError('unavailable');
  leaky.message = `master unavailable: wss://x/?token=${SESSION.sessionId}`;
  env.maker.connections[0].setState('failed', leaky);
  assert.equal(env.bridge.state.connection, 'reconnecting');
  assert.deepEqual(env.bridge.state.lastError, { code: 'unavailable', message: 'the connection to Valu is unavailable' });
  assert.ok(!JSON.stringify(env.bridge.state).includes('SECRET'));

  env.maker.connections[0].setState('ready');
  env.maker.connections[0].lastError = null;
  assert.equal(env.bridge.state.lastError, null, 'cleared when the link is back');
  assert.equal(env.bridge.state.connection, 'ready');
});

test('events from a master the bridge has let go of are ignored', async () => {
  // A connection that keeps calling after it was closed (the real one clears its handlers; this one does not).
  const maker = fakeMaker();
  maker.keepHandlers = true;
  const env = await ready({ maker });
  const stale = maker.connections[0];
  env.call(MSG.AUTH, { action: 'sign-out', requestId: 1 });
  await settle();
  env.posts().length = 0;

  stale.setState('reconnecting');
  stale.reconnected({ ...INFO, networkId: 'n9' });
  stale.setState('failed', codedError('session_expired'));
  await settle();
  assert.deepEqual(env.posts(), [], 'nothing is pushed for a session that is over');
  assert.equal(env.auth.signOutCalls, 1, 'only the sign-out signed out');
  assert.equal(env.bridge.state.network, null);
});

test('events from the master a new session replaced do not touch the new session', async () => {
  const maker = fakeMaker();
  maker.keepHandlers = true;
  const env = await ready({ maker });
  const stale = maker.connections[0];
  token(env); // replaces the session
  await settle();
  assert.equal(maker.connections.length, 2);
  env.posts().length = 0;

  stale.setState('failed', codedError('session_expired'));
  stale.setState('reconnecting');
  stale.reconnected({ ...INFO, networkId: 'n9' });
  await settle();
  assert.deepEqual(env.posts(), []);
  assert.equal(env.bridge.state.signedIn, true);
  assert.equal(env.bridge.state.network.id, 'n1');
});

// ---------------------------------------------------------------------------
// Reconnect: re-sync
// ---------------------------------------------------------------------------

test('reconnected invalidates grants and pushes connection ready', async () => {
  const granted = ['groups:read'];
  const guru = guruWithGrants(granted);
  const env = await ready({ guru });
  const master = env.maker.connections[0];

  ask(env, 'Groups', 'list-groups', {}, 1);
  ask(env, 'Groups', 'list-groups', {}, 2);
  await settle();
  assert.equal(guru.ops(LIST).length, 1, 'the grants are cached');
  env.posts().length = 0;

  granted.length = 0; // revoked while the link was down
  master.setState('reconnecting');
  master.setState('ready');
  master.reconnected({ ...INFO });
  await settle();

  assert.deepEqual(connectionPushes(env), [{ state: 'reconnecting' }, { state: 'ready' }, { state: 'ready', reconnected: true }]);
  assert.deepEqual(authPushes(env), [], 'the same user in the same network: nothing to say');
  ask(env, 'Groups', 'list-groups', {}, 3);
  await settle();
  assert.equal(guru.ops(LIST).length, 2, 'the grants were read again');
  assert.equal(replyTo(env, 3).message.error.message, 'consent_required', 'and the revocation took effect at once');
});

test('a reconnect pushes ready with reconnected:true even when no state change preceded it', async () => {
  const env = await ready();
  env.maker.connections[0].reconnected(INFO);
  assert.deepEqual(env.posts().map((p) => p.data.message), [
    { action: 'connection', data: { state: 'ready', reconnected: true } },
  ]);
});

test('a reconnect does not rebuild the services: the socket they run over is stable', async () => {
  const env = await ready();
  ask(env, 'Users', 'current', {}, 1);
  await settle();
  env.maker.connections[0].reconnected(INFO);
  ask(env, 'Users', 'current', {}, 2);
  await settle();
  assert.equal(env.made.services.length, 1);
  assert.equal(env.services.calls.length, 2);
  assert.equal(env.maker.sessions.length, 1, 'and no new master was made');
});

test('a reconnect refreshes the user and the network from what user_info now says', async () => {
  const seen = [];
  const commerce = {
    ...CommerceIntents,
    runCommerceIntent: async (action, params, context) => { seen.push(context); return { success: true, products: [] }; },
  };
  const env = await ready({ guru: guruWithGrants(['commerce:read']), commerce });
  intent(env, 'Commerce', 'list-products', {}, 1);
  await settle();
  assert.equal(seen[0].user.name, 'Ada Lovelace');
  assert.equal(seen[0].networkId, 'n1');
  env.posts().length = 0;

  env.maker.connections[0].reconnected({
    userId: 'u1',
    networkId: 'n2',
    user: { id: 'u1', name: 'Ada King' },
    network: { id: 'n2', fullName: 'Another network' },
  });
  await settle();

  assert.deepEqual(env.bridge.state.user, { id: 'u1', name: 'Ada King' });
  assert.deepEqual(env.bridge.state.network, { id: 'n2', name: 'Another network' });
  assert.deepEqual(authPushes(env), [{
    signedIn: true, user: { id: 'u1', name: 'Ada King' }, network: { id: 'n2', name: 'Another network' },
  }], 'the app is told, before the reconnect');
  assert.deepEqual(connectionPushes(env), [{ state: 'ready', reconnected: true }]);
  assert.deepEqual(env.names(), [MSG.TRIGGER, MSG.TRIGGER]);
  assert.equal(env.posts()[0].data.message.action, 'auth');

  intent(env, 'Commerce', 'list-products', {}, 2);
  await settle();
  assert.equal(seen[1].user.name, 'Ada King', 'the Commerce user is the refreshed one');
  assert.equal(seen[1].networkId, 'n2');
});

test('a reconnect with nothing new to say about the user pushes no auth', async () => {
  const env = await ready();
  env.maker.connections[0].reconnected({ ...INFO, user: { id: 'u1', name: 'Ada Lovelace', extra: 1 } });
  env.maker.connections[0].reconnected(undefined); // a master that says nothing
  assert.deepEqual(authPushes(env), []);
  assert.equal(env.bridge.state.user.name, 'Ada Lovelace');
});

test('a grants cache that cannot be dropped does not stop the reconnect from being announced', async () => {
  const guru = guruWithGrants(['groups:read']);
  const env = await ready({
    guru,
    makeGrants: (g, app) => {
      const grants = new GrantsStore({ guru: g, appAddress: app.address });
      grants.invalidate = () => { throw new Error(`nope ${SESSION.sessionId}`); };
      return grants;
    },
  });
  ask(env, 'Groups', 'list-groups', {}, 1);
  await settle();
  env.posts().length = 0;
  env.maker.connections[0].reconnected(INFO);
  assert.deepEqual(connectionPushes(env), [{ state: 'ready', reconnected: true }]);
  assert.ok(env.logs.some((log) => log.level === 'warn'));
  assert.ok(!JSON.stringify(env.logs).includes('SECRET'));
});

test('a reconnect before any grant was needed has nothing to invalidate and still announces', async () => {
  const env = await ready();
  assert.equal(env.made.guru.length, 0);
  env.maker.connections[0].reconnected(INFO);
  assert.equal(env.made.guru.length, 0, 'it did not make a Guru client to drop its cache');
  assert.equal(connectionPushes(env).length, 1);
});

// ---------------------------------------------------------------------------
// session_expired
// ---------------------------------------------------------------------------

/** A held `api:call` and a held Commerce intent, each waiting on its own deferred. */
function holdRequests() {
  const heldCall = deferred();
  const heldIntent = deferred();
  const commerce = { ...CommerceIntents, runCommerceIntent: () => heldIntent.promise };
  const services = fakeServices(() => heldCall.promise);
  return { heldCall, heldIntent, commerce, services };
}

test('session_expired signs out and pushes the reason', async () => {
  const { heldCall, heldIntent, commerce, services } = holdRequests();
  const guru = guruWithGrants(['commerce:read']);
  const env = await ready({ guru, commerce, services });
  const master = env.maker.connections[0];

  // Valu Guru is in use, the app listens for events, a call and an intent are waiting on the master.
  intent(env, 'Commerce', 'subscribe-events', { events: ['order-updated'] }, 1);
  await settle();
  ask(env, 'Users', 'current', {}, 5);
  intent(env, 'Commerce', 'list-products', {}, 6);
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n-1', requestId: 7 });
  await settle();
  assert.equal(replyTo(env, 5), undefined, 'the call is held');
  assert.equal(replyTo(env, 6), undefined, 'the intent is held');
  env.posts().length = 0;

  // The master refuses the session when the replacement connection is tried.
  master.setState('failed', codedError('session_expired'));
  await settle();

  assert.equal(env.auth.signOutCalls, 1, 'the stored session is cleared');
  assert.equal(master.closed, 1, 'the master is closed');
  assert.equal(guru.closed, 1, 'and so is Valu Guru');
  assert.deepEqual(env.bridge.state, {
    bound: { origin: APP_ORIGIN, app: APP },
    signedIn: false,
    user: null,
    network: null,
    connection: 'signed_out',
    lastError: { code: 'session_expired', message: 'the session is no longer valid' },
  });

  assert.deepEqual(replyTo(env, 5).message, { error: { status: true, code: 401, message: 'sign_in_required' } });
  assert.equal(replyTo(env, 5).name, MSG.CALL_COMPLETED);
  assert.equal(replyTo(env, 6).name, MSG.RUN_CONSOLE_COMPLETED);
  assert.equal(replyTo(env, 6).message.success, false);
  assert.equal(replyTo(env, 6).message.code, 'sign_in_required');
  assert.deepEqual(replyTo(env, 7).message, { approved: false, reason: 'sign_in_required' }, 'a waiting consent is answered too');
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'session_expired' }]);
  assert.deepEqual(connectionPushes(env), [{ state: 'signed_out' }]);
  assert.equal(env.posts().length, 5, 'one answer each, and the two pushes');

  // What the late results do: nothing.
  env.posts().length = 0;
  heldCall.resolve({ data: { id: 'u1' } });
  heldIntent.resolve({ success: true, products: [] });
  await settle();
  assert.deepEqual(env.posts(), [], 'a held request is answered once');

  // The next call is refused at the door, and the grants, subscriptions and services start over.
  ask(env, 'Users', 'current', {}, 8);
  await settle();
  assert.deepEqual(replyTo(env, 8).message, { error: { status: true, code: 401, message: 'sign_in_required' } });
  assert.equal(env.services.calls.length, 1, 'the refused call never reached the services');
});

test('a session that expired is not announced twice', async () => {
  const env = await ready();
  const master = env.maker.connections[0];
  master.setState('failed', codedError('session_expired'));
  master.setState('failed', codedError('session_expired'));
  await settle();
  assert.equal(env.auth.signOutCalls, 1);
  assert.equal(authPushes(env).length, 1);
});

test('a lost connection that is not a refused session is not a sign-out', async () => {
  const env = await ready();
  const master = env.maker.connections[0];
  master.setState('failed', codedError('unavailable'));
  master.setState('failed', null);
  master.setState('failed', new Error('no code at all'));
  await settle();
  assert.equal(env.bridge.state.signedIn, true);
  assert.equal(env.auth.signOutCalls, 0);
  assert.equal(master.closed, 0);
  assert.deepEqual(env.bridge.state.lastError, { code: 'unavailable', message: 'the connection to Valu is unavailable' });
});

test('session_expired from the master, with Valu Guru never used, signs out without making a client', async () => {
  const env = await ready();
  env.maker.connections[0].setState('failed', codedError('session_expired'));
  await settle();
  assert.equal(env.made.guru.length, 0);
  assert.equal(env.bridge.state.signedIn, false);
});

test('session_expired reported by Valu Guru signs out', async () => {
  const guru = guruWithGrants(['groups:read']);
  const env = await ready({ guru });
  ask(env, 'Groups', 'list-groups', {}, 1); // makes the client
  await settle();
  env.posts().length = 0;

  guru.setState('reconnecting', Object.freeze({ code: 'timeout', message: 'x' }));
  guru.setState('offline');
  await settle();
  assert.equal(env.bridge.state.signedIn, true, 'only a refused session signs out');

  guru.setState('ready');
  guru.setState('reconnecting', Object.freeze({ code: 'session_expired', message: 'could not mint a Valu Guru token' }));
  await settle();
  assert.equal(env.bridge.state.signedIn, false);
  assert.equal(env.auth.signOutCalls, 1);
  assert.equal(guru.closed, 1);
  assert.equal(env.maker.connections[0].closed, 1);
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'session_expired' }]);
});

test('a one-time token mint the master refuses signs the user out, even with no state change to hear', async () => {
  const guru = guruWithGrants(['groups:read']);
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ error: { status: true, code: 401, message: 'Unauthorized' } }) });
  const env = await ready({ guru, fetchImpl });
  ask(env, 'Groups', 'list-groups', {}, 1);
  await settle();
  env.posts().length = 0;

  const { session } = env.made.guru[0];
  await assert.rejects(session.mintToken(), { code: 'session_expired' });
  await settle();
  assert.equal(env.bridge.state.signedIn, false);
  assert.equal(env.auth.signOutCalls, 1);
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'session_expired' }]);

  // A mint after sign-out is not a second expiry.
  await assert.rejects(session.mintToken(), { code: 'sign_in_required' });
  await settle();
  assert.equal(authPushes(env).length, 1);
});

test('a real GuruClient whose mint the master refuses ends the session and leaves nothing running', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const before = timers();
  class NeverOpens {
    static OPEN = 1;
    readyState = 0;
    send() {}
    close() { this.readyState = 3; }
  }
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ error: { status: true, code: 401, message: 'Unauthorized' } }) });
  const env = await ready({
    fetchImpl,
    makeGuru: (session) => new GuruClient({
      ...session, WebSocketImpl: NeverOpens, onlineSource: { onLine: true }, addEventListener: () => {},
    }),
  });

  ask(env, 'Groups', 'list-groups', {}, 1); // a consent-tier call: the grants are read from Valu Guru, which mints a token first
  for (let turns = 0; turns < 50 && env.bridge.state.signedIn; turns += 1) await settle();

  assert.equal(env.bridge.state.signedIn, false);
  assert.equal(env.auth.signOutCalls, 1);
  assert.equal(env.maker.connections[0].closed, 1);
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'session_expired' }]);
  assert.deepEqual(replyTo(env, 1).message, { error: { status: true, code: 401, message: 'sign_in_required' } }, 'the call that needed it is told to sign in');
  assert.equal(replies(env, 1).length, 1, 'once');
  assert.equal(timers(), before, 'the Guru client\'s retry timers went with the session');
});

test('a one-time token mint that fails for another reason is not a sign-out', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const env = await ready({ guru: guruWithGrants(['groups:read']), fetchImpl });
  ask(env, 'Groups', 'list-groups', {}, 1);
  await settle();
  await assert.rejects(env.made.guru[0].session.mintToken());
  assert.equal(env.bridge.state.signedIn, true);
});

test('a session that expires while the user signs in with a token is reported once', async () => {
  const env = await ready({ auth: fakeAuth() });
  token(env);
  await settle();
  env.maker.connections[0].setState('failed', codedError('session_expired'));
  await settle();
  assert.deepEqual(authPushes(env).map((data) => [data.signedIn, data.reason]), [[true, undefined], [false, 'session_expired']]);
});

// ---------------------------------------------------------------------------
// A session ends for the session that asked
// ---------------------------------------------------------------------------

test('a Guru mint the master refuses after the session was replaced does not end the new session', async () => {
  const gate = deferred();
  const fetchImpl = async () => {
    await gate.promise;
    return { ok: true, status: 200, json: async () => ({ error: { status: true, code: 401, message: 'Unauthorized' } }) };
  };
  const env = await withStoredSession({ guru: guruWithGrants(['groups:read']), fetchImpl });
  ask(env, 'Groups', 'list-groups', {}, 1); // makes the Guru client
  await settle();
  const { session } = env.made.guru[0];
  const minting = session.mintToken().then(() => null, (error) => error); // in flight, for the old session
  await settle();

  token(env); // the user signs in again: a new session replaces it
  await settle();
  assert.equal(env.bridge.state.signedIn, true);
  assert.equal(env.real.store.get('net-1').sessionId, 'sess-FROM-POPUP');
  env.posts().length = 0;

  gate.resolve(); // the master answers the old mint: refused
  const error = await minting;
  await settle();
  assert.equal(error.code, 'session_expired', 'the mint itself still fails');
  assert.equal(env.bridge.state.signedIn, true, 'the new session is not the one that was refused');
  assert.equal(env.real.store.get('net-1').sessionId, 'sess-FROM-POPUP', 'and its stored session stays');
  assert.deepEqual(env.posts(), []);
  assert.equal(env.maker.connections[1].closed, 0);
});

test('a Guru mint the master refuses for the current session still ends it', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ error: { status: true, code: 401, message: 'Unauthorized' } }) });
  const env = await withStoredSession({ guru: guruWithGrants(['groups:read']), fetchImpl });
  ask(env, 'Groups', 'list-groups', {}, 1);
  await settle();
  await assert.rejects(env.made.guru[0].session.mintToken(), { code: 'session_expired' });
  await settle();
  assert.equal(env.bridge.state.signedIn, false);
  assert.equal(env.real.storage.getItem(SESSION_KEY), null, 'its stored session is cleared');
});

test('an expired session clears the stored one only while storage still holds it', async () => {
  const own = await withStoredSession();
  own.maker.connections[0].setState('failed', codedError('session_expired'));
  await settle();
  assert.equal(own.bridge.state.signedIn, false);
  assert.equal(own.real.storage.getItem(SESSION_KEY), null, 'ours: cleared');

  // Another tab signed in since, and this tab has not heard (no storage event yet).
  const other = await withStoredSession();
  other.real.otherTab.set({ userId: 'u1', networkId: 'net-1', sessionId: 'sess-REPLACED' });
  other.maker.connections[0].setState('failed', codedError('session_expired'));
  await settle();
  assert.equal(other.bridge.state.signedIn, false);
  assert.deepEqual(authPushes(other), [{ ...SIGNED_OUT, reason: 'session_expired' }]);
  assert.equal(other.real.store.get('net-1').sessionId, 'sess-REPLACED', 'theirs: left alone');
});

test('a redeemed session the master refuses is cleared from storage, which holds it', async () => {
  const real = realAuth();
  const env = await ready({
    auth: real.auth, sessionStore: real.store, maker: fakeMaker({ error: codedError('session_expired') }),
  });
  token(env);
  await settle();
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'session_expired' }]);
  assert.equal(real.storage.getItem(SESSION_KEY), null);
});

test('a sign-out that wins over a redeem does not clear what another tab stored meanwhile', async () => {
  const real = realAuth();
  const gate = deferred();
  const auth = {
    restore: (options) => real.auth.restore(options),
    signOut: () => real.auth.signOut(),
    redeem: async (...args) => {
      const redeemed = await real.auth.redeem(...args);
      await gate.promise;
      return redeemed;
    },
  };
  const env = await ready({ auth, sessionStore: real.store });
  token(env);
  await settle();
  assert.equal(real.store.get('net-1').sessionId, 'sess-FROM-POPUP', 'the redeem has stored the session');
  env.call(MSG.AUTH, { action: 'sign-out', requestId: 1 }); // clears storage
  await settle();
  // Another tab signs in while the redeem is still being answered: what is in storage is theirs.
  real.otherTab.set({ userId: 'u1', networkId: 'net-1', sessionId: 'sess-THEIRS' });
  gate.resolve(); // the redeem ends: the sign-out won, and the session it stored is not wanted
  await settle();
  assert.equal(env.bridge.state.signedIn, false);
  assert.equal(env.maker.sessions.length, 0, 'no master was opened');
  assert.equal(real.store.get('net-1').sessionId, 'sess-THEIRS', 'the stale redeem cleared nothing of theirs');
});

test('a refused session does not clear a record another tab wrote while it was connecting', async () => {
  const real = realAuth();
  const maker = fakeMaker({
    connect: async () => {
      real.otherTab.set({ userId: 'u1', networkId: 'net-1', sessionId: 'sess-THEIRS' });
      throw codedError('session_expired');
    },
  });
  const env = await ready({ auth: real.auth, sessionStore: real.store, maker });
  token(env);
  await settle();
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'session_expired' }]);
  assert.equal(real.store.get('net-1').sessionId, 'sess-THEIRS', 'theirs: left alone');
});

test('a stored session the master refuses at the hello is reported after api:ready', async () => {
  const auth = fakeAuth({ session: SESSION });
  const env = setup({ auth, maker: fakeMaker({ error: codedError('session_expired') }), config: { signInOrigins: SIGN_IN_ORIGINS } });
  bridges.push(env.bridge);
  env.hello();
  await settle();
  assert.deepEqual(env.names(), ['api:ready', MSG.TRIGGER], 'ready first, then why the user is signed out');
  assert.equal(env.posts()[0].data.message.host.signedIn, false);
  assert.deepEqual(env.posts()[1].data.message, { action: 'auth', data: { ...SIGNED_OUT, reason: 'session_expired' } });
  assert.equal(auth.signOutCalls, 1);
  assert.deepEqual(env.bridge.state.lastError, { code: 'session_expired', message: 'the session is no longer valid' });

  const unreachable = setup({ auth: fakeAuth({ session: SESSION }), maker: fakeMaker({ error: codedError('unavailable') }) });
  bridges.push(unreachable.bridge);
  unreachable.hello();
  await settle();
  assert.deepEqual(unreachable.names(), ['api:ready'], 'a master that cannot be reached is not a verdict on the session');
});

// ---------------------------------------------------------------------------
// A lost master is connected again; the browser's network
// ---------------------------------------------------------------------------

const unavailable = () => codedError('unavailable');

test('a lost master is connected again by itself, and the reconnect path runs', async (t) => {
  const granted = ['groups:read'];
  const maker = fakeMaker();
  maker.script = [{
    userId: 'u1', networkId: 'n2', user: { id: 'u1', name: 'Ada King' }, network: { id: 'n2', fullName: 'Other' },
  }];
  const guru = guruWithGrants(granted);
  const env = await ready({ guru, maker });
  ask(env, 'Groups', 'list-groups', {}, 1);
  ask(env, 'Groups', 'list-groups', {}, 2);
  await settle();
  assert.equal(guru.ops(LIST).length, 1);
  const master = maker.connections[0];
  env.posts().length = 0;
  granted.length = 0; // revoked while the link was down

  t.mock.timers.enable({ apis: ['setTimeout'] });
  master.setState('failed', unavailable());
  assert.deepEqual(connectionPushes(env), [{ state: 'reconnecting' }]);
  assert.deepEqual(env.bridge.state.lastError, { code: 'unavailable', message: 'the connection to Valu is unavailable' });
  t.mock.timers.tick(799); // the shortest the first delay can be is 0.8 s (1 s - 20 %)
  await settle();
  assert.equal(master.connects, 1, 'not before 0.8 s');
  t.mock.timers.tick(401); // the longest it can be is 1.2 s
  await settle();

  assert.equal(master.connects, 2, 'the host asked the master to connect again');
  assert.equal(maker.connections.length, 1, 'the same connection: it replaces its own instance');
  assert.deepEqual(connectionPushes(env), [{ state: 'reconnecting' }, { state: 'ready' }, { state: 'ready', reconnected: true }]);
  assert.deepEqual(authPushes(env), [{
    signedIn: true, user: { id: 'u1', name: 'Ada King' }, network: { id: 'n2', name: 'Other' },
  }], 'who the user is was refreshed, and the app was told');
  assert.equal(env.bridge.state.lastError, null);
  assert.equal(env.bridge.state.connection, 'ready');
  ask(env, 'Groups', 'list-groups', {}, 3);
  await settle();
  assert.equal(guru.ops(LIST).length, 2, 'the grants cache was dropped');
  assert.equal(replyTo(env, 3).message.error.message, 'consent_required');
  assert.equal(env.made.services.length, 1, 'the services stand');

  t.mock.timers.tick(200_000);
  await settle();
  assert.equal(master.connects, 2, 'and nothing more is tried');
});

test('retries back off and never stop while the user is signed in', async (t) => {
  const maker = fakeMaker();
  maker.script = Array(50).fill('fail');
  const env = await ready({ maker });
  const master = maker.connections[0];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  master.setState('failed', unavailable());
  for (let i = 0; i < 30; i += 1) {
    t.mock.timers.tick(36_000); // the longest a delay can be: 30 s + 20 %
    await settle();
  }
  assert.ok(master.connects >= 25, `${master.connects} connects: a retry each time the longest delay passed`);
  assert.equal(env.bridge.state.signedIn, true);
  assert.deepEqual(connectionPushes(env), [{ state: 'reconnecting' }], 'one push for all of it');
  assert.equal(env.auth.signOutCalls, 0);
});

test('a retry that finds the session refused signs the user out', async (t) => {
  const maker = fakeMaker();
  maker.script = ['fail', 'expire'];
  const env = await ready({ maker });
  const master = maker.connections[0];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  master.setState('failed', unavailable());
  t.mock.timers.tick(1200);
  await settle();
  t.mock.timers.tick(2400);
  await settle();
  assert.equal(master.connects, 3);
  assert.equal(env.bridge.state.signedIn, false);
  assert.equal(env.auth.signOutCalls, 1);
  assert.deepEqual(authPushes(env), [{ ...SIGNED_OUT, reason: 'session_expired' }]);
  t.mock.timers.tick(200_000);
  await settle();
  assert.equal(master.connects, 3, 'and that is the end of the retries');
});

test('a sign-out, an expiry and a stop each end the retries', async (t) => {
  for (const end of [
    (env) => env.call(MSG.AUTH, { action: 'sign-out', requestId: 1 }),
    (env) => env.bridge.stop(),
  ]) {
    const env = await ready();
    const master = env.maker.connections[0];
    t.mock.timers.enable({ apis: ['setTimeout'] });
    master.setState('failed', unavailable());
    await end(env);
    await settle();
    t.mock.timers.tick(200_000);
    await settle();
    assert.equal(master.connects, 1, 'nothing was retried');
    t.mock.timers.reset();
  }
});

test('retries wait while the browser is offline, and the online event ends the wait', async (t) => {
  const env = await ready();
  const master = env.maker.connections[0];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  env.host.navigator = { onLine: false };
  master.setState('failed', unavailable());
  assert.deepEqual(connectionPushes(env), [{ state: 'offline' }]);
  t.mock.timers.tick(200_000);
  await settle();
  assert.equal(master.connects, 1, 'no network: nothing is tried');

  env.host.navigator = { onLine: true };
  env.host.fire('online');
  await settle();
  assert.equal(master.connects, 2, 'tried at once, not after a backoff');
  assert.deepEqual(connectionPushes(env), [
    { state: 'offline' }, { state: 'reconnecting' }, { state: 'ready' }, { state: 'ready', reconnected: true },
  ]);
  assert.equal(env.bridge.state.connection, 'ready');
});

test('the browser going offline is pushed, and coming back pushes the current state', async () => {
  const env = await ready();
  env.host.navigator = { onLine: false };
  env.host.fire('offline');
  env.host.fire('offline');
  assert.deepEqual(connectionPushes(env), [{ state: 'offline' }], 'once, whatever the socket still believes');
  assert.equal(env.bridge.state.connection, 'offline');
  env.host.navigator = { onLine: true };
  env.host.fire('online');
  assert.deepEqual(connectionPushes(env), [{ state: 'offline' }, { state: 'ready' }]);
  env.host.fire('online');
  assert.equal(connectionPushes(env).length, 2, 'nothing changed');
});

test('a signed-out host says nothing about the network', async () => {
  const env = await ready({ auth: fakeAuth() });
  env.host.navigator = { onLine: false };
  env.host.fire('offline');
  env.host.fire('online');
  assert.deepEqual(env.posts(), []);
  assert.equal(env.bridge.state.connection, 'signed_out');
});

test('the host listens for online and offline while it runs, and not after it stops', async () => {
  const env = setup({ start: false });
  assert.equal(env.host.windowListeners.get('online')?.size ?? 0, 0);
  env.bridge.start();
  env.bridge.start();
  assert.equal(env.host.windowListeners.get('online').size, 1);
  assert.equal(env.host.windowListeners.get('offline').size, 1);
  await env.bridge.stop();
  assert.equal(env.host.windowListeners.get('online').size, 0);
  assert.equal(env.host.windowListeners.get('offline').size, 0);
  assert.doesNotThrow(() => env.host.fire('offline'));
});

// ---------------------------------------------------------------------------
// Carried from Task 10's review
// ---------------------------------------------------------------------------

test('subscriptions and services start clean after a sign-out and a new sign-in', async () => {
  const guruOne = guruWithGrants(['commerce:read']);
  const guruTwo = guruWithGrants(['commerce:read']);
  const gurus = [guruOne, guruTwo];
  const builtOver = [];
  const env = await ready({
    makeServices: (connection) => { builtOver.push(connection); return fakeServices(); },
    makeGuru: () => gurus.shift(),
  });

  intent(env, 'Commerce', 'subscribe-events', { events: ['order-updated'] }, 1);
  ask(env, 'Users', 'current', {}, 2);
  await settle();
  assert.equal(replyTo(env, 1).message.success, true);
  assert.equal(builtOver.length, 1);
  guruOne.frame(ORDER_FRAME);
  await settle();
  assert.equal(triggers(env).length, 1, 'subscribed: the event is pushed');

  env.call(MSG.AUTH, { action: 'sign-out', requestId: 3 });
  await settle();
  assert.equal(guruOne.closed, 1);
  token(env);
  await settle();
  assert.equal(env.bridge.state.signedIn, true);

  // The new session: its own services, over its own master.
  ask(env, 'Users', 'current', {}, 4);
  await settle();
  assert.equal(builtOver.length, 2, 'services are built again');
  assert.equal(builtOver[1], env.maker.connections[1], 'over the new master');
  assert.notEqual(builtOver[0], builtOver[1]);

  // And its own subscriptions: none until the app asks again.
  intent(env, 'Commerce', 'unsubscribe-events', {}, 5); // makes the new Guru client; nothing is subscribed
  await settle();
  assert.equal(replyTo(env, 5).message.success, true);
  env.posts().length = 0;
  const reads = guruTwo.ops(LIST).length;
  guruTwo.frame(ORDER_FRAME);
  await settle();
  assert.deepEqual(triggers(env), [], 'the old subscription did not survive');
  assert.equal(guruTwo.ops(LIST).length, reads, 'and nobody read the grants for nobody');

  intent(env, 'Commerce', 'subscribe-events', { events: ['order-updated'] }, 6);
  await settle();
  guruTwo.frame(ORDER_FRAME);
  await settle();
  assert.equal(triggers(env).length, 1, 'subscribed again');
});

test('a grants read that ends after a sign-out and a new sign-in does not clear the new session\'s subscriptions', async () => {
  const clock = { now: 1_000_000 };
  let slow = null;
  const old = guruWithGrants(['commerce:read'], {
    [LIST]: () => (slow ? slow.promise : { grants: [{ scope: 'commerce:read', appId: APP.address, revokedAt: null }] }),
  }, { keepListenersOnClose: true });
  const fresh = guruWithGrants(['commerce:read']);
  const gurus = [old, fresh];
  const env = await ready({ makeGuru: () => gurus.shift(), makeGrants: clockedGrants(clock) });

  intent(env, 'Commerce', 'subscribe-events', { events: ['order-updated'] }, 1);
  await settle();
  slow = deferred();
  clock.now += 61_000; // past the TTL: the next frame reads the grants, slowly
  old.frame(ORDER_FRAME);
  await settle();
  assert.equal(old.ops(LIST).length, 2, 'the frame is waiting on its grants read');

  // The user signs out and in again while it waits, and subscribes on the new session.
  env.call(MSG.AUTH, { action: 'sign-out', requestId: 2 });
  await settle();
  token(env);
  await settle();
  assert.equal(env.bridge.state.signedIn, true);
  intent(env, 'Commerce', 'subscribe-events', { events: ['order-updated'] }, 3);
  await settle();
  assert.equal(replyTo(env, 3).message.success, true);

  // The old read ends, and says the grant is gone.
  slow.resolve({ grants: [] });
  await settle();

  fresh.frame(ORDER_FRAME);
  await settle();
  assert.equal(triggers(env).length, 1, 'the new session\'s subscription survived the old session\'s read');
  assert.equal(old.ops('valuguru.commerce.cart.get').length, 0);
});

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

test('a stopped bridge closes the master and answers nothing more', async () => {
  const timersBefore = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const maker = fakeMaker();
  maker.keepHandlers = true;
  const env = await ready({ auth: fakeAuth(), maker });
  token(env);
  await settle();
  const master = maker.connections[0];
  await env.bridge.stop();
  assert.equal(master.closed, 1);

  const posted = env.posts().length;
  master.reconnected(INFO);
  master.setState('reconnecting');
  master.setState('failed', codedError('session_expired'));
  token(env);
  await settle();
  assert.equal(env.posts().length, posted, 'nothing is posted after stop');
  assert.equal(env.auth.redeemCalls.length, 1, 'and no token is redeemed');
  assert.equal(process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length, timersBefore);
});
