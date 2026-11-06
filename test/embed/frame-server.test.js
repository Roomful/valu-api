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
const CALL_REPLIES_NOT_AVAILABLE = { error: { status: true, code: 501, message: 'not_available' } };
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

test('createFrameServer takes services with a call() or none, and refuses an app state, a log or intents of the wrong kind', () => {
  assert.throws(() => createFrameServer({ services: {} }), TypeError);
  const services = recordingServices();
  assert.throws(() => createFrameServer({ services, appState: 'state' }), TypeError);
  assert.throws(() => createFrameServer({ services, log: 'console' }), TypeError);
  assert.throws(() => createFrameServer({ services, intents: 'run' }), TypeError);
  assert.throws(() => createFrameServer({ services, toFrame: true }), TypeError);
  const server = createFrameServer({ services, appState: null });
  assert.deepEqual(Object.keys(server).sort(), ['handle', 'intents', 'readyInfo']);
  assert.ok(Object.isFrozen(server));
  // No services: an intents-only server (typed app intents §5.5), whose functions answer 501.
  assert.doesNotThrow(() => createFrameServer());
  assert.doesNotThrow(() => createFrameServer({ intents: async () => ({}) }));
});

test('without services every function answers 501, and readyInfo says calls: false', async () => {
  const server = createFrameServer({ intents: async () => ({}), log: () => {} });
  assert.deepEqual(await server.handle(callOf('Users.current', {})), CALL_REPLIES_NOT_AVAILABLE);
  assert.equal(server.readyInfo().calls, false);
  assert.equal(server.readyInfo().intents, true);
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

// ---------------------------------------------------------------------------
// Intents over api:call (typed app intents, docs/superpowers/specs/2026-11-03-
// typed-app-intents-design.md §5.5)
// ---------------------------------------------------------------------------

/** A frame server with a recording intent runner, a recording gate, and no services. */
function intentServer({ answer = () => ({ success: true }), gate = async () => ({ ok: true }), toFrame } = {}) {
  const runs = [];
  const scopes = [];
  const logs = [];
  const server = createFrameServer({
    intents: async (...args) => {
      runs.push(args);
      return answer(...args);
    },
    gate: async (scope) => {
      scopes.push(scope);
      return gate(scope);
    },
    ...(toFrame ? { toFrame } : {}),
    log: (level, message) => logs.push({ level, message }),
  });
  return { server, runs, scopes, logs };
}

const intentCall = (target, id, action, params = {}, extra = {}) => ({
  intent: id === undefined ? { target } : { target, id }, action, params, requestId: 3, timeoutMs: 30_000, ...extra,
});

test('readyInfo says intents: true only when the server was given intents', () => {
  assert.equal(createFrameServer({ services: recordingServices() }).readyInfo().intents, undefined);
  assert.equal('intents' in createFrameServer({ services: recordingServices() }).readyInfo(), false);
  assert.equal(createFrameServer({ services: recordingServices(), intents: async () => ({}) }).readyInfo().intents, true);
  assert.equal(createFrameServer({ services: recordingServices() }).intents, false);
});

test('an app intent runs through intents(application, id, action, params), and its reply is read into an ack', async () => {
  const { server, runs, scopes } = intentServer({ answer: () => ({ success: true, opened: 'chat' }) });
  const ack = await server.handle(intentCall('application', 'textchat', 'open-channel', { userId: 'u-2' }));
  assert.deepEqual(ack, { data: { success: true, opened: 'chat' } });
  assert.deepEqual(runs, [['application', 'textchat', 'open-channel', { userId: 'u-2' }]]);
  // The gate gets the scope the bridge computes for the same intent.
  assert.deepEqual(scopes, ['ui:open']);
});

test('a service intent runs through intents(service, id, ...), gated by the bridge scope of that intent', async () => {
  const { server, runs, scopes } = intentServer({ answer: () => ({ items: [], count: 0 }) });
  assert.deepEqual(await server.handle(intentCall('service', 'Commerce', 'get-cart')), { data: { items: [], count: 0 } });
  assert.deepEqual(runs, [['service', 'Commerce', 'get-cart', {}]]);
  assert.deepEqual(scopes, ['commerce:read']);
  // A write to another person is the bridge's write scope.
  await server.handle(intentCall('application', 'textchat', 'send-message', { text: 'hi' }));
  assert.equal(scopes.at(-1), 'textchat:write');
});

test('a refused intent answers in the order of §5.5, and never runs', async () => {
  // 1. the catalogue does not name it: 404, before anything else is asked.
  let h = intentServer();
  for (const message of [
    intentCall('application', 'textchat', 'no-such-action'),
    intentCall('service', 'Commerce', 'no-such-action'),
    intentCall('service', 'AiGuru', 'get-chat-history'), // unscoped: not a typed intent
    intentCall('application', 'auth', 'logout'), // Valu Social's own
    intentCall('elsewhere', 'textchat', 'open-channel'),
    intentCall('route', undefined, 'go-back', { path: '/x' }),
    { intent: 'textchat', action: 'open-channel' },
  ]) {
    const ack = await h.server.handle(message);
    assert.equal(ack.error?.message, 'unknown_function', JSON.stringify(message));
  }
  assert.deepEqual(h.runs, []);
  assert.deepEqual(h.scopes, [], 'the gate is not asked about what the catalogue does not name');

  // 2. no intents runner: 501.
  const bare = createFrameServer({ services: recordingServices(), log: () => {} });
  assert.deepEqual(await bare.handle(intentCall('application', 'textchat', 'open-channel')), CALL_REPLIES_NOT_AVAILABLE);

  // 3. params that do not fit: 400, before the gate.
  h = intentServer();
  const invalid = await h.server.handle(intentCall('application', 'rooms', 'show-room', { room: 'r-1' }));
  assert.equal(invalid.error.code, 400);
  assert.deepEqual(h.scopes, []);
  assert.deepEqual(h.runs, []);

  // 4. the gate says no: its refusal, and nothing runs.
  h = intentServer({ gate: async (scope) => ({ ok: false, code: 'permission_not_declared', scope }) });
  const refused = await h.server.handle(intentCall('application', 'textchat', 'open-channel', {}));
  assert.equal(refused.error.message, 'permission_not_declared');
  assert.equal(refused.error.scope, 'ui:open');
  assert.deepEqual(h.runs, []);
});

test('every app intent also takes route and pushToHistory', async () => {
  const { server, runs } = intentServer();
  const ack = await server.handle(intentCall('application', 'rooms', 'show-room', { roomId: 'r-1', route: '/info', pushToHistory: false }));
  assert.deepEqual(ack, { data: { success: true } });
  assert.deepEqual(runs[0][3], { roomId: 'r-1', route: '/info', pushToHistory: false });
});

test('valu.Apps.send to an app no descriptor names: scoped at run time, a frame is apps:intent, an unscoped one is refused', async () => {
  const frames = new Set(['ws-portal-app']);
  const { server, runs, scopes } = intentServer({ toFrame: (id) => frames.has(id) });
  // A Developer Portal app, which decides for itself what it does with it: any action, any params.
  assert.deepEqual(await server.handle(intentCall('application', 'ws-portal-app', 'refresh', { anything: [1, 2] })), { data: { success: true } });
  assert.deepEqual(runs.at(-1), ['application', 'ws-portal-app', 'refresh', { anything: [1, 2] }]);
  assert.equal(scopes.at(-1), 'apps:intent');
  // Opening any app is ui:open.
  await server.handle(intentCall('application', 'settings', 'open', { route: '/privacy' }));
  assert.equal(scopes.at(-1), 'ui:open');
  // An app that is not a frame, with an action the bridge does not scope: refused before the gate.
  const before = runs.length;
  const ack = await server.handle(intentCall('application', 'settings', 'reset-everything'));
  assert.equal(ack.error.message, 'unknown_function');
  assert.equal(runs.length, before);
});

test('a route command runs through intents(route, null, push|replace, {path}), and is never gated', async () => {
  const { server, runs, scopes } = intentServer({ gate: async () => ({ ok: false, code: 'forbidden', scope: null }) });
  assert.deepEqual(await server.handle(intentCall('route', undefined, 'push', { path: '/a' })), { data: { success: true } });
  assert.deepEqual(await server.handle(intentCall('route', undefined, 'replace', { path: '/b' })), { data: { success: true } });
  assert.deepEqual(runs, [['route', null, 'push', { path: '/a' }], ['route', null, 'replace', { path: '/b' }]]);
  assert.deepEqual(scopes, []);
  assert.equal((await server.handle(intentCall('route', undefined, 'push', {}))).error.code, 400);
});

test('a refusal the intent answers reads like a refused function', async () => {
  const { server } = intentServer({ answer: () => ({ success: false, code: 'consent_required', error: 'ask first', scope: 'commerce:write' }) });
  const ack = await server.handle(intentCall('service', 'Commerce', 'add-to-cart', { productId: 'p-1' }));
  assert.equal(ack.error.code, 403);
  assert.equal(ack.error.message, 'consent_required');
  assert.equal(ack.error.scope, 'commerce:write');
});

test("the identity token passes the leak guard for its own intent only; every other intent's reply is guarded", async () => {
  const { server, logs } = intentServer({ answer: (target, id, action) => ({ token: 'jwt.for.app', action }) });
  const identity = await server.handle(intentCall('service', 'Application', 'get-identity-token'));
  assert.deepEqual(identity, { data: { token: 'jwt.for.app', action: 'get-identity-token' } });
  const other = await server.handle(intentCall('service', 'Commerce', 'get-cart'));
  assert.equal(other.error.message, 'blocked outbound credential');
  assert.match(logs.at(-1).message, /blocked an outbound/);

  // The exemption is the token itself, and nothing else in the same reply.
  const nested = intentServer({ answer: () => ({ token: 'jwt', session: { accessToken: 'x' } }) });
  const blocked = await nested.server.handle(intentCall('service', 'Application', 'get-identity-token'));
  assert.equal(blocked.error.message, 'blocked outbound credential');
});

test('an intent is one attempt bounded by its timeoutMs; a runner that throws is a failed answer, never a rejection', async () => {
  const { server } = intentServer({ answer: () => new Promise(() => {}) });
  const ack = await server.handle(intentCall('application', 'textchat', 'open-channel', {}, { timeoutMs: 20 }));
  assert.equal(ack.error.code, 408);
  const write = await server.handle(intentCall('application', 'textchat', 'send-message', { text: 'x' }, { timeoutMs: 20 }));
  assert.equal(write.error.retryable, false, 'a write that ran out of time may still be applied');

  const thrower = intentServer({ answer: () => { throw new Error('boom'); } });
  assert.equal((await thrower.server.handle(intentCall('application', 'textchat', 'open-channel'))).error.message, 'internal');
});

test('bridge gating is unchanged: folded app-intent names are still unscoped as service intents', async () => {
  const { scopeOfServiceIntent } = await import('../../src/host/BridgeScopes.js');
  for (const [service, action] of [['Rooms', 'show-room'], ['Profile', 'show-user'], ['Groups', 'open']]) {
    assert.equal(scopeOfServiceIntent(service, action), null, `${service}.${action}`);
  }
});
