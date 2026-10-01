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
import { SERVICE_FUNCTIONS, APPLICATION_ONLY_INTENTS, findDescriptor } from '../src/services/descriptors.js';
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
  const onTree = ValuServiceApi.services()
    .reduce((n, service) => n + Object.keys(valu[service]).length, 0);
  assert.equal(onTree, methods, 'the tree is the catalogue, not a subset of it');
  assert.equal(methods, 65);
});

test('no application-served intent is on the tree, by any of its names', () => {
  const { valu } = headless();
  const camel = (action) => action.replace(/[-_](\w)/g, (_, c) => c.toUpperCase());
  for (const key of APPLICATION_ONLY_INTENTS) {
    const [service, action] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
    assert.equal(valu[service]?.[camel(action)], undefined, key);
    assert.equal(findDescriptor(key), undefined, key);
  }
  // Commerce is the case worth naming. It used to be half here: ten catalogue
  // functions on the tree and three `open-*` intents off it. All thirteen are
  // off it now — the catalogue ones run on the Valu Guru server's own socket,
  // which this package does not hold — so the service has no namespace at all,
  // and a caller is pointed at `api.callService` rather than at a method that
  // could only work in one runtime.
  assert.equal(valu.Commerce, undefined);
  assert.equal(valu.AiGuru, undefined);
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

  // The postMessage bridge is not a service transport. It could carry these
  // calls — the application answers `api:service-intent` — and that is exactly
  // the ambiguity this package dropped: a service function runs over a
  // connection, the same way everywhere, or it is not a service function.
  const bridge = new PostMessageTransport({ target: new FakeWindow() });
  assert.throws(() => createValuServices({ transport: bridge }), /does not serve service functions/);
  assert.throws(() => new ServiceClient({ transport: bridge }), /does not serve service functions/);

  assert.throws(() => createValuServices({}), /needs a socket/);
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
