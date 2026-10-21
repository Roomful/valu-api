// ===========================================================================
// HostBridge — what the app asks once the host is ready (spec §4.5-§4.7,
// §4.11): `api:call` through the SDK's services, the Commerce data intents over
// Valu Guru, Commerce event pushes, the identity token, the consent flow, and
// the per-app in-flight cap.
//
// Every test runs on the fakes of `test/helpers/hostBridgeFakes.js` plus the
// three below: `fakeServices` (what `services.call` answers), `fakeGuru` (what a
// `valuguru.*` op answers, and the `commerce_event` frames it pushes) and
// `mintFetch`. The grants are the REAL `GrantsStore` over `fakeGuru`, so "the
// grant was written" is read off the Guru ops that carried it.
//
// The scopes the tests lean on: `Users.current` (users:read, basic),
// `Groups.list-groups` (groups:read) and `Groups.join-group` (groups:write,
// writes), both consent; `Cbac.create-policy` (cbac:write, forbidden);
// `Time.get-local-time` and `Http.get` (local channel);
// `ApplicationStorage.resource-delete` (basic, writes).
// ===========================================================================
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as Permissions from '../../src/host/Permissions.js';
import { GrantsStore } from '../../src/host/GrantsStore.js';
import { GuruClient, GuruError } from '../../src/host/GuruClient.js';
import { createValuServices } from '../../src/services/api.js';
import { defaultMakeGrants, defaultMakeGuru } from '../../src/host/HostBridge.js';
import { MSG, POPUP_MSG } from '../../src/host/protocol.js';
import {
  APP, APP_ORIGIN, HOST_ORIGIN, OTHER_ORIGIN, SESSION, codedError, deferred, fakeAuth, settle, setup,
} from '../helpers/hostBridgeFakes.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Every bridge a test starts, stopped afterwards: a pending consent holds a 10 minute timer. */
const bridges = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

/** `services.call(name, params)` answers `answer(name, params)` (default `{data:{}}`); every call is recorded. */
function fakeServices(answer = () => ({ data: {} })) {
  const services = {
    calls: [],
    /** The per-call options each call was given, in the same order as `calls`. */
    options: [],
    answer,
    call: async (name, params, options) => {
      services.calls.push({ name, params });
      services.options.push(options);
      return services.answer(name, params);
    },
  };
  return services;
}

/**
 * A Guru client: `request(op, params)` answers `handlers[op]` (a value, or a
 * function of the params); an op with no handler is refused. `frame(f)` is what
 * the server pushes. `close()` clears the listeners the way `GuruClient.close` does.
 */
function fakeGuru(handlers = {}, { keepListenersOnClose = false } = {}) {
  const guru = {
    handlers,
    requests: [],
    closed: 0,
    listeners: new Set(),
    async request(op, params, options) {
      guru.requests.push({ op, params, options });
      const handler = guru.handlers[op];
      if (handler === undefined) throw new GuruError('unknown_op', `no handler for ${op}`);
      return typeof handler === 'function' ? handler(params) : handler;
    },
    onCommerceEvent(listener) {
      guru.listeners.add(listener);
      return () => guru.listeners.delete(listener);
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

const LIST = 'valuguru.apps.grants.list';
const GRANT = 'valuguru.apps.grants.grant';

/** A Guru whose grants table holds `granted` for this app; `granted` is the live list (a grant adds to it). */
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

/** A `fetch` for `POST …/auth/getOneTimeAuthToken`. */
function mintFetch({ token = 'ott-1', body, status = 200 } = {}) {
  const impl = async (url, init) => {
    impl.calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body ?? { data: { token }, error: { status: false, code: 200, message: '' } },
    };
  };
  impl.calls = [];
  return impl;
}

/**
 * A started bridge, with a signed-in session unless `session: null`, the
 * fake services and the fake Guru, and the handshake finished.
 */
async function ready({
  session = SESSION, services = fakeServices(), guru = guruWithGrants(), open = true, ...options
} = {}) {
  const made = { services: [], guru: [] };
  const env = setup({
    auth: fakeAuth({ session }),
    makeServices: (connection, app) => { made.services.push({ connection, app }); return services; },
    makeGuru: (sessionArg, app) => { made.guru.push({ session: sessionArg, app }); return guru; },
    ...options,
  });
  bridges.push(env.bridge);
  if (open) await env.open();
  return { ...env, services, guru, made };
}

const ask = (env, service, action, params, requestId = 1) => env.call(MSG.CALL, { service, action, params, requestId });
const intent = (env, applicationId, action, params, requestId = 1) => env.call(
  MSG.SERVICE_INTENT, { applicationId, action, params, requestId },
);
const replyTo = (env, requestId, name) => env.posts().map((p) => p.data)
  .find((data) => data.requestId === requestId && (!name || data.name === name));

/** The consent page's decision, as the host iframe hears it: from the host origin, from a window that is not the parent. */
const decide = (env, message, { origin = HOST_ORIGIN, source = { popup: true } } = {}) => env.host.dispatch({
  data: { type: POPUP_MSG.CONSENT, ...message }, origin, source,
});

/** Let the bridge's asynchronous steps run until `done()`, a bounded number of turns (no clock involved). */
const until = async (done, turns = 50) => {
  for (let i = 0; i < turns && !done(); i += 1) await settle();
};
const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;

// ---------------------------------------------------------------------------
// api:call
// ---------------------------------------------------------------------------

test('api:call Users.current runs through the services and returns the ack', async () => {
  const services = fakeServices(() => ({ data: { id: 'u1', name: 'Ada Lovelace' } }));
  const env = await ready({ services });
  ask(env, 'Users', 'current', {}, 7);
  await settle();

  assert.deepEqual(services.calls, [{ name: 'Users.current', params: {} }]);
  assert.equal(env.posts().length, 1);
  const { data, targetOrigin } = env.last();
  assert.equal(targetOrigin, APP_ORIGIN);
  assert.equal(data.name, MSG.CALL_COMPLETED);
  assert.equal(data.requestId, 7, 'the reply carries the request id');
  assert.deepEqual(data.message, { data: { id: 'u1', name: 'Ada Lovelace' } }, 'the ack, unchanged');
  assert.equal(env.made.services.length, 1);
  assert.equal(env.made.services[0].connection, env.maker.connections[0], 'the services run over the session master connection');
  assert.deepEqual(env.made.services[0].app, APP);
  assert.equal(env.made.guru.length, 0, 'a basic call never touches Valu Guru');
});

test('the host asks the services once: no retries of its own, the client\'s timeoutMs capped at the host\'s', async () => {
  const env = await ready({ config: { callTimeoutMs: 20_000 } });
  const send = (extra, requestId) => env.call(MSG.CALL, {
    service: 'Users', action: 'current', params: {}, requestId, ...extra,
  });
  send({ timeoutMs: 5000 }, 1);
  send({}, 2);
  send({ timeoutMs: 1e12 }, 3);
  send({ timeoutMs: -5 }, 4);
  send({ timeoutMs: 0 }, 5);
  send({ timeoutMs: '5000' }, 6);
  send({ timeoutMs: null }, 7);
  send({ timeoutMs: Number.POSITIVE_INFINITY }, 8);
  send({ timeoutMs: 20_000 }, 9);
  await settle();
  assert.deepEqual(env.services.options, [
    { retries: 0, timeoutMs: 5000 },
    { retries: 0, timeoutMs: 20_000 },
    { retries: 0, timeoutMs: 20_000 },
    { retries: 0, timeoutMs: 20_000 },
    { retries: 0, timeoutMs: 20_000 },
    { retries: 0, timeoutMs: 20_000 },
    { retries: 0, timeoutMs: 20_000 },
    { retries: 0, timeoutMs: 20_000 },
    { retries: 0, timeoutMs: 20_000 },
  ]);
});

test('a read the master answers 503 is passed through after one attempt on the wire: the retries are the client\'s', async () => {
  const emits = [];
  const env = setup({
    auth: fakeAuth({ session: SESSION }),
    makeServices: (connection, app) => createValuServices({ socket: connection.socket, applicationId: app.slug, cache: null }),
  });
  bridges.push(env.bridge);
  await env.open();
  // What the services read of an authenticated socket, and an RPC that answers 503 as a drop does.
  Object.assign(env.maker.connections[0].socket, {
    userId: 'u1',
    selfUserId: 'u1',
    networkId: 'n1',
    emit: async (ns) => {
      emits.push(ns);
      return { error: { status: true, code: 503, message: 'disconnected (a drop)' } };
    },
  });

  const started = Date.now();
  ask(env, 'Users', 'list-connection-requests', {}, 1); // a read: the default policy would try it three times
  await settle();
  assert.equal(emits.length, 1, 'one wire attempt, not the default policy\'s three');
  assert.equal(replyTo(env, 1).message.error.code, 503, 'the ack is passed through for the client to retry');
  assert.ok(Date.now() - started < 200, 'and the host slept no backoff of its own');
});

test('api:call answers an ack error unchanged, and passes a missing params as {}', async () => {
  const services = fakeServices(() => ({ error: { status: true, code: 500, message: 'boom', description: 'd' } }));
  const env = await ready({ services });
  ask(env, 'Users', 'current', undefined, 2);
  await settle();
  assert.deepEqual(env.last().data.message, { error: { status: true, code: 500, message: 'boom', description: 'd' } });
  assert.deepEqual(services.calls[0].params, {});
});

test('the services are built once for the session, however many calls', async () => {
  const env = await ready();
  for (let i = 1; i <= 3; i += 1) ask(env, 'Users', 'current', {}, i);
  await settle();
  assert.equal(env.made.services.length, 1);
  assert.equal(env.services.calls.length, 3);
});

test('api:call unknown function answers 404', async () => {
  const env = await ready();
  ask(env, 'Users', 'delete-everything', {}, 1);
  ask(env, 'Nope', 'current', {}, 2);
  ask(env, undefined, undefined, {}, 3);
  ask(env, { toString: () => 'Users' }, ['current'], {}, 4);
  ask(env, 'Users.current', '', {}, 5);
  await settle();

  for (const id of [1, 2, 3, 4, 5]) {
    assert.deepEqual(replyTo(env, id).message, { error: { status: true, code: 404, message: 'unknown_function' } }, `request ${id}`);
    assert.equal(replyTo(env, id).name, MSG.CALL_COMPLETED);
  }
  assert.deepEqual(env.services.calls, []);
});

test('api:call while signed out answers 401 sign_in_required, and never builds the services', async () => {
  const env = await ready({ session: null });
  ask(env, 'Users', 'current', {}, 1);
  ask(env, 'Groups', 'list-groups', {}, 2);
  ask(env, 'Cbac', 'create-policy', {}, 3);
  ask(env, 'Users', 'nope', {}, 4);
  await settle();

  for (const id of [1, 2, 3]) {
    assert.deepEqual(replyTo(env, id).message, { error: { status: true, code: 401, message: 'sign_in_required' } }, `request ${id}`);
  }
  assert.equal(replyTo(env, 4).message.error.code, 404, 'a function that does not exist is 404 whoever asks');
  assert.deepEqual(env.services.calls, []);
  assert.equal(env.made.services.length, 0);
  assert.equal(env.made.guru.length, 0);
});

test('api:call with params that do not match the descriptor answers its 400 and runs nothing', async () => {
  const env = await ready();
  ask(env, 'Users', 'current', { surprise: 1 }, 1);
  ask(env, 'Groups', 'join-group', {}, 2);
  ask(env, 'Users', 'current', null, 3);
  ask(env, 'Users', 'find-user', { query: 5 }, 4);
  await settle();

  for (const id of [1, 2, 3, 4]) {
    const { error } = replyTo(env, id).message;
    assert.equal(error.status, true, `request ${id}`);
    assert.equal(error.code, 400, `request ${id}`);
    assert.match(error.message, /^(Users\.current|Groups\.join-group|Users\.find-user):/);
  }
  assert.deepEqual(env.services.calls, []);
  assert.deepEqual(env.guru.requests, [], 'a malformed call does not even ask for the grant');
});

test('a local-channel function answers 501 not_available, even with a basic scope and before its params are checked', async () => {
  const env = await ready();
  ask(env, 'Time', 'get-local-time', {}, 1);
  ask(env, 'Http', 'get', {}, 2); // no url: still 501, not 400
  ask(env, 'Http', 'post', { url: 'https://example.com' }, 3);
  ask(env, 'Resources', 'generate-public-url', {}, 4);
  await settle();

  for (const id of [1, 2, 3, 4]) {
    assert.deepEqual(replyTo(env, id).message, { error: { status: true, code: 501, message: 'not_available' } }, `request ${id}`);
  }
  assert.deepEqual(env.services.calls, []);
  assert.deepEqual(env.guru.requests, []);
});

test('consent-tier call without grant answers consent_required with the scope', async () => {
  const env = await ready({ guru: guruWithGrants(['rooms:read']) });
  ask(env, 'Groups', 'list-groups', {}, 1);
  await settle();

  assert.deepEqual(env.last().data.message, {
    error: { status: true, code: 403, message: 'consent_required', scope: 'groups:read' },
  });
  assert.deepEqual(env.services.calls, [], 'nothing ran');
  assert.equal(env.guru.ops(LIST).length, 1);
  assert.deepEqual(env.guru.ops(LIST)[0].params, { appId: 'ws_1/demo' }, 'the grants are for the canonical address, from the binding');
  assert.equal(env.made.guru.length, 1);
  assert.deepEqual(Object.keys(env.made.guru[0].session).sort(), ['getNetworkId', 'mintToken']);
  assert.deepEqual(env.made.guru[0].app, APP);
});

test('a granted consent-tier scope runs, and the grants are read once for the next minute', async () => {
  const env = await ready({ guru: guruWithGrants(['groups:read']) });
  ask(env, 'Groups', 'list-groups', {}, 1);
  ask(env, 'Groups', 'list-groups', { query: 'x' }, 2);
  await settle();

  assert.deepEqual(env.services.calls.map((c) => c.name), ['Groups.list-groups', 'Groups.list-groups']);
  assert.equal(env.last().data.message.data !== undefined, true);
  assert.equal(env.guru.ops(LIST).length, 1, 'cached');
});

test('forbidden scope answers 403 without consulting grants', async () => {
  const env = await ready();
  ask(env, 'Cbac', 'create-policy', {
    networkId: 'n', targetType: 't', targetId: 'i', badgeIds: [], badgeMatchMode: 'any', grantedPermission: 'x',
  }, 1);
  ask(env, 'Developer', 'list-applications', {}, 2);
  ask(env, 'VerusWallet', 'transfer', { agentId: 'a', destination: 'd', amount: 1 }, 3);
  await settle();

  for (const id of [1, 2, 3]) {
    assert.deepEqual(replyTo(env, id).message, { error: { status: true, code: 403, message: 'forbidden' } }, `request ${id}`);
  }
  assert.deepEqual(env.guru.requests, [], 'grants never consulted');
  assert.equal(env.made.guru.length, 0, 'no Guru client made for it');
  assert.deepEqual(env.services.calls, []);
});

test('a grants read that fails answers 503 unavailable, is not cached, and the next call can succeed', async () => {
  let failing = true;
  const guru = guruWithGrants(['groups:read'], {
    [LIST]: () => {
      if (failing) throw new GuruError('disconnected', 'the Valu Guru socket dropped');
      return { grants: [{ scope: 'groups:read', appId: APP.address, revokedAt: null }] };
    },
  });
  const env = await ready({ guru });
  ask(env, 'Groups', 'list-groups', {}, 1);
  await settle();
  assert.deepEqual(env.last().data.message, { error: { status: true, code: 503, message: 'unavailable' } });
  assert.deepEqual(env.services.calls, []);

  failing = false;
  ask(env, 'Groups', 'list-groups', {}, 2);
  await settle();
  assert.equal(replyTo(env, 2).message.error, undefined);
  assert.equal(env.services.calls.length, 1);
});

test('a call whose grants read is still running when the user signs out answers 401 and runs nothing', async () => {
  const read = deferred();
  const guru = guruWithGrants([], { [LIST]: () => read.promise });
  const env = await ready({ guru });
  ask(env, 'Groups', 'list-groups', {}, 1);
  await settle();
  env.call(MSG.AUTH, { action: 'sign-out', requestId: 2 });
  await settle();
  read.resolve({ grants: [{ scope: 'groups:read', appId: APP.address, revokedAt: null }] });
  await settle();

  assert.deepEqual(replyTo(env, 1).message, { error: { status: true, code: 401, message: 'sign_in_required' } });
  assert.deepEqual(env.services.calls, [], 'the grant was read for a session that is gone');
});

test('a write that was on the wire when the master dropped answers 503 with retryable:false; a read does not', async () => {
  const disconnected = { error: { status: true, code: 503, message: 'emit appStorage:delete: disconnected (transport close)' } };
  const services = fakeServices(() => disconnected);
  const env = await ready({ services });
  ask(env, 'ApplicationStorage', 'resource-delete', { resourceId: 'r1' }, 1);
  ask(env, 'Users', 'current', {}, 2);
  await settle();

  assert.deepEqual(replyTo(env, 1).message, {
    error: { status: true, code: 503, message: disconnected.error.message, retryable: false },
  });
  assert.deepEqual(replyTo(env, 2).message, disconnected, 'a read is answered as it came: it may be repeated');
  assert.deepEqual(disconnected, { error: { status: true, code: 503, message: 'emit appStorage:delete: disconnected (transport close)' } }, 'the ack itself is not mutated');
});

test('a write that runs out of time says so: the host timeout and the SDK\'s own 408 carry retryable:false, a read\'s do not', async (t) => {
  const never = deferred();
  const sdkTimeout = { error: { status: true, code: 408, message: 'timeout' } };
  const services = fakeServices((name, params) => {
    if (name === 'Users.current') return never.promise;
    if (name === 'ApplicationStorage.resource-delete' && params.resourceId === 'hang') return never.promise;
    return sdkTimeout;
  });
  const env = await ready({ services });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  ask(env, 'ApplicationStorage', 'resource-delete', { resourceId: 'hang' }, 1); // handed to the services, never answers
  ask(env, 'Users', 'current', {}, 2); // a read that never answers
  ask(env, 'ApplicationStorage', 'resource-delete', { resourceId: 'sdk' }, 3); // the SDK's own 408 for a write
  ask(env, 'Users', 'find-user', {}, 4); // the SDK's own 408 for a read
  await settle();
  t.mock.timers.tick(30_000);
  await settle();

  assert.deepEqual(replyTo(env, 1).message, { error: { status: true, code: 408, message: 'timeout', retryable: false } });
  assert.deepEqual(replyTo(env, 2).message, { error: { status: true, code: 408, message: 'timeout' } });
  assert.deepEqual(replyTo(env, 3).message, { error: { status: true, code: 408, message: 'timeout', retryable: false } });
  assert.deepEqual(replyTo(env, 4).message, sdkTimeout);
  assert.deepEqual(sdkTimeout, { error: { status: true, code: 408, message: 'timeout' } }, 'the ack itself is not mutated');
});

test('a request that timed out before it started never starts: a write waiting on the grants is a plain 408 and is never sent afterwards', async (t) => {
  const slowRead = deferred();
  const guru = guruWithGrants([], {
    [LIST]: () => slowRead.promise,
    'valuguru.commerce.cart.add': { items: [] },
  });
  const env = await ready({ guru });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  ask(env, 'Groups', 'join-group', { groupId: 'g1' }, 1); // consent tier: waits on the grants read
  intent(env, 'Commerce', 'add-to-cart', { productId: 'p1' }, 2); // the same, as an intent
  await settle();
  t.mock.timers.tick(30_000);
  await settle();
  assert.deepEqual(replyTo(env, 1).message, { error: { status: true, code: 408, message: 'timeout' } }, 'not yet handed to the services: no retryable');
  assert.equal(replyTo(env, 2).message.code, 'timeout');

  // The grants arrive late. The app was told both timed out, and may repeat them:
  // neither may be started now.
  slowRead.resolve({ grants: [{ scope: 'groups:write', appId: APP.address, revokedAt: null }, { scope: 'commerce:write', appId: APP.address, revokedAt: null }] });
  await settle();
  assert.deepEqual(env.services.calls, []);
  assert.deepEqual(guru.ops('valuguru.commerce.cart.add'), []);
  assert.equal(env.posts().length, 2, 'and nothing more was said');
});

test('retryable:false is only for a write that was cut off: other write errors pass as they are', async () => {
  const services = fakeServices(() => ({ error: { status: true, code: 500, message: 'server said no' } }));
  const env = await ready({ services });
  ask(env, 'ApplicationStorage', 'resource-delete', { resourceId: 'r1' }, 1);
  await settle();
  assert.deepEqual(env.last().data.message, { error: { status: true, code: 500, message: 'server said no' } });
});

test('a call that takes longer than callTimeoutMs answers 408 timeout once; the late result is dropped and the slot is free', async (t) => {
  const slow = deferred();
  const services = fakeServices((name) => (name === 'Users.current' ? slow.promise : { data: { ok: true } }));
  const env = await ready({ services, config: { maxInFlight: 1 } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  ask(env, 'Users', 'current', {}, 1);
  await settle();
  t.mock.timers.tick(29_999);
  await settle();
  assert.deepEqual(env.posts(), [], 'nothing yet: the default callTimeoutMs is 30 s');

  t.mock.timers.tick(1);
  await settle();
  assert.equal(env.posts().length, 1);
  assert.deepEqual(env.last().data.message, { error: { status: true, code: 408, message: 'timeout' } });
  assert.equal(env.last().data.requestId, 1);

  slow.resolve({ data: { late: true } });
  await settle();
  assert.equal(env.posts().length, 1, 'the late result is dropped');

  ask(env, 'Users', 'find-user', {}, 2);
  await settle();
  assert.deepEqual(env.last().data.message, { data: { ok: true } }, 'the one slot was released when the timeout answered');
});

test('a services.call that throws answers 500 internal, frees its slot, and logs without the message', async () => {
  let throwNow = true;
  const services = fakeServices(() => {
    if (throwNow) throw new Error('secret detail sess-SECRET-1');
    return { data: {} };
  });
  const env = await ready({ services, config: { maxInFlight: 1 } });
  ask(env, 'Users', 'current', {}, 1);
  await settle();
  assert.deepEqual(env.last().data.message, { error: { status: true, code: 500, message: 'internal' } });
  assert.ok(env.logs.length >= 1);
  assert.ok(env.logs.every((entry) => !entry.message.includes('sess-SECRET-1')));

  throwNow = false;
  ask(env, 'Users', 'current', {}, 2);
  await settle();
  assert.deepEqual(env.last().data.message, { data: {} });
});

test('the app can only ask for what it names: params cannot choose another application id', async () => {
  const env = await ready();
  ask(env, 'Users', 'current', { applicationId: 'someone-else' }, 1);
  await settle();
  assert.equal(replyTo(env, 1).message.error.code, 400, 'an unknown param is refused, not forwarded');
  assert.deepEqual(env.services.calls, []);
});

// ---------------------------------------------------------------------------
// The in-flight cap
// ---------------------------------------------------------------------------

test('17th concurrent call answers busy', async () => {
  const pending = [];
  const services = fakeServices(() => { const d = deferred(); pending.push(d); return d.promise; });
  const env = await ready({ services });

  for (let id = 1; id <= 16; id += 1) ask(env, 'Users', 'current', {}, id);
  await settle();
  assert.equal(pending.length, 16, 'sixteen are running');
  assert.deepEqual(env.posts(), []);

  ask(env, 'Users', 'current', {}, 17);
  await settle();
  assert.equal(env.posts().length, 1, 'answered at once, while the sixteen are still running');
  assert.equal(env.last().data.requestId, 17);
  assert.deepEqual(env.last().data.message, { error: { status: true, code: 429, message: 'busy' } });
  assert.equal(pending.length, 16, 'the 17th never reached the services');

  pending[0].resolve({ data: 'one' });
  await settle();
  assert.equal(env.last().data.requestId, 1);
  ask(env, 'Users', 'current', {}, 18);
  await settle();
  assert.equal(pending.length, 17, 'a finished call frees a slot');

  for (const d of pending.slice(1)) d.resolve({ data: 'rest' });
  await settle();
  assert.equal(env.posts().filter((p) => p.data.message.data).length, 17);
});

test('calls and intents share the cap, and a busy intent answers {success:false, code:busy}', async () => {
  const holds = [];
  const services = fakeServices(() => { const d = deferred(); holds.push(d); return d.promise; });
  const guru = guruWithGrants(['commerce:read'], {
    'valuguru.commerce.catalog.search': () => { const d = deferred(); holds.push(d); return d.promise; },
  });
  const env = await ready({ services, guru, config: { maxInFlight: 4 } });

  ask(env, 'Users', 'current', {}, 1);
  ask(env, 'Users', 'current', {}, 2);
  intent(env, 'Commerce', 'list-products', {}, 3);
  intent(env, 'Commerce', 'list-products', {}, 4);
  await settle();
  assert.equal(holds.length, 4);

  intent(env, 'Commerce', 'list-products', {}, 5);
  ask(env, 'Users', 'current', {}, 6);
  await settle();
  const busyIntent = replyTo(env, 5, MSG.RUN_CONSOLE_COMPLETED);
  assert.equal(busyIntent.message.success, false);
  assert.equal(busyIntent.message.code, 'busy');
  assert.equal(typeof busyIntent.message.error, 'string');
  assert.deepEqual(replyTo(env, 6, MSG.CALL_COMPLETED).message, { error: { status: true, code: 429, message: 'busy' } });
  assert.equal(holds.length, 4, 'neither reached its backend');
});

test('maxInFlight is read from the config', async () => {
  const pending = [];
  const services = fakeServices(() => { const d = deferred(); pending.push(d); return d.promise; });
  const env = await ready({ services, config: { maxInFlight: 2 } });
  for (let id = 1; id <= 3; id += 1) ask(env, 'Users', 'current', {}, id);
  await settle();
  assert.equal(pending.length, 2);
  assert.equal(replyTo(env, 3).message.error.code, 429);
  for (const d of pending) d.resolve({ data: 1 });
  await settle();
});

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

test('consent approved from the host origin writes the grant and the retried call succeeds', async () => {
  const granted = [];
  const services = fakeServices(() => ({ data: { groups: [] } }));
  const env = await ready({ services, guru: guruWithGrants(granted) });

  ask(env, 'Groups', 'list-groups', {}, 1);
  await settle();
  assert.equal(replyTo(env, 1).message.error.message, 'consent_required');

  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'nonce-1', requestId: 2 });
  await settle();
  assert.deepEqual(env.bridge.pendingConsent('nonce-1'), {
    nonce: 'nonce-1', app: { name: 'Demo', address: 'ws_1/demo' }, scopes: ['groups:read'],
  });
  assert.equal(replyTo(env, 2), undefined, 'the app waits for the popup');

  decide(env, { nonce: 'nonce-1', approved: true, scopes: ['groups:read'] });
  await settle();

  assert.deepEqual(env.guru.ops(GRANT).map((r) => r.params), [{ appId: 'ws_1/demo', scopes: ['groups:read'] }]);
  assert.deepEqual(replyTo(env, 2).message, { approved: true });
  assert.equal(replyTo(env, 2).name, MSG.CONSENT_COMPLETED);
  assert.equal(env.bridge.pendingConsent('nonce-1'), null, 'the request is settled');

  ask(env, 'Groups', 'list-groups', {}, 3);
  await settle();
  assert.deepEqual(replyTo(env, 3).message, { data: { groups: [] } }, 'the retried call succeeds');
  assert.equal(env.guru.ops(LIST).length, 1, 'the grant went into the cache: no second read');
});

test('an approval whose grant write is still running when the user signs out is not approved', async () => {
  const write = deferred();
  const guru = guruWithGrants([], { [GRANT]: () => write.promise });
  const env = await ready({ guru });
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n', requestId: 1 });
  await settle();
  decide(env, { nonce: 'n', approved: true, scopes: ['groups:read'] });
  await settle();
  env.call(MSG.AUTH, { action: 'sign-out', requestId: 2 });
  await settle();
  write.resolve({});
  await settle();
  assert.deepEqual(replyTo(env, 1, MSG.CONSENT_COMPLETED).message, { approved: false, reason: 'sign_in_required' });
  assert.equal(env.posts().filter((p) => p.data.name === MSG.CONSENT_COMPLETED).length, 1, 'answered once');
});

test('a declined consent writes nothing and answers approved:false', async () => {
  const env = await ready();
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n', requestId: 1 });
  await settle();
  decide(env, { nonce: 'n', approved: false, scopes: ['groups:read'] });
  await settle();
  assert.deepEqual(replyTo(env, 1).message, { approved: false });
  assert.deepEqual(env.guru.ops(GRANT), []);
  assert.equal(env.bridge.pendingConsent('n'), null);
});

test('only approved:true is approval: a truthy approved that is not true declines', async () => {
  const env = await ready();
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n', requestId: 1 });
  await settle();
  decide(env, { nonce: 'n', approved: 'yes', scopes: ['groups:read'] });
  await settle();
  assert.deepEqual(replyTo(env, 1).message, { approved: false });
  assert.deepEqual(env.guru.ops(GRANT), []);
});

test('consent message from the app origin is ignored', async () => {
  const env = await ready();
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n', requestId: 1 });
  await settle();
  const before = env.posts().length;

  // The app page, which is the host's parent, forging the popup's message.
  decide(env, { nonce: 'n', approved: true, scopes: ['groups:read'] }, { origin: APP_ORIGIN, source: env.app });
  // The app origin from some other window (an iframe the app made).
  decide(env, { nonce: 'n', approved: true, scopes: ['groups:read'] }, { origin: APP_ORIGIN, source: { other: true } });
  // Another origin entirely.
  decide(env, { nonce: 'n', approved: true, scopes: ['groups:read'] }, { origin: OTHER_ORIGIN });
  // The host origin, but sent by the parent window itself.
  decide(env, { nonce: 'n', approved: true, scopes: ['groups:read'] }, { origin: HOST_ORIGIN, source: env.app });
  // An opaque origin, and no origin at all.
  decide(env, { nonce: 'n', approved: true, scopes: ['groups:read'] }, { origin: 'null' });
  decide(env, { nonce: 'n', approved: true, scopes: ['groups:read'] }, { origin: null });
  await settle();

  assert.equal(env.posts().length, before, 'nothing was answered');
  assert.deepEqual(env.guru.ops(GRANT), [], 'nothing was granted');
  assert.notEqual(env.bridge.pendingConsent('n'), null, 'the request is still waiting for the real popup');
});

test('a host with no hostOrigin configured accepts no consent decision, not even one with no origin', async () => {
  const env = await ready({ config: { hostOrigin: null } });
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n', requestId: 1 });
  await settle();
  for (const origin of [null, undefined, 'null', HOST_ORIGIN, APP_ORIGIN]) {
    env.host.dispatch({ data: { type: POPUP_MSG.CONSENT, nonce: 'n', approved: true, scopes: ['groups:read'] }, origin, source: { popup: true } });
  }
  await settle();
  assert.deepEqual(env.guru.ops(GRANT), []);
  assert.notEqual(env.bridge.pendingConsent('n'), null);
});

test('a consent decision for a nonce that is not pending is ignored, and so is a second one for the same nonce', async () => {
  const env = await ready();
  decide(env, { nonce: 'nobody', approved: true, scopes: ['groups:read'] });
  await settle();
  assert.deepEqual(env.guru.requests, []);
  assert.deepEqual(env.posts(), []);

  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n', requestId: 1 });
  await settle();
  decide(env, { nonce: 'n', approved: true, scopes: ['groups:read'] });
  decide(env, { nonce: 'n', approved: true, scopes: ['groups:read'] });
  await settle();
  assert.equal(env.guru.ops(GRANT).length, 1, 'one request, one decision');
  assert.equal(env.posts().filter((p) => p.data.name === MSG.CONSENT_COMPLETED).length, 1);
});

test('hostile consent decisions never throw out of the listener, and scopes that are not a list grant nothing', async () => {
  const env = await ready();
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n', requestId: 1 });
  await settle();
  for (const data of [
    { type: POPUP_MSG.CONSENT }, { type: POPUP_MSG.CONSENT, nonce: { x: 1 } },
    { type: POPUP_MSG.CONSENT, nonce: '__proto__' }, { type: POPUP_MSG.CONSENT, nonce: 'toString' }, null, 5, 'valu-host:consent',
  ]) {
    env.host.dispatch({ data, origin: HOST_ORIGIN, source: { popup: true } });
  }
  await settle();
  assert.notEqual(env.bridge.pendingConsent('n'), null, 'none of that touched the pending request');

  decide(env, { nonce: 'n', approved: true, scopes: 'groups:read' });
  await settle();
  assert.deepEqual(env.guru.ops(GRANT), []);
  assert.deepEqual(replyTo(env, 1).message, { approved: false });
  assert.deepEqual(env.logs, []);
});

test('the decision can narrow what is granted but never widen it beyond what the app asked', async () => {
  const granted = [];
  const env = await ready({ guru: guruWithGrants(granted) });
  env.call(MSG.CONSENT, { scopes: ['groups:read', 'rooms:read'], nonce: 'n', requestId: 1 });
  await settle();
  decide(env, { nonce: 'n', approved: true, scopes: ['groups:read', 'veruswallet:write', 'rooms:write'] });
  await settle();
  assert.deepEqual(env.guru.ops(GRANT).map((r) => r.params.scopes), [['groups:read']]);
  assert.deepEqual(replyTo(env, 1).message, { approved: true });
});

test('an approval that names none of the requested scopes grants nothing and declines', async () => {
  const env = await ready();
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n', requestId: 1 });
  await settle();
  decide(env, { nonce: 'n', approved: true, scopes: [] });
  await settle();
  assert.deepEqual(env.guru.ops(GRANT), []);
  assert.deepEqual(replyTo(env, 1).message, { approved: false });
});

test('an approval whose grant cannot be written answers approved:false, reason unavailable, and keeps nothing', async () => {
  const guru = guruWithGrants([], { [GRANT]: () => { throw new GuruError('disconnected', 'dropped'); } });
  const env = await ready({ guru });
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n', requestId: 1 });
  await settle();
  decide(env, { nonce: 'n', approved: true, scopes: ['groups:read'] });
  await settle();
  assert.deepEqual(replyTo(env, 1).message, { approved: false, reason: 'unavailable' });
  assert.equal(env.bridge.pendingConsent('n'), null);
  ask(env, 'Groups', 'list-groups', {}, 2);
  await settle();
  assert.equal(replyTo(env, 2).message.error.message, 'consent_required', 'still not granted');
});

test('a consent request is refused when it asks for scopes that are not the user to give', async () => {
  const env = await ready();
  const bad = [
    ['not a list', 'groups:read'],
    ['empty', []],
    ['forbidden scope', ['veruswallet:write']],
    ['basic scope', ['users:read']],
    ['local scope', ['http:read']],
    ['unknown scope', ['nonsense:scope']],
    ['mixed', ['groups:read', 'cbac:write']],
    ['non-string', ['groups:read', 7]],
    ['too many', Array.from({ length: 1000 }, () => 'groups:read')],
  ];
  bad.forEach(([, scopes], index) => env.call(MSG.CONSENT, { scopes, nonce: `n${index}`, requestId: index + 1 }));
  await settle();
  bad.forEach(([label], index) => {
    assert.deepEqual(replyTo(env, index + 1, MSG.CONSENT_COMPLETED).message, { approved: false, reason: 'invalid_request' }, label);
    assert.equal(env.bridge.pendingConsent(`n${index}`), null, label);
  });
});

test('a consent request needs a nonce, and a nonce can be pending only once', async () => {
  const env = await ready();
  env.call(MSG.CONSENT, { scopes: ['groups:read'], requestId: 1 });
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: '', requestId: 2 });
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 5, requestId: 3 });
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'x'.repeat(500), requestId: 4 });
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'dup', requestId: 5 });
  env.call(MSG.CONSENT, { scopes: ['rooms:read'], nonce: 'dup', requestId: 6 });
  await settle();
  for (const id of [1, 2, 3, 4, 6]) assert.deepEqual(replyTo(env, id).message, { approved: false, reason: 'invalid_request' }, `request ${id}`);
  assert.equal(replyTo(env, 5), undefined);
  assert.deepEqual(env.bridge.pendingConsent('dup').scopes, ['groups:read'], 'the second request did not rewrite the first');
});

test('consent while signed out answers approved:false, reason sign_in_required', async () => {
  const env = await ready({ session: null });
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n', requestId: 1 });
  await settle();
  assert.deepEqual(replyTo(env, 1).message, { approved: false, reason: 'sign_in_required' });
  assert.equal(env.bridge.pendingConsent('n'), null);
});

test('no more consent requests are pending than the in-flight cap', async () => {
  const env = await ready({ config: { maxInFlight: 2 } });
  for (let i = 1; i <= 3; i += 1) env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: `n${i}`, requestId: i });
  await settle();
  assert.deepEqual(replyTo(env, 3).message, { approved: false, reason: 'busy' });
  assert.notEqual(env.bridge.pendingConsent('n2'), null);
  assert.equal(env.bridge.pendingConsent('n3'), null);
});

test('a pending consent expires after ten minutes: approved:false, reason timeout', async (t) => {
  const env = await ready();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n', requestId: 1 });
  await settle();
  t.mock.timers.tick(599_999);
  await settle();
  assert.notEqual(env.bridge.pendingConsent('n'), null);
  assert.equal(replyTo(env, 1), undefined);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(replyTo(env, 1).message, { approved: false, reason: 'timeout' });
  assert.equal(env.bridge.pendingConsent('n'), null);

  decide(env, { nonce: 'n', approved: true, scopes: ['groups:read'] });
  await settle();
  assert.deepEqual(env.guru.ops(GRANT), [], 'a late approval is ignored');
});

test('a consent that is decided leaves no expiry timer behind', async () => {
  const before = timers();
  const env = await ready();
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n', requestId: 1 });
  await settle();
  decide(env, { nonce: 'n', approved: false });
  await settle();
  await env.bridge.stop();
  assert.equal(timers(), before);
});

test('resolveConsent settles a pending request the same way the popup message does', async () => {
  const env = await ready();
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n', requestId: 1 });
  await settle();
  assert.equal(await env.bridge.resolveConsent({ nonce: 'n', approved: true, scopes: ['groups:read'] }), true);
  assert.deepEqual(replyTo(env, 1).message, { approved: true });
  assert.equal(await env.bridge.resolveConsent({ nonce: 'n', approved: true, scopes: ['groups:read'] }), false, 'once');
  assert.equal(await env.bridge.resolveConsent({ nonce: 'other', approved: true }), false);
  assert.equal(await env.bridge.resolveConsent({}), false);
});

test('pendingConsent hands out a copy: changing it changes nothing in the bridge', async () => {
  const env = await ready();
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n', requestId: 1 });
  await settle();
  const pending = env.bridge.pendingConsent('n');
  pending.scopes.push('rooms:write');
  pending.app.name = 'Evil';
  assert.deepEqual(env.bridge.pendingConsent('n'), { nonce: 'n', app: { name: 'Demo', address: 'ws_1/demo' }, scopes: ['groups:read'] });
  assert.equal(env.bridge.pendingConsent('missing'), null);
  assert.equal(env.bridge.pendingConsent(undefined), null);
  assert.equal(env.bridge.pendingConsent('__proto__'), null);
});

test('the consent page can read the pending request through window.__valuHost, on the host origin only', async () => {
  const onHost = setup({ start: false });
  onHost.host.location = { origin: HOST_ORIGIN };
  bridges.push(onHost.bridge);
  onHost.bridge.start();
  assert.equal(typeof onHost.host.__valuHost?.pendingConsent, 'function');
  assert.deepEqual(Object.keys(onHost.host.__valuHost), ['pendingConsent'], 'nothing else is exposed');
  assert.equal(onHost.host.__valuHost.pendingConsent('x'), null);

  for (const location of [undefined, { origin: APP_ORIGIN }, { origin: 'null' }, {}]) {
    const other = setup({ start: false });
    other.host.location = location;
    bridges.push(other.bridge);
    other.bridge.start();
    assert.equal(other.host.__valuHost, undefined, `location: ${JSON.stringify(location)}`);
  }
  await onHost.bridge.stop();
  assert.equal(onHost.host.__valuHost, undefined, 'removed when the bridge stops');
});

test('__valuHost answers for a request registered by the app', async () => {
  const env = setup({ start: false, auth: fakeAuth({ session: SESSION }), makeServices: () => fakeServices(), makeGuru: () => guruWithGrants() });
  env.host.location = { origin: HOST_ORIGIN };
  bridges.push(env.bridge);
  env.bridge.start();
  await env.open();
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n', requestId: 1 });
  await settle();
  assert.deepEqual(env.host.__valuHost.pendingConsent('n'), { nonce: 'n', app: { name: 'Demo', address: 'ws_1/demo' }, scopes: ['groups:read'] });
});

// ---------------------------------------------------------------------------
// The Commerce data intents
// ---------------------------------------------------------------------------

test('Commerce list-products goes to the guru with appId stamped', async () => {
  const guru = guruWithGrants(['commerce:read'], {
    'valuguru.commerce.catalog.search': { products: [{ id: 'p1', title: 'Hat' }], nextOffset: 20 },
  });
  const env = await ready({ guru });
  intent(env, 'Commerce', 'list-products', { query: 'hat', appId: 'someone-else', scope: 'x' }, 4);
  await settle();

  const search = guru.ops('valuguru.commerce.catalog.search');
  assert.equal(search.length, 1);
  assert.equal(search[0].params.appId, 'demo', 'the slug the host stamped, not the one the app sent');
  assert.equal(search[0].params.query, 'hat');
  assert.deepEqual(env.last().data.message, { products: [{ id: 'p1', title: 'Hat' }], nextOffset: 20 });
  assert.equal(env.last().data.name, MSG.RUN_CONSOLE_COMPLETED);
  assert.equal(env.last().data.requestId, 4);
  assert.equal(env.services.calls.length, 0);
});

test('a Commerce write is a commerce:write grant, not a commerce:read one', async () => {
  const guru = guruWithGrants(['commerce:read'], { 'valuguru.commerce.cart.add': { items: [] } });
  const env = await ready({ guru });
  intent(env, 'Commerce', 'add-to-cart', { productId: 'p1' }, 1);
  intent(env, 'Commerce', 'list-my-products', {}, 2);
  await settle();
  assert.deepEqual(replyTo(env, 1).message, {
    success: false, code: 'consent_required', error: replyTo(env, 1).message.error, scope: 'commerce:write',
  });
  assert.equal(typeof replyTo(env, 1).message.error, 'string');
  assert.equal(replyTo(env, 2).message.scope, 'commerce:sell');
  assert.deepEqual(guru.ops('valuguru.commerce.cart.add'), [], 'nothing was sent');
});

test('a Commerce intent while signed out answers {success:false, code:sign_in_required}, and builds no guru', async () => {
  const env = await ready({ session: null });
  intent(env, 'Commerce', 'list-products', {}, 1);
  intent(env, 'Commerce', 'subscribe-events', { events: ['cart-updated'] }, 2);
  intent(env, 'Application', 'get-identity-token', {}, 3);
  await settle();
  for (const id of [1, 2, 3]) {
    const { message } = replyTo(env, id);
    assert.equal(message.success, false, `request ${id}`);
    assert.equal(message.code, 'sign_in_required', `request ${id}`);
    assert.equal(typeof message.error, 'string');
  }
  assert.equal(env.made.guru.length, 0);
});

test('an intent scope that is forbidden answers forbidden without consulting grants or running anything', async () => {
  const permissions = { ...Permissions, scopeOfIntent: () => 'veruswallet:write' };
  const env = await ready({ permissions });
  intent(env, 'Commerce', 'list-products', {}, 1);
  intent(env, 'Commerce', 'subscribe-events', { events: [] }, 2);
  intent(env, 'Application', 'get-identity-token', {}, 3);
  await settle();
  for (const id of [1, 2, 3]) {
    assert.equal(replyTo(env, id).message.success, false, `request ${id}`);
    assert.equal(replyTo(env, id).message.code, 'forbidden', `request ${id}`);
  }
  assert.deepEqual(env.guru.requests, []);
  assert.equal(env.made.guru.length, 0);
});

test('an intent the host does not serve answers {error:{code:not_available}}', async () => {
  const env = await ready({ guru: guruWithGrants(['commerce:read', 'commerce:write', 'commerce:sell']) });
  const unserved = [
    ['Commerce', 'open-cart'], ['Commerce', 'checkout'], ['Commerce', 'publish-product'], ['Commerce', '__proto__'], ['Commerce', 'toString'],
    ['Application', 'open-app'], ['Application', 'get-identity-token-please'], ['Rooms', 'list-products'], ['Users', 'current'],
    ['commerce', 'list-products'], [undefined, undefined], [{}, []],
  ];
  unserved.forEach(([applicationId, action], index) => intent(env, applicationId, action, {}, index + 1));
  await settle();
  unserved.forEach(([applicationId, action], index) => {
    const { message } = replyTo(env, index + 1);
    assert.equal(message.error.code, 'not_available', `${applicationId}.${action}`);
    assert.equal(typeof message.error.message, 'string');
    assert.equal(message.success, undefined);
  });
  assert.deepEqual(env.guru.requests, [], 'not even the grants were read');
});

test('an intent whose Guru op fails answers the module\'s refusal, never a throw', async () => {
  const guru = guruWithGrants(['commerce:read'], {
    'valuguru.commerce.catalog.search': () => { throw new GuruError('timeout', 'no answer', { sent: true }); },
  });
  const env = await ready({ guru });
  intent(env, 'Commerce', 'list-products', {}, 1);
  await settle();
  assert.deepEqual(replyTo(env, 1).message, { success: false, code: 'timeout', error: 'no answer' });
});

test('an intent that cannot make its Guru client answers unavailable', async () => {
  const env = await ready({ makeGuru: () => { throw new TypeError('no WebSocket here'); } });
  intent(env, 'Commerce', 'list-products', {}, 1);
  ask(env, 'Groups', 'list-groups', {}, 2);
  await settle();
  assert.equal(replyTo(env, 1).message.success, false);
  assert.equal(replyTo(env, 1).message.code, 'unavailable');
  assert.deepEqual(replyTo(env, 2).message, { error: { status: true, code: 503, message: 'unavailable' } });
});

test('the Commerce user and network come from the master the host is signed in to', async () => {
  const guru = guruWithGrants(['commerce:sell'], {
    'valuguru.commerce.stores.getMine': { store: null },
  });
  let seen = null;
  const commerce = {
    COMMERCE_INTENTS: { 'get-my-store': {} },
    COMMERCE_APP_EVENTS: [],
    mapCommerceEvent: () => null,
    runCommerceIntent: async (action, params, context) => { seen = { action, params, context }; return { success: true }; },
  };
  const env = await ready({ guru, commerce });
  intent(env, 'Commerce', 'get-my-store', { a: 1 }, 1);
  await settle();
  assert.equal(seen.action, 'get-my-store');
  assert.deepEqual(seen.params, { a: 1 });
  assert.equal(seen.context.guru, guru);
  assert.equal(seen.context.appId, 'demo');
  assert.equal(seen.context.networkId, 'n1');
  assert.deepEqual(seen.context.user, { id: 'u1', name: 'Ada Lovelace' }, 'the master\'s user_info.user, whole');
});

// ---------------------------------------------------------------------------
// Commerce events
// ---------------------------------------------------------------------------

const triggers = (env) => env.posts().map((p) => p.data).filter((data) => data.name === MSG.TRIGGER && data.message.action === 'commerce');

test('subscribe-events then an order-updated frame for this app is pushed as api:trigger commerce', async () => {
  const env = await ready({ guru: guruWithGrants(['commerce:read']) });
  intent(env, 'Commerce', 'subscribe-events', { events: ['order-updated', 'cart-updated', 'order-updated'] }, 1);
  await settle();
  assert.deepEqual(replyTo(env, 1).message, { success: true, events: ['cart-updated', 'order-updated'] }, 'listed in the catalogue order, once each');

  env.guru.frame({ type: 'commerce_event', event: 'commerce.order.updated', orderId: 'o1', status: 'paid', appIds: ['demo', 'other'] });
  await settle();
  assert.equal(triggers(env).length, 1);
  assert.equal(triggers(env)[0].requestId, undefined, 'a push answers nothing');
  assert.deepEqual(triggers(env)[0].message, { action: 'commerce', data: { orderId: 'o1', status: 'paid', event: 'order-updated' } });
  assert.equal(env.posts().at(-1).targetOrigin, APP_ORIGIN);
});

test('commerce frames the app should not hear are not pushed', async () => {
  const env = await ready({ guru: guruWithGrants(['commerce:read']) });
  intent(env, 'Commerce', 'subscribe-events', { events: ['order-updated', 'catalogue-updated'] }, 1);
  await settle();
  env.guru.frame({ type: 'commerce_event', event: 'commerce.order.updated', orderId: 'o1', status: 'paid', appIds: ['other'] }); // another app's order
  env.guru.frame({ type: 'commerce_event', event: 'commerce.order.updated', orderId: 'o1', status: 'paid' }); // names nobody
  env.guru.frame({ type: 'commerce_event', event: 'commerce.store.updated', change: 'x' }); // not subscribed
  env.guru.frame({ type: 'commerce_event', event: 'commerce.catalogue.updated', networkId: 'elsewhere' }); // another network
  env.guru.frame({ type: 'commerce_event', event: 'commerce.nonsense' });
  env.guru.frame(null);
  env.guru.frame('x');
  await settle();
  assert.deepEqual(triggers(env), []);
  assert.deepEqual(env.logs, []);

  env.guru.frame({ type: 'commerce_event', event: 'commerce.catalogue.updated', networkId: 'n1', productId: 'p1' });
  await settle();
  assert.equal(triggers(env).length, 1, 'this network\'s shelf');
});

test('subscribe-events replaces the set; unsubscribe-events removes some or all; unknown names change nothing', async () => {
  const env = await ready({ guru: guruWithGrants(['commerce:read']) });
  const answer = async (action, params, id) => {
    intent(env, 'Commerce', action, params, id);
    await settle();
    return replyTo(env, id).message;
  };
  assert.deepEqual(await answer('subscribe-events', { events: ['order-updated', 'cart-updated'] }, 1), { success: true, events: ['cart-updated', 'order-updated'] });
  assert.deepEqual(await answer('subscribe-events', { events: ['catalogue-updated'] }, 2), { success: true, events: ['catalogue-updated'] }, 'replaced, not added to');

  const bad = await answer('subscribe-events', { events: ['catalogue-updated', 'order-updated', 'nonsense'] }, 3);
  assert.equal(bad.success, false);
  assert.equal(bad.code, 'validation_failed');
  assert.match(bad.error, /nonsense/);
  for (const [index, events] of [undefined, 'cart-updated', 5, null, { 0: 'cart-updated' }].entries()) {
    const refused = await answer('subscribe-events', { events }, 10 + index);
    assert.equal(refused.code, 'validation_failed', JSON.stringify(events));
  }
  const circular = {};
  circular.self = circular;
  const refusedCircular = await answer('subscribe-events', { events: [circular, 'x'.repeat(10_000)] }, 20);
  assert.equal(refusedCircular.code, 'validation_failed');
  assert.ok(refusedCircular.error.length < 600, 'a hostile name is not echoed whole');

  assert.deepEqual(await answer('unsubscribe-events', { events: ['catalogue-updated', 'order-updated'] }, 4), { success: true, events: [] }, 'what is left');
  assert.deepEqual(await answer('subscribe-events', { events: ['cart-updated', 'order-updated', 'delivery-updated'] }, 5), { success: true, events: ['cart-updated', 'order-updated', 'delivery-updated'] });
  assert.deepEqual(await answer('unsubscribe-events', { events: ['order-updated'] }, 6), { success: true, events: ['cart-updated', 'delivery-updated'] });
  assert.equal((await answer('unsubscribe-events', { events: ['nonsense'] }, 7)).code, 'validation_failed');
  assert.deepEqual(await answer('unsubscribe-events', {}, 8), { success: true, events: [] }, 'no names: all of them');
  assert.deepEqual(await answer('unsubscribe-events', undefined, 9), { success: true, events: [] });

  env.guru.frame({ type: 'commerce_event', event: 'commerce.order.updated', orderId: 'o1', status: 'paid', appIds: ['demo'] });
  await settle();
  assert.deepEqual(triggers(env), [], 'nothing is subscribed any more');
});

test('an empty subscribe-events list stops everything', async () => {
  const env = await ready({ guru: guruWithGrants(['commerce:read']) });
  intent(env, 'Commerce', 'subscribe-events', { events: ['order-updated'] }, 1);
  intent(env, 'Commerce', 'subscribe-events', { events: [] }, 2);
  await settle();
  assert.deepEqual(replyTo(env, 2).message, { success: true, events: [] });
  env.guru.frame({ type: 'commerce_event', event: 'commerce.order.updated', orderId: 'o1', status: 'paid', appIds: ['demo'] });
  await settle();
  assert.deepEqual(triggers(env), []);
});

test('subscribe-events is commerce:read and needs the grant', async () => {
  const env = await ready({ guru: guruWithGrants([]) });
  intent(env, 'Commerce', 'subscribe-events', { events: ['cart-updated'] }, 1);
  intent(env, 'Commerce', 'unsubscribe-events', {}, 2);
  await settle();
  for (const id of [1, 2]) {
    assert.equal(replyTo(env, id).message.code, 'consent_required');
    assert.equal(replyTo(env, id).message.scope, 'commerce:read');
  }
  env.guru.frame({ type: 'commerce_event', event: 'commerce.order.updated', orderId: 'o1', status: 'paid', appIds: ['demo'] });
  await settle();
  assert.deepEqual(triggers(env), []);
});

/** Grants over the real `GrantsStore` with a clock the test moves: they are cached for 60 s. */
const clockedGrants = (clock) => (guru, app) => new GrantsStore({ guru, appAddress: app.address, now: () => clock.now });

const ORDER_FRAME = { type: 'commerce_event', event: 'commerce.order.updated', orderId: 'o1', status: 'paid', appIds: ['demo'] };
const CART_FRAME = { type: 'commerce_event', event: 'commerce.cart.updated' };

test('a revoked commerce:read stops every push once the grants cache expires: no push, no cart read, the subscription is gone', async () => {
  const clock = { now: 1_000_000 };
  const granted = ['commerce:read'];
  const guru = guruWithGrants(granted, { 'valuguru.commerce.cart.get': { items: [{ appId: 'demo' }] } });
  const env = await ready({ guru, makeGrants: clockedGrants(clock) });
  intent(env, 'Commerce', 'subscribe-events', { events: ['order-updated', 'cart-updated', 'catalogue-updated'] }, 1);
  await settle();
  assert.equal(replyTo(env, 1).message.success, true);

  env.guru.frame(ORDER_FRAME);
  await settle();
  assert.equal(triggers(env).length, 1, 'granted: pushed');
  assert.equal(guru.ops(LIST).length, 1, 'and the grant came from the cache');

  granted.length = 0; // the user revokes it, elsewhere
  clock.now += 59_000;
  env.guru.frame(ORDER_FRAME);
  await settle();
  assert.equal(triggers(env).length, 2, 'within the 60 s the cache is trusted: a revocation lands within a minute');

  clock.now += 2_000; // past the TTL
  env.guru.frame(ORDER_FRAME);
  env.guru.frame(CART_FRAME);
  env.guru.frame({ type: 'commerce_event', event: 'commerce.catalogue.updated', networkId: 'n1', productId: 'p1' });
  await settle();
  assert.equal(triggers(env).length, 2, 'revoked: nothing more is pushed');
  assert.equal(guru.ops(LIST).length, 2, 'the grants were read again');
  assert.deepEqual(guru.ops('valuguru.commerce.cart.get'), [], 'and the cart was not read for an app that may not hear of it');

  // The subscription is gone, not just paused: a grant that comes back does not revive it.
  granted.push('commerce:read');
  clock.now += 61_000;
  env.guru.frame(ORDER_FRAME);
  await settle();
  assert.equal(triggers(env).length, 2, 'the app has to subscribe again');
  intent(env, 'Commerce', 'subscribe-events', { events: ['order-updated'] }, 2);
  await settle();
  env.guru.frame(ORDER_FRAME);
  await settle();
  assert.equal(triggers(env).length, 3);
});

test('commerce frames are dropped, and the subscription with them, when the grants cannot be read', async () => {
  const clock = { now: 1_000_000 };
  let readable = true;
  const guru = guruWithGrants(['commerce:read'], {
    [LIST]: () => {
      if (!readable) throw new GuruError('disconnected', 'secret sess-SECRET-1');
      return { grants: [{ scope: 'commerce:read', appId: APP.address, revokedAt: null }] };
    },
  });
  const env = await ready({ guru, makeGrants: clockedGrants(clock) });
  intent(env, 'Commerce', 'subscribe-events', { events: ['order-updated'] }, 1);
  await settle();

  readable = false;
  clock.now += 61_000;
  env.guru.frame(ORDER_FRAME);
  await settle();
  assert.deepEqual(triggers(env), [], 'unreadable: not pushed');
  assert.equal(env.logs.length, 1);
  assert.equal(env.logs[0].level, 'warn');
  assert.ok(!env.logs[0].message.includes('sess-SECRET-1'));

  readable = true;
  env.guru.frame(ORDER_FRAME);
  await settle();
  assert.deepEqual(triggers(env), [], 'and the subscription went with it');
});

test('a frame that arrives with nobody subscribed does not read the grants', async () => {
  const clock = { now: 1_000_000 };
  const env = await ready({ guru: guruWithGrants(['commerce:read']), makeGrants: clockedGrants(clock) });
  intent(env, 'Commerce', 'list-products', {}, 1);
  await settle();
  const reads = env.guru.ops(LIST).length;
  clock.now += 61_000;
  env.guru.frame(ORDER_FRAME);
  await settle();
  assert.equal(env.guru.ops(LIST).length, reads);
  assert.deepEqual(triggers(env), []);
});

test('frames are pushed in the order they arrived even while the grants are being read', async () => {
  const clock = { now: 1_000_000 };
  const reads = [];
  const guru = guruWithGrants(['commerce:read'], {
    [LIST]: () => {
      if (reads.length === 0 && clock.now === 1_000_000) return { grants: [{ scope: 'commerce:read', appId: APP.address, revokedAt: null }] };
      const d = deferred();
      reads.push(d);
      return d.promise;
    },
  });
  const env = await ready({ guru, makeGrants: clockedGrants(clock) });
  intent(env, 'Commerce', 'subscribe-events', { events: ['order-updated'] }, 1);
  await settle();

  clock.now += 61_000; // the next check reads the grants, and that read is slow
  env.guru.frame({ ...ORDER_FRAME, orderId: 'first' });
  env.guru.frame({ ...ORDER_FRAME, orderId: 'second' });
  env.guru.frame({ ...ORDER_FRAME, orderId: 'third' });
  await settle();
  assert.deepEqual(triggers(env), [], 'waiting for the read');
  assert.equal(reads.length, 1, 'one read serves the three frames');

  reads[0].resolve({ grants: [{ scope: 'commerce:read', appId: APP.address, revokedAt: null }] });
  await settle();
  assert.deepEqual(triggers(env).map((t) => t.message.data.orderId), ['first', 'second', 'third']);
});

test('frames wait for each other: a grants store that answers out of order cannot reorder the pushes', async () => {
  const asked = [];
  const grants = { has: () => { const d = deferred(); asked.push(d); return d.promise; }, grant: async () => {}, invalidate: () => {} };
  const env = await ready({ makeGrants: () => grants, guru: guruWithGrants() });
  // The subscription itself needs the grant once.
  intent(env, 'Commerce', 'subscribe-events', { events: ['order-updated'] }, 1);
  await settle();
  asked[0].resolve(true);
  await settle();
  asked.length = 0;

  for (const orderId of ['first', 'second', 'third']) env.guru.frame({ ...ORDER_FRAME, orderId });
  await settle();
  assert.equal(asked.length, 1, 'only the first frame is being checked: the others wait their turn');
  for (let turn = 0; turn < 3; turn += 1) {
    asked[turn].resolve(true);
    await settle();
  }
  assert.deepEqual(triggers(env).map((t) => t.message.data.orderId), ['first', 'second', 'third']);
});

test('a frame whose grants read ends after the user signed out is not pushed', async () => {
  const clock = { now: 1_000_000 };
  let slow = null;
  const guru = guruWithGrants(['commerce:read'], {
    [LIST]: () => {
      if (!slow) return { grants: [{ scope: 'commerce:read', appId: APP.address, revokedAt: null }] };
      return slow.promise;
    },
  }, { keepListenersOnClose: true });
  const env = await ready({ guru, makeGrants: clockedGrants(clock) });
  intent(env, 'Commerce', 'subscribe-events', { events: ['order-updated'] }, 1);
  await settle();
  slow = deferred();
  clock.now += 61_000;
  env.guru.frame(ORDER_FRAME);
  await settle();
  env.call(MSG.AUTH, { action: 'sign-out', requestId: 2 });
  await settle();
  env.posts().length = 0;
  slow.resolve({ grants: [{ scope: 'commerce:read', appId: APP.address, revokedAt: null }] });
  await settle();
  assert.deepEqual(env.posts(), []);
});

test('a cart frame for a subscribed app pushes cart-updated with the count of this app\'s rows', async () => {
  const guru = guruWithGrants(['commerce:read'], {
    'valuguru.commerce.cart.get': {
      items: [
        { id: 'a', appId: 'demo' }, { id: 'b', appId: 'other' }, { id: 'c', appId: 'demo' }, { id: 'd', appId: 'demo', savedForLater: true },
        null, { id: 'e' },
      ],
    },
  });
  const env = await ready({ guru });
  env.guru.frame({ type: 'commerce_event', event: 'commerce.cart.updated' });
  await settle();
  assert.deepEqual(guru.ops('valuguru.commerce.cart.get'), [], 'nobody subscribed: the cart is not read');

  intent(env, 'Commerce', 'subscribe-events', { events: ['cart-updated'] }, 1);
  await settle();
  env.guru.frame({ type: 'commerce_event', event: 'commerce.cart.updated', count: 99 });
  await settle();
  assert.equal(guru.ops('valuguru.commerce.cart.get').length, 1);
  assert.deepEqual(triggers(env).map((t) => t.message), [{ action: 'commerce', data: { count: 2, event: 'cart-updated' } }]);
});

test('a cart frame for an app that did not subscribe to cart-updated reads nothing and pushes nothing', async () => {
  const guru = guruWithGrants(['commerce:read'], { 'valuguru.commerce.cart.get': { items: [] } });
  const env = await ready({ guru });
  intent(env, 'Commerce', 'subscribe-events', { events: ['order-updated'] }, 1);
  await settle();
  env.guru.frame({ type: 'commerce_event', event: 'commerce.cart.updated' });
  await settle();
  assert.deepEqual(guru.ops('valuguru.commerce.cart.get'), []);
  assert.deepEqual(triggers(env), []);
});

test('only the newest cart read is pushed: a slow older one does not overwrite it', async () => {
  const reads = [];
  const guru = guruWithGrants(['commerce:read'], {
    'valuguru.commerce.cart.get': () => { const d = deferred(); reads.push(d); return d.promise; },
  });
  const env = await ready({ guru });
  intent(env, 'Commerce', 'subscribe-events', { events: ['cart-updated'] }, 1);
  await settle();
  env.guru.frame({ type: 'commerce_event', event: 'commerce.cart.updated' });
  env.guru.frame({ type: 'commerce_event', event: 'commerce.cart.updated' });
  await settle();
  assert.equal(reads.length, 2);
  reads[1].resolve({ items: [{ appId: 'demo' }, { appId: 'demo' }, { appId: 'demo' }] });
  await settle();
  reads[0].resolve({ items: [{ appId: 'demo' }] });
  await settle();
  assert.deepEqual(triggers(env).map((t) => t.message.data.count), [3]);
});

test('a cart read that fails is a missed event, logged without the message', async () => {
  const guru = guruWithGrants(['commerce:read'], {
    'valuguru.commerce.cart.get': () => { throw new GuruError('disconnected', 'secret sess-SECRET-1'); },
  });
  const env = await ready({ guru });
  intent(env, 'Commerce', 'subscribe-events', { events: ['cart-updated'] }, 1);
  await settle();
  env.guru.frame({ type: 'commerce_event', event: 'commerce.cart.updated' });
  await settle();
  assert.deepEqual(triggers(env), []);
  assert.equal(env.logs.length, 1);
  assert.equal(env.logs[0].level, 'warn');
  assert.ok(!env.logs[0].message.includes('sess-SECRET-1'));
});

test('a cart read that finishes after the app unsubscribed, or after sign-out, is not pushed', async () => {
  const reads = [];
  const guru = guruWithGrants(['commerce:read'], {
    'valuguru.commerce.cart.get': () => { const d = deferred(); reads.push(d); return d.promise; },
  }, { keepListenersOnClose: true });
  const env = await ready({ guru });
  intent(env, 'Commerce', 'subscribe-events', { events: ['cart-updated'] }, 1);
  await settle();
  env.guru.frame({ type: 'commerce_event', event: 'commerce.cart.updated' });
  await settle();
  intent(env, 'Commerce', 'unsubscribe-events', {}, 2);
  await settle();
  reads[0].resolve({ items: [{ appId: 'demo' }] });
  await settle();
  assert.deepEqual(triggers(env), [], 'unsubscribed while the cart was being read');

  intent(env, 'Commerce', 'subscribe-events', { events: ['cart-updated'] }, 3);
  await settle();
  env.guru.frame({ type: 'commerce_event', event: 'commerce.cart.updated' });
  await settle();
  env.call(MSG.AUTH, { action: 'sign-out', requestId: 4 });
  await settle();
  env.posts().length = 0;
  reads[1].resolve({ items: [{ appId: 'demo' }] });
  await settle();
  assert.deepEqual(env.posts(), [], 'signed out while the cart was being read');
});

// ---------------------------------------------------------------------------
// The identity token
// ---------------------------------------------------------------------------

/** The master connection's own `emit`, scripted. */
function scriptEmit(env, answer) {
  const emitted = [];
  env.maker.connections[0].emit = async (ns, data, timeoutMs) => {
    emitted.push({ ns, data, timeoutMs });
    return typeof answer === 'function' ? answer(ns, data) : answer;
  };
  return emitted;
}

test('get-identity-token emits appManifest:getIdentityToken with the slug', async () => {
  const env = await ready();
  const emitted = scriptEmit(env, { data: { token: 'jwt.header.payload', expiresIn: 300 } });
  intent(env, 'Application', 'get-identity-token', { applicationId: 'someone-else' }, 9);
  await settle();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].ns, 'appManifest:getIdentityToken');
  assert.deepEqual(emitted[0].data, { applicationId: 'demo' }, 'the host stamped it: the app\'s params cannot name another app');
  assert.equal(env.last().data.name, MSG.RUN_CONSOLE_COMPLETED);
  assert.equal(env.last().data.requestId, 9);
  assert.deepEqual(env.last().data.message, { token: 'jwt.header.payload', expiresIn: 300 }, 'the token is the one thing the app is meant to get');
  assert.equal(env.made.guru.length, 0, 'a basic intent needs no Guru client');
});

test('an identity token that fails answers an intent refusal; a master that is down is disconnected', async () => {
  const env = await ready();
  scriptEmit(env, () => ({ error: { status: true, code: 503, message: 'emit appManifest:getIdentityToken: disconnected (closed)' } }));
  intent(env, 'Application', 'get-identity-token', {}, 1);
  await settle();
  assert.equal(replyTo(env, 1).message.success, false);
  assert.equal(replyTo(env, 1).message.code, 'disconnected');

  scriptEmit(env, () => ({ error: { status: true, code: 401, message: 'nope' } }));
  intent(env, 'Application', 'get-identity-token', {}, 2);
  await settle();
  assert.deepEqual(replyTo(env, 2).message, { success: false, code: 'error', error: 'nope' });

  scriptEmit(env, () => ({ data: null }));
  intent(env, 'Application', 'get-identity-token', {}, 3);
  await settle();
  assert.deepEqual(replyTo(env, 3).message, { success: false, code: 'error', error: 'the master issued no identity token' });
});

test('the token exemption is narrow: it covers only the top-level token of the identity answer', async () => {
  const env = await ready();
  const answers = [
    { data: { token: 'jwt', nested: { session_token: 'sess-SECRET-1' } } },
    { data: { token: 'jwt', sessionId: 'sess-SECRET-1' } },
    { data: { token: { inner: 'x' } } },
    { data: { token: 'jwt', more: { token: 'second' } } },
    { data: { session_token: 'sess-SECRET-1' } },
  ];
  for (const [index, answer] of answers.entries()) {
    scriptEmit(env, () => answer);
    intent(env, 'Application', 'get-identity-token', {}, index + 1);
    await settle();
    assert.deepEqual(replyTo(env, index + 1).message, { error: { code: 'internal', message: 'blocked outbound credential' } }, `answer ${index}`);
  }
  assert.ok(env.logs.every((entry) => !entry.message.includes('sess-SECRET-1')));
  const sent = JSON.stringify(env.posts());
  assert.ok(!sent.includes('sess-SECRET-1'));
});

test('no other reply may carry a token: a service ack or a Commerce answer with one is blocked', async () => {
  const services = fakeServices(() => ({ data: { token: 'leak-1' } }));
  const guru = guruWithGrants(['commerce:read'], {
    'valuguru.commerce.catalog.search': { products: [{ id: 'p', token: 'leak-2' }] },
  });
  const env = await ready({ services, guru });
  ask(env, 'Users', 'current', {}, 1);
  intent(env, 'Commerce', 'list-products', {}, 2);
  await settle();
  assert.deepEqual(replyTo(env, 1).message, { error: { code: 'internal', message: 'blocked outbound credential' } });
  assert.deepEqual(replyTo(env, 2).message, { error: { code: 'internal', message: 'blocked outbound credential' } });
  assert.ok(!JSON.stringify(env.posts()).includes('leak-'));
});

test('an app cannot make the host mark its own reply as an identity token: only the identity path does', async () => {
  // A service ack the app influenced, with a token key at the top level of the
  // reply message, is the very shape the exemption would let through.
  const services = fakeServices(() => ({ token: 'forged' }));
  const env = await ready({ services });
  ask(env, 'Users', 'current', {}, 1);
  await settle();
  assert.deepEqual(replyTo(env, 1).message, { error: { code: 'internal', message: 'blocked outbound credential' } });
});

// ---------------------------------------------------------------------------
// The Guru client the host makes
// ---------------------------------------------------------------------------

test('the Guru client is made on first need, once, and never for a basic call or a signed-out app', async () => {
  const env = await ready({ guru: guruWithGrants(['groups:read', 'commerce:read']) });
  ask(env, 'Users', 'current', {}, 1);
  await settle();
  assert.equal(env.made.guru.length, 0);

  ask(env, 'Groups', 'list-groups', {}, 2);
  intent(env, 'Commerce', 'list-products', {}, 3);
  await settle();
  assert.equal(env.made.guru.length, 1, 'one client for the grants and Commerce together');
});

test('the Guru client mints its one-time token with the host session and the master network', async () => {
  const fetchImpl = mintFetch({ token: 'ott-42' });
  const env = await ready({ fetchImpl, guru: guruWithGrants(['groups:read']) });
  ask(env, 'Groups', 'list-groups', {}, 1);
  await settle();
  const { mintToken, getNetworkId } = env.made.guru[0].session;

  assert.equal(getNetworkId(), 'n1', 'the network the master is in');
  assert.equal(await mintToken(), 'ott-42');
  assert.equal(fetchImpl.calls.length, 1);
  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url, 'https://api.roomful.net/api/v1/auth/getOneTimeAuthToken');
  assert.equal(init.method, 'POST');
  assert.equal(init.body, '{}');
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json', 'X-Session-Id': SESSION.sessionId, 'X-Network': 'n1' });

  assert.equal(await mintToken(), 'ott-42');
  assert.equal(fetchImpl.calls.length, 2, 'a token is single-use: every call mints');
});

test('the mint goes to the configured master', async () => {
  const fetchImpl = mintFetch();
  const env = await ready({ fetchImpl, config: { master: 'api.example.test' }, guru: guruWithGrants(['groups:read']) });
  ask(env, 'Groups', 'list-groups', {}, 1);
  await settle();
  await env.made.guru[0].session.mintToken();
  assert.equal(fetchImpl.calls[0].url, 'https://api.example.test/api/v1/auth/getOneTimeAuthToken');
});

test('a refused or empty mint rejects: session_expired for a 401, a plain error otherwise, and never the session', async () => {
  const session = async (fetchImpl) => {
    const env = await ready({ fetchImpl, guru: guruWithGrants(['groups:read']) });
    ask(env, 'Groups', 'list-groups', {}, 1);
    await settle();
    return env.made.guru[0].session;
  };
  await assert.rejects(
    (await session(mintFetch({ body: { error: { status: true, code: 401, message: 'Unauthorized' } } }))).mintToken(),
    (error) => error.code === 'session_expired' && !String(error.message).includes('sess-SECRET'),
  );
  await assert.rejects(
    (await session(mintFetch({ body: { data: {}, error: { status: false, code: 200 } } }))).mintToken(),
    (error) => error instanceof Error && !String(error.message).includes('sess-SECRET'),
  );
  await assert.rejects((await session(mintFetch({ status: 500, body: { data: { token: 'x' } } }))).mintToken(), Error);
  await assert.rejects(
    (await session(async () => { throw new TypeError('network down'); })).mintToken(),
    TypeError,
  );
});

test('a mint after sign-out rejects sign_in_required and does not call fetch', async () => {
  const fetchImpl = mintFetch();
  const env = await ready({ fetchImpl, guru: guruWithGrants(['groups:read']) });
  ask(env, 'Groups', 'list-groups', {}, 1);
  await settle();
  const { mintToken } = env.made.guru[0].session;
  env.call(MSG.AUTH, { action: 'sign-out', requestId: 2 });
  await settle();
  await assert.rejects(mintToken(), (error) => error.code === 'sign_in_required');
  assert.deepEqual(fetchImpl.calls, []);
});

test('a real GuruClient over the injected WebSocket reads the grants with the minted token for the master network', async () => {
  const sockets = [];
  class RecordingSocket {
    static OPEN = 1;
    readyState = 0;
    sent = [];
    constructor(url) {
      this.url = url;
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); });
    }
    send(json) { this.sent.push(JSON.parse(json)); }
    close() { this.readyState = 3; }
  }
  const fetchImpl = mintFetch({ token: 'ott-real' });
  const env = setup({
    auth: fakeAuth({ session: SESSION }),
    makeServices: () => fakeServices(),
    fetchImpl,
    makeGuru: (sessionArg) => new GuruClient({
      ...sessionArg, WebSocketImpl: RecordingSocket, onlineSource: { onLine: true }, addEventListener: () => {},
    }),
  });
  bridges.push(env.bridge);
  await env.open();
  ask(env, 'Groups', 'list-groups', {}, 1);
  await until(() => sockets[0]?.sent.length > 0);

  assert.equal(sockets.length, 1);
  assert.match(sockets[0].url, /token=ott-real/);
  const [request] = sockets[0].sent;
  assert.equal(request.type, 'data_request');
  assert.equal(request.op, LIST);
  assert.deepEqual(request.params, { appId: 'ws_1/demo' });
  assert.equal(request.networkId, 'n1');
});

test('the default factories are the real GuruClient (made from the session seam) and GrantsStore (for the canonical address)', async () => {
  const session = { mintToken: async () => 't', getNetworkId: () => 'n1' };
  const guru = defaultMakeGuru(session, APP);
  try {
    assert.ok(guru instanceof GuruClient);
    assert.equal(guru.state, 'idle', 'made lazily: nothing is opened until a request needs it');
  } finally {
    guru.close();
  }
  const requests = [];
  const grants = defaultMakeGrants({ request: async (op, params) => { requests.push({ op, params }); return { grants: [] }; } }, APP);
  assert.ok(grants instanceof GrantsStore);
  assert.equal(await grants.has('groups:read'), false);
  assert.deepEqual(requests, [{ op: LIST, params: { appId: 'ws_1/demo' } }]);
});

// ---------------------------------------------------------------------------
// Sign-out and stop
// ---------------------------------------------------------------------------

test('sign-out closes the guru, clears subscriptions, pending consents and the grants cache', async () => {
  const granted = ['commerce:read', 'groups:read'];
  // A client that, as a real one can, still delivers a frame that was already on its way when it was closed.
  const guru = guruWithGrants(granted, {}, { keepListenersOnClose: true });
  const grantsInvalidated = [];
  const env = await ready({
    guru,
    makeGrants: (g, app) => {
      const inner = { has: async (scope) => granted.includes(scope), grant: async () => {}, invalidate: () => grantsInvalidated.push(app.address) };
      return inner;
    },
  });
  intent(env, 'Commerce', 'subscribe-events', { events: ['order-updated'] }, 1);
  env.call(MSG.CONSENT, { scopes: ['rooms:read'], nonce: 'n', requestId: 2 });
  await settle();
  assert.notEqual(env.bridge.pendingConsent('n'), null);
  env.posts().length = 0;

  env.call(MSG.AUTH, { action: 'sign-out', requestId: 3 });
  await settle();

  assert.equal(guru.closed, 1);
  assert.equal(env.maker.connections[0].closed, 1);
  assert.deepEqual(grantsInvalidated, ['ws_1/demo'], 'the grants cache was dropped');
  assert.equal(env.bridge.pendingConsent('n'), null);
  assert.deepEqual(replyTo(env, 2, MSG.CONSENT_COMPLETED).message, { approved: false, reason: 'sign_in_required' }, 'the waiting app is told');
  assert.equal(replyTo(env, 3).name, MSG.AUTH_COMPLETED);

  env.posts().length = 0;
  guru.frame({ type: 'commerce_event', event: 'commerce.order.updated', orderId: 'o', status: 'paid', appIds: ['demo'] });
  decide(env, { nonce: 'n', approved: true, scopes: ['rooms:read'] });
  await settle();
  assert.deepEqual(env.posts(), [], 'no push, no answer after sign-out');

  ask(env, 'Users', 'current', {}, 4);
  intent(env, 'Commerce', 'list-products', {}, 5);
  await settle();
  assert.equal(replyTo(env, 4).message.error.code, 401);
  assert.equal(replyTo(env, 5).message.code, 'sign_in_required');
});

test('a grants cache that cannot be dropped does not stop the sign-out', async () => {
  const guru = guruWithGrants(['groups:read']);
  const env = await ready({
    guru,
    makeGrants: () => ({ has: async () => true, grant: async () => {}, invalidate: () => { throw new Error('secret sess-SECRET-1'); } }),
  });
  ask(env, 'Groups', 'list-groups', {}, 1);
  env.call(MSG.CONSENT, { scopes: ['rooms:read'], nonce: 'n', requestId: 2 });
  await settle();
  env.posts().length = 0;

  env.call(MSG.AUTH, { action: 'sign-out', requestId: 3 });
  await settle();

  assert.deepEqual(
    env.names(),
    [MSG.CONSENT_COMPLETED, MSG.TRIGGER, MSG.TRIGGER, MSG.AUTH_COMPLETED],
    'the waiting app is told, the auth and connection pushes and the reply still go out',
  );
  assert.deepEqual(replyTo(env, 3).message, { ok: true });
  assert.equal(env.bridge.state.signedIn, false);
  assert.equal(guru.closed, 1);
  assert.equal(env.maker.connections[0].closed, 1);
  assert.equal(env.logs.length, 1);
  assert.equal(env.logs[0].level, 'warn');
  assert.ok(!env.logs[0].message.includes('sess-SECRET-1'));

  ask(env, 'Users', 'current', {}, 4);
  await settle();
  assert.equal(replyTo(env, 4).message.error.code, 401);
});

test('stop closes the guru and leaves no timer behind, even with a call and a consent pending', async () => {
  const before = timers();
  const never = deferred();
  const services = fakeServices(() => never.promise);
  const guru = guruWithGrants(['groups:read']);
  const env = await ready({ services, guru });
  ask(env, 'Users', 'current', {}, 1);
  ask(env, 'Groups', 'list-groups', {}, 2);
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n', requestId: 3 });
  await settle();
  assert.ok(timers() > before, 'a call timeout and a consent expiry are armed');

  await env.bridge.stop();
  assert.equal(guru.closed, 1);
  assert.equal(timers(), before);
  assert.equal(env.bridge.pendingConsent('n'), null);
  never.resolve({ data: {} });
  await settle();
  assert.deepEqual(env.posts(), [], 'a stopped bridge answers nobody');
});

test('a request in flight when the user signs out is answered once with what the closed connection gave, and the next call is 401', async () => {
  const held = deferred();
  const services = fakeServices(() => held.promise);
  const env = await ready({ services });
  ask(env, 'Users', 'current', {}, 1);
  await settle();
  env.call(MSG.AUTH, { action: 'sign-out', requestId: 2 });
  await settle();
  assert.equal(replyTo(env, 1), undefined, 'the bridge does not invent an answer: the closed connection settles it');

  const cut = { error: { status: true, code: 503, message: 'emit users:current: disconnected (closed)' } };
  held.resolve(cut);
  await settle();
  assert.equal(env.posts().filter((p) => p.data.requestId === 1).length, 1);
  assert.deepEqual(replyTo(env, 1).message, cut);

  ask(env, 'Users', 'current', {}, 3);
  await settle();
  assert.deepEqual(replyTo(env, 3).message, { error: { status: true, code: 401, message: 'sign_in_required' } });
  assert.equal(services.calls.length, 1, 'the call after sign-out never reached the services');
});

test('messages from another origin or window are still ignored for the new names', async () => {
  const env = await ready({ guru: guruWithGrants(['groups:read']) });
  const stranger = { origin: OTHER_ORIGIN, source: env.app };
  env.send({ name: MSG.CALL, message: { service: 'Users', action: 'current', params: {}, requestId: 1 } }, stranger);
  env.send({ name: MSG.SERVICE_INTENT, message: { applicationId: 'Commerce', action: 'list-products', requestId: 2 } }, stranger);
  env.send({ name: MSG.CONSENT, message: { scopes: ['groups:read'], nonce: 'n', requestId: 3 } }, stranger);
  env.send({ name: MSG.CALL, message: { service: 'Users', action: 'current', params: {}, requestId: 4 } }, { origin: APP_ORIGIN, source: { other: true } });
  await settle();
  assert.deepEqual(env.posts(), []);
  assert.deepEqual(env.services.calls, []);
  assert.equal(env.bridge.pendingConsent('n'), null);
});

test('a call, an intent or a consent that arrives before api:ready is not served', async () => {
  const env = await ready({ open: false });
  ask(env, 'Users', 'current', {}, 1);
  intent(env, 'Commerce', 'list-products', {}, 2);
  env.call(MSG.CONSENT, { scopes: ['groups:read'], nonce: 'n', requestId: 3 });
  await settle();
  assert.deepEqual(env.posts(), []);
  assert.deepEqual(env.services.calls, []);
});

test('the answers carry the numeric request id the call carried, and none when it carried none', async () => {
  const env = await ready();
  env.call(MSG.CALL, { service: 'Users', action: 'current', params: {} });
  env.call(MSG.CALL, { service: 'Users', action: 'current', params: {}, requestId: 'seven' });
  env.call(MSG.SERVICE_INTENT, { applicationId: 'Commerce', action: 'nope' });
  await settle();
  assert.deepEqual(env.posts().map((p) => p.data.requestId), [undefined, undefined, undefined]);
  assert.equal(env.posts().length, 3);
});

test('a hello from the bound origin after calls still re-sends api:ready and serves on', async () => {
  const env = await ready();
  ask(env, 'Users', 'current', {}, 1);
  await settle();
  env.hello();
  await settle();
  assert.equal(env.names().at(-1), MSG.READY);
  ask(env, 'Users', 'current', {}, 2);
  await settle();
  assert.equal(env.last().data.name, MSG.CALL_COMPLETED);
});
