// ===========================================================================
// The frame server — what Valu Social answers its framed apps' `api:call` with
// (src/embed/FrameServer.js). Every test runs it over a real `ValuServiceApi`
// on the Valu Social door (`connectValuServices({ socket: webSocketService })`)
// unless it is about what the services were asked, where a recording fake
// stands in. The host's answer for the same function is `answerCall` over the
// same kind of socket fake, with a host that is signed in and grants all.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFrameServer } from '../../src/embed/FrameServer.js';
import { createFrameServer as fromRoot, connectValuServices, createValuServices, BrowserSocketAdapter } from '../../src/ValuApi.js';
import { SocketTransport } from '../../src/transport/SocketTransport.js';
import { ServiceClient } from '../../src/services/ServiceClient.js';
import * as Permissions from '../../src/host/Permissions.js';
import { CALL_REPLIES, answerCall } from '../../src/host/HostDispatch.js';
import { EMBEDDED_PROTOCOL_VERSION } from '../../src/host/protocol.js';
import { findDescriptor } from '../../src/services/descriptors.js';
import { validationAck } from '../../src/services/validate.js';
import { FakeAppState, FakeWebSocketService, Responder } from '../helpers/fakes.js';

const ok = (data) => ({ data });
const USERS = { 'social:getUsersSimpleInfo': ok({ users: [{ id: 'user-1', name: 'Ada' }] }) };

/** The message `HostTransport` posts for `key` (the envelope's `requestId` rides inside it). */
const callOf = (key, params, extra = {}) => {
  const descriptor = findDescriptor(key);
  return { service: descriptor.service, action: descriptor.action, params, requestId: 7, timeoutMs: 30_000, ...extra };
};

/** Valu Social's services over a scripted socket, the way §5 builds them. */
async function valuSocial(script = {}, options = {}) {
  const responder = new Responder(script);
  const services = await connectValuServices({ socket: new FakeWebSocketService(responder), userId: 'user-1', ...options });
  const logs = [];
  const server = createFrameServer({ services, log: (level, message) => logs.push({ level, message }), ...options.server });
  return { responder, services, server, logs };
}

/** Services that record what they were asked and answer `answer(name, params, options)`. */
function recordingServices(answer = () => ({ data: {} })) {
  const calls = [];
  return {
    calls,
    call: (name, params, options) => {
      calls.push({ name, params, options });
      return answer(name, params, options);
    },
  };
}

/** The host's answer for the same message over the same kind of socket: a signed-in user who granted everything. */
async function hostAnswer(script, message) {
  const responder = new Responder(script);
  const services = createValuServices({
    socket: new BrowserSocketAdapter({ socket: new FakeWebSocketService(responder), userId: 'user-1' }),
    cache: null,
  });
  const host = {
    permissions: Permissions,
    signedIn: () => true,
    callTimeoutMs: 30_000,
    services: () => services,
    grants: () => ({ has: async () => true }),
    log: () => {},
  };
  return { ack: await answerCall(host, message), responder };
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

test('createFrameServer is exported from the package root and by path', () => {
  assert.equal(fromRoot, createFrameServer);
});

test('createFrameServer needs services with a call(), and refuses an app state or a log of the wrong kind', () => {
  assert.throws(() => createFrameServer(), TypeError);
  assert.throws(() => createFrameServer({}), TypeError);
  assert.throws(() => createFrameServer({ services: {} }), TypeError);
  const services = recordingServices();
  assert.throws(() => createFrameServer({ services, appState: 'state' }), TypeError);
  assert.throws(() => createFrameServer({ services, log: 'console' }), TypeError);
  const server = createFrameServer({ services, appState: null });
  assert.deepEqual(Object.keys(server).sort(), ['handle', 'readyInfo']);
  assert.ok(Object.isFrozen(server));
});

// ---------------------------------------------------------------------------
// readyInfo
// ---------------------------------------------------------------------------

test('readyInfo is the api:ready key: protocol 1, calls, and the user and network as {id, name}', () => {
  const { readyInfo } = createFrameServer({ services: recordingServices() });
  assert.deepEqual(
    readyInfo({ user: { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.test' }, network: { id: 'n1', name: 'Roomful', token: 'x' } }),
    { protocol: 1, calls: true, user: { id: 'u1', name: 'Ada Lovelace' }, network: { id: 'n1', name: 'Roomful' } },
  );
});

test('readyInfo says the embedded protocol\'s own version, not the host\'s', () => {
  const { readyInfo } = createFrameServer({ services: recordingServices() });
  assert.equal(readyInfo().protocol, EMBEDDED_PROTOCOL_VERSION);
  assert.equal(readyInfo().protocol, 1);
});

test('readyInfo: a missing name is null, and a user or network without an id is null', () => {
  const { readyInfo } = createFrameServer({ services: recordingServices() });
  assert.deepEqual(readyInfo({ user: { id: 'u1' }, network: { id: 'n1', name: '' } }), {
    protocol: 1, calls: true, user: { id: 'u1', name: null }, network: { id: 'n1', name: null },
  });
  for (const identity of [undefined, null, {}, { user: null, network: null }, { user: { id: '' }, network: { id: 5 } }, { user: 'u1', network: ['n1'] }]) {
    assert.deepEqual(readyInfo(identity), { protocol: 1, calls: true, user: null, network: null }, JSON.stringify(identity));
  }
  const first = readyInfo({ user: { id: 'u1' } });
  assert.notEqual(readyInfo({ user: { id: 'u1' } }), first, 'a new object each time');
});

// ---------------------------------------------------------------------------
// The refusals, in the host's order
// ---------------------------------------------------------------------------

test('a function the catalogue does not have is 404 unknown_function, and nothing runs', async () => {
  const services = recordingServices();
  const { handle } = createFrameServer({ services });
  const notFound = { error: { status: true, code: 404, message: 'unknown_function' } };
  for (const message of [
    { service: 'Nope', action: 'nothing', params: {} },
    { service: 'Users', params: {} },
    { service: 5, action: 'current' },
    {},
    null,
    'Users.current',
    [],
  ]) {
    assert.deepEqual(await handle(message), notFound, JSON.stringify(message));
  }
  assert.equal(services.calls.length, 0);
});

test('a local function is 501 not_available (it runs in the app page), before its params are read', async () => {
  const services = recordingServices();
  const { handle } = createFrameServer({ services });
  const notServed = { error: { status: true, code: 501, message: 'not_available' } };
  assert.deepEqual(await handle(callOf('Http.get', { url: 'https://example.test/x' })), notServed);
  assert.deepEqual(await handle(callOf('Time.get-local-time', 'not params')), notServed, 'the channel is checked before the params');
  assert.equal(services.calls.length, 0);
});

test('an app-state function is 501 not_available without an app state', async () => {
  const services = recordingServices();
  const { handle } = createFrameServer({ services });
  for (const key of ['Developer.list-applications', 'VerusWallet.get-balance']) {
    const params = key === 'VerusWallet.get-balance' ? { agentId: 'agent-1' } : {};
    assert.deepEqual(await handle(callOf(key, params)), { error: { status: true, code: 501, message: 'not_available' } }, key);
  }
  assert.equal(services.calls.length, 0);
});

test('params that do not fit are 400, the validation ack itself, and nothing runs', async () => {
  const services = recordingServices();
  const { handle } = createFrameServer({ services });
  const descriptor = findDescriptor('Users.get');
  for (const params of [{}, { userId: 5 }, 'u-9', null]) {
    const answer = await handle(callOf('Users.get', params));
    assert.equal(answer.error.code, 400, JSON.stringify(params));
    assert.deepEqual(answer, validationAck(descriptor, params));
  }
  assert.equal(services.calls.length, 0);
});

test('omitted params are {}, as at the host', async () => {
  const services = recordingServices();
  const { handle } = createFrameServer({ services });
  const message = callOf('Users.current', undefined);
  delete message.params;
  await handle(message);
  assert.deepEqual(services.calls[0].params, {});
});

test('no sign-in check and no permission gate: a consent-tier and a forbidden-tier function run', async () => {
  const services = recordingServices((name) => ({ data: { ran: name } }));
  const { handle } = createFrameServer({ services });
  assert.deepEqual(await handle(callOf('Rooms.search-my-rooms', { filter: 'all' })), { data: { ran: 'Rooms.search-my-rooms' } });
  const policy = {
    networkId: 'roomful', targetType: 'room', targetId: 'r-1', badgeIds: ['b-1'], badgeMatchMode: 'any', grantedPermission: 'view',
  };
  assert.deepEqual(await handle(callOf('Cbac.create-policy', policy)), { data: { ran: 'Cbac.create-policy' } });
});

// ---------------------------------------------------------------------------
// One attempt, bounded
// ---------------------------------------------------------------------------

test('a call is ONE attempt with no cache: retries 0, bypassCache, the message timeout', async () => {
  const services = recordingServices();
  const { handle } = createFrameServer({ services });
  await handle(callOf('Users.get', { userId: 'u-9' }, { timeoutMs: 5_000 }));
  assert.deepEqual(services.calls, [{ name: 'Users.get', params: { userId: 'u-9' }, options: { retries: 0, timeoutMs: 5_000, bypassCache: true } }]);
});

test('a read that times out on the wire is tried once, not retried under the app\'s own policy', async () => {
  const { server, responder } = await valuSocial({ 'social:getUsersSimpleInfo': 'timeout' });
  const answer = await server.handle(callOf('Users.get', { userId: 'u-9' }));
  assert.equal(answer.error.status, true);
  assert.equal(responder.calls.length, 1, 'one wire attempt');
});

test('the timeout is the message\'s, capped at the host\'s 30 s, and 30 s when it names none usable', async () => {
  const services = recordingServices();
  const { handle } = createFrameServer({ services });
  const cases = [[5_000, 5_000], [30_000, 30_000], [60_000, 30_000], [undefined, 30_000], [0, 30_000], [-5, 30_000],
    ['1000', 30_000], [Number.NaN, 30_000], [Number.POSITIVE_INFINITY, 30_000], [null, 30_000]];
  for (const [requested, used] of cases) {
    services.calls.length = 0;
    await handle(callOf('Users.current', {}, { timeoutMs: requested }));
    assert.equal(services.calls[0].options.timeoutMs, used, String(requested));
  }
});

test('a call that outlives its timeout answers 408 timeout, at the bound and not later', async () => {
  const services = recordingServices(() => new Promise(() => {}));
  const { handle } = createFrameServer({ services });
  const started = Date.now();
  const answer = await handle(callOf('Users.get', { userId: 'u-9' }, { timeoutMs: 25 }));
  const took = Date.now() - started;
  assert.deepEqual(answer, { error: { status: true, code: 408, message: 'timeout' } });
  assert.ok(took >= 20 && took < 1_000, `took ${took} ms`);
});

test('a write that outlives its timeout says it may still apply: retryable false', async () => {
  const services = recordingServices(() => new Promise(() => {}));
  const { handle } = createFrameServer({ services });
  const answer = await handle(callOf('Users.send-connection-request', { userId: 'u-3' }, { timeoutMs: 10 }));
  assert.deepEqual(answer, { error: { status: true, code: 408, message: 'timeout', retryable: false } });
});

test('a write the services answer cut off (503) or timed out (408) is marked retryable false; a read is not', async () => {
  const cut = { error: { status: true, code: 503, message: 'socket not ready' } };
  const { handle } = createFrameServer({ services: recordingServices(() => cut) });
  assert.deepEqual(await handle(callOf('Users.send-connection-request', { userId: 'u-3' })), { error: { ...cut.error, retryable: false } });
  assert.deepEqual(await handle(callOf('Users.get', { userId: 'u-3' })), cut);
});

test('the constant replies are copies: an answer the caller changes changes no later answer', async () => {
  const { handle } = createFrameServer({ services: recordingServices(() => new Promise(() => {})) });
  const first = await handle(callOf('Users.get', { userId: 'u-9' }, { timeoutMs: 5 }));
  first.error.message = 'changed';
  const second = await handle(callOf('Users.get', { userId: 'u-9' }, { timeoutMs: 5 }));
  assert.equal(second.error.message, 'timeout');
  assert.equal(CALL_REPLIES.timeout.error.message, 'timeout');
});

// ---------------------------------------------------------------------------
// What the services answer
// ---------------------------------------------------------------------------

test('a function answers what valu-api\'s own function answers over Valu Social\'s connection', async () => {
  const { server, responder } = await valuSocial(USERS);
  const answer = await server.handle(callOf('Users.current', {}));
  assert.deepEqual(answer.data.user, { id: 'user-1', name: 'Ada' });
  assert.deepEqual(responder.calls.map((c) => [c.ns, c.data]), [['social:getUsersSimpleInfo', { ids: ['user-1'] }]]);
});

test('the answer is the host\'s answer for the same function over the same socket fake', async () => {
  const script = {
    ...USERS,
    'social:sendRequest': ok({}),
    'room:searchRoomsOfUser': ok({ rooms: [{ id: 'r-1', name: 'Design' }] }),
  };
  const messages = [
    callOf('Users.current', {}),
    callOf('Users.get', { userId: 'user-1' }),
    callOf('Users.send-connection-request', { userId: 'u-3' }),
    callOf('Rooms.search-my-rooms', { filter: 'all' }),
    callOf('Users.get', { userId: 5 }),
    { service: 'Nope', action: 'nothing', params: {} },
  ];
  for (const message of messages) {
    const embedded = await valuSocial(script);
    const host = await hostAnswer(script, message);
    assert.deepEqual(await embedded.server.handle(message), host.ack, `${message.service}.${message.action}`);
    assert.deepEqual(embedded.responder.calls.map((c) => [c.ns, c.data]), host.responder.calls.map((c) => [c.ns, c.data]));
  }
});

test('the leak guard: an answer that carries a session never reaches the app, and the log names the key, not the value', async () => {
  const { server, logs } = await valuSocial({
    'social:getUsersSimpleInfo': ok({ users: [{ id: 'user-1', name: 'Ada', session_token: 'sess-SECRET' }] }),
  });
  const answer = await server.handle(callOf('Users.current', {}));
  assert.deepEqual(answer, { error: { code: 'internal', message: 'blocked outbound credential' } });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'error');
  assert.match(logs[0].message, /blocked an outbound api:call-completed/);
  assert.match(logs[0].message, /session_token/);
  assert.doesNotMatch(logs[0].message, /sess-SECRET/);
});

test('the leak guard reads every key the host guards, at any depth', async () => {
  for (const key of ['x-session-id', 'Token', 'oneTimeToken', 'sessionId']) {
    const { handle } = createFrameServer({
      services: recordingServices(() => ({ data: { list: [{ nested: { [key]: 'v' } }] } })),
      log: () => {},
    });
    assert.deepEqual(await handle(callOf('Users.current', {})), { error: { code: 'internal', message: 'blocked outbound credential' } }, key);
  }
});

test('services that throw answer 500 internal, logged by code; ones that resolve no ack answer 500 too', async () => {
  const logs = [];
  const thrower = createFrameServer({
    services: { call: async () => { throw Object.assign(new Error('secret detail'), { code: 'EBOOM' }); } },
    log: (level, message) => logs.push({ level, message }),
  });
  assert.deepEqual(await thrower.handle(callOf('Users.current', {})), { error: { status: true, code: 500, message: 'internal' } });
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /EBOOM/);
  assert.doesNotMatch(logs[0].message, /secret detail/);

  const empty = createFrameServer({ services: recordingServices(() => 'not an ack') });
  assert.deepEqual(await empty.handle(callOf('Users.current', {})), { error: { status: true, code: 500, message: 'internal' } });
});

test('a log that throws does not take handle down', async () => {
  const { handle } = createFrameServer({
    services: { call: async () => { throw new Error('boom'); } },
    log: () => { throw new Error('the logger is broken'); },
  });
  assert.deepEqual(await handle(callOf('Users.current', {})), { error: { status: true, code: 500, message: 'internal' } });
});

// ---------------------------------------------------------------------------
// app-state, with an app state
// ---------------------------------------------------------------------------

test('with an appState, app-state functions run over the same connection with that state', async () => {
  const appState = new FakeAppState({ listDeveloperApplications: async () => [{ appId: 'a-1' }] });
  const { server } = await valuSocial({}, { server: { appState } });
  const answer = await server.handle(callOf('Developer.list-applications', {}));

  // What a SocketTransport holding that state answers directly.
  const direct = new ServiceClient({
    transport: new SocketTransport({ socket: new BrowserSocketAdapter({ socket: new FakeWebSocketService(new Responder()), userId: 'user-1' }), appState }),
    cache: null,
  });
  assert.deepEqual(answer, await direct.call('Developer.list-applications', {}, { retries: 0 }));
  assert.equal(answer.data.applications.length, 1);
});

test('the frame server\'s appState is the one used, not the one the services were built with', async () => {
  const own = new FakeAppState({ listDeveloperApplications: async () => [{ appId: 'valu-social-own' }] });
  const frames = new FakeAppState({ listDeveloperApplications: async () => [{ appId: 'for-frames' }] });
  const responder = new Responder();
  const services = await connectValuServices({ socket: new FakeWebSocketService(responder), userId: 'user-1', appState: own });

  const withState = createFrameServer({ services, appState: frames });
  const answer = await withState.handle(callOf('Developer.list-applications', {}));
  assert.equal(answer.data.applications[0].appId, 'for-frames');

  const without = createFrameServer({ services });
  assert.deepEqual(await without.handle(callOf('Developer.list-applications', {})), { error: { status: true, code: 501, message: 'not_available' } });
});

test('a roomful function that reads app state (VerusWallet.transfer) reads the frame server\'s', async () => {
  const appState = new FakeAppState({ getAgentWallet: async () => ({ identityName: 'alice@', iAddress: 'i-1', status: 'created' }) });
  const script = { 'verus:sendCurrency': ok({ txid: 'tx-1' }) };
  const params = { agentId: 'agent-1', destination: 'bob@', amount: 3 };

  const withState = await valuSocial(script, { server: { appState } });
  assert.equal((await withState.server.handle(callOf('VerusWallet.transfer', params))).data.txid, 'tx-1');

  // Without one, the function reads what the services were built with: here, nothing.
  const without = await valuSocial(script);
  const answer = await without.server.handle(callOf('VerusWallet.transfer', params));
  assert.equal(answer.error.code, 501);
  assert.match(answer.error.message, /getAgentWallet/);
  assert.equal(without.responder.calls.length, 0);
});

test('with an appState, every call carries it to the services; without one, none does', async () => {
  const appState = new FakeAppState({});
  const services = recordingServices();
  await createFrameServer({ services, appState }).handle(callOf('Users.current', {}));
  await createFrameServer({ services }).handle(callOf('Users.current', {}));
  assert.equal(services.calls[0].options.appState, appState);
  assert.deepEqual(services.calls[1].options, { retries: 0, timeoutMs: 30_000, bypassCache: true });
});

test('an app-state call is bounded by its timeout too', async () => {
  const appState = new FakeAppState({ listDeveloperApplications: () => new Promise(() => {}) });
  const { server } = await valuSocial({}, { server: { appState } });
  assert.deepEqual(
    await server.handle(callOf('Developer.list-applications', {}, { timeoutMs: 10 })),
    { error: { status: true, code: 408, message: 'timeout' } },
  );
});
