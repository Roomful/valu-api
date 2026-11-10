// ===========================================================================
// The function surface.
//
// `valu.Users.current()` must be the SAME call as `client.call('Users.current')`
// — same validation, same cache, same policy — or it is a second code path
// pretending to be sugar. These tests assert that, and that the tree holds
// every function in the catalogue — which is every function this package can
// run at all.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createValuServices, ValuServiceApi } from '../src/services/api.js';
import { ServiceClient } from '../src/services/ServiceClient.js';
import { SocketTransport } from '../src/transport/SocketTransport.js';
import { PostMessageTransport } from '../src/transport/PostMessageTransport.js';
import { NodeSocketAdapter } from '../src/socket/NodeSocketAdapter.js';
import { SERVICE_FUNCTIONS, INTENT_FUNCTIONS, APPLICATION_ONLY_INTENTS, findDescriptor } from '../src/services/descriptors.js';
import { ValuServiceError, ERROR_CODES } from '../src/Errors.js';
import { FakeRoomfulConnection, Responder, FakeWindow } from './helpers/fakes.js';

const ok = (data) => ({ data });

/** The surface a headless agent would build: a socket, nothing else. */
function headless(script = {}) {
  const responder = new Responder(script);
  const socket = new NodeSocketAdapter({ connection: new FakeRoomfulConnection(responder) });
  return { responder, valu: createValuServices({ socket, cache: null }) };
}

test('every service function is on the tree, under its service', () => {
  const { valu } = headless();

  for (const descriptor of SERVICE_FUNCTIONS) {
    const namespace = valu[descriptor.service];
    assert.ok(namespace, `no namespace for ${descriptor.service}`);
    assert.equal(typeof namespace[descriptor.method], 'function', descriptor.key);
    // A method knows what it is, so a runtime building tools from these does
    // not have to look the function up by string to find out.
    assert.equal(namespace[descriptor.method].key, descriptor.key);
    assert.equal(namespace[descriptor.method].toolName, descriptor.toolName);
    assert.equal(namespace[descriptor.method].name, descriptor.method);
  }

  const methods = SERVICE_FUNCTIONS.length;
  // A service's namespace also holds the app intents folded onto it (`valu.Rooms.showRoom`): those are intents.
  const onTree = ValuServiceApi.services()
    .reduce((n, service) => n + Object.values(valu[service]).filter((m) => m.descriptor?.channel !== 'intent').length, 0);
  assert.equal(onTree, methods, 'the tree is the catalogue, not a subset of it');
  assert.equal(methods, 65);
});

test('the typed intents are on the tree, as intents; the untyped application-served ones are not', () => {
  const { valu } = headless();
  const camel = (action) => action.replace(/[-_](\w)/g, (_, c) => c.toUpperCase());
  for (const key of APPLICATION_ONLY_INTENTS) {
    const [service, action] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
    const typed = INTENT_FUNCTIONS.find((d) => d.key === key);
    if (typed) {
      // On its own namespace, or on the one it is named onto (`AiGuru.is-application-loaded` is `valu.Apps.isLoaded`).
      assert.equal(typeof valu[typed.service]?.[typed.method], 'function', key);
      assert.equal(valu[typed.service][typed.method].descriptor.channel, 'intent', key);
      assert.equal(typed.target, 'service', key);
      assert.equal(typed.to, service, key);
    } else {
      assert.equal(valu[service]?.[camel(action)], undefined, key);
      assert.equal(findDescriptor(key), undefined, key);
    }
  }
  // Commerce is the case worth naming (2026-10-30): every one of its intents is
  // a typed function, sent to whoever frames or hosts the app as the intent it
  // is — never run here, so none is a service function.
  assert.equal(typeof valu.Commerce.getCart, 'function');
  assert.equal(typeof valu.Commerce.openCart, 'function');
  assert.equal(valu.Commerce.openCart.descriptor.mode, 'window');
  assert.equal(valu.Application.expandApplication.descriptor.mode, 'embedded-only');
  assert.equal(valu.AiGuru, undefined, 'the AI chat history is not an app\'s');
  // The two Developer REST API reads share the namespace with its service functions.
  assert.equal(valu.Developer.listApplicationApis.descriptor.channel, 'intent');
  assert.equal(valu.Developer.listMyApplicationApis.descriptor.mode, 'embedded-served');
  assert.equal(valu.Developer.listApplications.descriptor.channel, 'app-state');
  // 72 service intents (2026-11-06: + CMS.pickResource, the five RoomZones, the three RoomPoints the socket
  // could answer, the three valu.Apps reads; 2026-11-10: + the two Developer REST API reads) and 62 application intents.
  assert.equal(INTENT_FUNCTIONS.filter((d) => d.target === 'service').length, 72);
  assert.equal(INTENT_FUNCTIONS.filter((d) => d.target === 'application').length, 62);
  assert.equal(INTENT_FUNCTIONS.length, 134);
});

test('every application intent an app may send is a function, on its app\'s namespace or a service of the same name', () => {
  const { valu } = headless();
  assert.equal(valu.Chats.openChannel.descriptor.to, 'textchat');
  assert.equal(valu.Chats.openChannel.descriptor.target, 'application');
  assert.equal(valu.Chats.openChannel.descriptor.mode, 'window');
  assert.equal(valu.Chats.getUiState.descriptor.mode, 'embedded-only');
  assert.equal(valu.MyCart.openCart.descriptor.to, 'cart');
  assert.equal(valu.Metaverse2D.open.descriptor.to, 'hubs');
  assert.equal(valu.ContentStudio.openCreate.descriptor.scopes[0], 'apps:intent');
  assert.equal(valu.ContentStudio.openCreate.descriptor.mode, 'embedded-served');
  // Folded onto the service of the same name, beside its functions.
  assert.equal(valu.Rooms.showRoom.descriptor.to, 'rooms');
  assert.equal(typeof valu.Rooms.searchMyRooms, 'function');
  assert.equal(valu.Groups.open.descriptor.to, 'groups');
  assert.equal(valu.Profile.showUser.descriptor.to, 'profile');
  // Valu Social's own are not functions; neither is an intent with no scope.
  assert.equal(valu.Auth, undefined);
  assert.equal(valu.LlmDebug, undefined);
  assert.equal(valu.Metaverse2D.agentSay, undefined);
  assert.equal(valu.MerchantConsole.openModeration, undefined);
  // Every one takes route and pushToHistory too.
  const optional = valu.Calendar.openCalendar.descriptor.params.optional.map((p) => p.name);
  assert.ok(optional.includes('route') && optional.includes('pushToHistory'));
});

test('valu.Apps: the three reads take an app id in order, and open/send take theirs', async () => {
  const { valu } = headless();
  for (const name of ['isLoaded', 'list', 'has', 'open', 'send']) assert.equal(typeof valu.Apps[name], 'function', name);
  assert.equal(valu.Apps.isLoaded.descriptor.to, 'AiGuru');
  assert.equal(valu.Apps.isLoaded.descriptor.action, 'is-application-loaded');
  assert.equal(valu.Apps.isLoaded.descriptor.mode, 'embedded-served');
  // A socket client has nowhere to send an intent: 501, whichever way it is called.
  for (const ack of [
    await valu.Apps.isLoaded('textchat'),
    await valu.Apps.isLoaded({ applicationId: 'textchat' }),
    await valu.Apps.open('textchat'),
    await valu.Apps.send('ws-app', 'refresh', { a: 1 }),
  ]) assert.equal(ack.error.code, 501);
  // An intent no app may send is refused before anything else.
  assert.equal((await valu.Apps.send('auth', 'logout')).error.code, 404);
  await assert.rejects(() => valu.data.Apps.send('auth', 'logout'));
});

test('a method is the string call with the name already resolved', async () => {
  const { valu, responder } = headless({
    'social:getUsersSimpleInfo': ok({ users: [{ id: 'u-1', firstName: 'Ada' }] }),
  });

  const viaMethod = await valu.Users.get({ userId: 'u-1' });
  const viaString = await valu.call('Users.get', { userId: 'u-1' });

  assert.deepEqual(viaMethod, viaString);
  assert.deepEqual(viaMethod.data.user, { id: 'u-1', firstName: 'Ada' });
  assert.equal(responder.calls.length, 2, 'two calls, no cache in this fixture');
});

test('valu.data returns the payload and throws instead of answering an error', async () => {
  const { valu } = headless({
    'social:getUsersSimpleInfo': ok({ users: [{ id: 'u-1' }] }),
    'explorer:searchRooms': { error: { status: true, code: 500, message: 'index down' } },
  });

  assert.deepEqual(await valu.data.Users.get({ userId: 'u-1' }), { user: { id: 'u-1' } });

  await assert.rejects(
    () => valu.data.Rooms.searchRooms({ query: 'design' }),
    (error) => {
      assert.ok(error instanceof ValuServiceError);
      assert.equal(error.service, 'Rooms');
      assert.equal(error.fn, 'search_rooms');
      return true;
    },
  );

  // The same failure on the ack tree is an envelope, not a throw.
  const ack = await valu.Rooms.searchRooms({ query: 'design' });
  assert.equal(ack.error.status, true);
});

test('validation, scopes and cache are not bypassed by using a method', async () => {
  const responder = new Responder({ 'social:getUsersSimpleInfo': ok({ users: [{ id: 'u-1' }] }) });
  const socket = new NodeSocketAdapter({ connection: new FakeRoomfulConnection(responder) });
  const valu = createValuServices({ socket });

  const invalid = await valu.Users.get({ userId: 42 });
  assert.equal(invalid.error.code, ERROR_CODES.INVALID_PARAMS);
  assert.equal(responder.calls.length, 0, 'nothing invalid reaches the socket');

  await valu.Users.get({ userId: 'u-1' });
  await valu.Users.get({ userId: 'u-1' });
  assert.equal(responder.calls.length, 1, 'the second read came from the cache');
});

test('the tree and the client are one object, not two', () => {
  const { valu } = headless();
  assert.ok(valu.client instanceof ServiceClient);
  assert.equal(valu.transport, valu.client.transport);
  assert.equal(valu.cache, valu.client.cache);
  assert.equal(valu.data, valu.data, 'the unwrapped tree is built once');
});

test('createValuServices builds a socket transport, and refuses the bridge', () => {
  const { valu } = headless();
  assert.ok(valu.transport instanceof SocketTransport);

  // The plain postMessage bridge is not a service transport. It could carry these
  // calls — the application answers `api:service-intent` — and that is exactly
  // the ambiguity this package dropped: a service function runs over a socket or
  // over the valu-api host (`createValuApp`), the same way everywhere, or it is
  // not a service function. The refusals say where they do run.
  const bridge = new PostMessageTransport({ target: new FakeWindow() });
  assert.throws(() => createValuServices({ transport: bridge }), /does not serve service functions.*createValuApp/s);
  assert.throws(() => new ServiceClient({ transport: bridge }), /does not serve service functions.*createValuApp/s);
  assert.throws(() => new ServiceClient({ transport: bridge }), /plain intents bridge \(ValuApi\.callService\)/);

  assert.throws(() => createValuServices({}), /needs a socket.*valu-api host.*createValuApp/s);
});

test('the tool definitions are the service functions, and nothing else', () => {
  const { valu } = headless();
  const names = new Set(valu.toolDefinitions().map((d) => d.function.name));

  assert.ok(names.has('service__Users__current'));
  assert.ok(names.has('service__Users__list_connection_requests'));
  for (const key of APPLICATION_ONLY_INTENTS) {
    const [service, action] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
    assert.equal(names.has(`service__${service}__${action.replace(/-/g, '_')}`), false, key);
  }
});

test('the SDK-declared read works exactly like a declared one', async () => {
  const { valu } = headless({
    'request:listRequests': ok({ requests: [{ id: 'r-1', initiatorUserId: 'u-7' }] }),
    'social:getUsersSimpleInfo': ok({ users: [{ id: 'u-7', firstName: 'Ada' }] }),
  });

  const { requests, users, hasMore } = await valu.data.Users.listConnectionRequests();

  assert.deepEqual(requests, [{ id: 'r-1', initiatorUserId: 'u-7' }]);
  assert.deepEqual(users, [{ id: 'u-7', firstName: 'Ada' }]);
  assert.equal(hasMore, false);
});

test('a call may carry its own appState: the handler reads it in place of the transport\'s', async () => {
  const own = { listDeveloperApplications: async () => [{ appId: 'transport-own' }] };
  const given = { listDeveloperApplications: async () => [{ appId: 'this-call' }] };
  const services = createValuServices({ socket: new NodeSocketAdapter({ connection: new FakeRoomfulConnection(new Responder()) }), appState: own, cache: null });

  assert.equal((await services.call('Developer.list-applications', {}, { appState: given })).data.applications[0].appId, 'this-call');
  assert.equal((await services.call('Developer.list-applications', {})).data.applications[0].appId, 'transport-own');

  const bare = createValuServices({ socket: new NodeSocketAdapter({ connection: new FakeRoomfulConnection(new Responder()) }), cache: null });
  assert.equal((await bare.call('Developer.list-applications', {})).error.code, ERROR_CODES.UNSUPPORTED);
  assert.equal((await bare.call('Developer.list-applications', {}, { appState: given })).data.applications.length, 1);
});

test('a call\'s appState reaches the transport only when it is given', async () => {
  const seen = [];
  const transport = new SocketTransport({ socket: new NodeSocketAdapter({ connection: new FakeRoomfulConnection(new Responder()) }) });
  transport.callService = async (descriptor, params, options) => { seen.push(options); return { data: {} }; };
  const client = new ServiceClient({ transport, cache: null });
  const state = { getAgentWallet: async () => null };
  await client.call('Users.current', {}, { retries: 0 });
  await client.call('Users.current', {}, { retries: 0, appState: state });
  assert.deepEqual(seen[0], { timeoutMs: 30_000, attempt: 1 });
  assert.deepEqual(seen[1], { timeoutMs: 30_000, attempt: 1, appState: state });
});
