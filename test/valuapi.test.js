// ===========================================================================
// Wire parity.
//
// The transport extraction is only safe if the bridge traffic is unchanged.
// Every assertion here is against the exact `{name, message}` the old ValuApi
// posted — if one of these fails, the refactor moved something it should not
// have.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ValuApi } from '../src/ValuApi.js';
import { Intent } from '../src/Intent.js';
import { PostMessageTransport } from '../src/transport/PostMessageTransport.js';
import { FakeWindow } from './helpers/fakes.js';

const setup = () => {
  const target = new FakeWindow();
  const api = new ValuApi({ transport: new PostMessageTransport({ target }) });
  return { api, target };
};

test('connected is false until api:ready, true after', () => {
  const { api, target } = setup();
  assert.equal(api.connected, false);
  target.ready();
  assert.equal(api.connected, true);
});

test('api:ready emits API_READY and delivers onCreate with the launch intent', () => {
  const { api, target } = setup();
  const order = [];
  api.addEventListener(ValuApi.API_READY, () => order.push('event'));
  api.setApplication({
    onCreate: async (intent) => { order.push(`create:${intent.applicationId}:${intent.action}`); },
  });

  target.ready({ applicationId: 'app-7', action: 'view', params: { roomId: '1' } });

  assert.deepEqual(order, ['event', 'create:app-7:view']);
});

test('setApplication after api:ready replays the launch intent', () => {
  const { api, target } = setup();
  target.ready({ applicationId: 'app-7' });

  const seen = [];
  api.setApplication({ onCreate: async (intent) => { seen.push(intent.applicationId); } });

  assert.deepEqual(seen, ['app-7']);
});

test('api:new-intent reaches onNewIntent', () => {
  const { api, target } = setup();
  const seen = [];
  api.setApplication({ onCreate: async () => {}, onNewIntent: async (intent) => seen.push(intent.action) });
  target.ready();

  target.deliver({ name: 'api:new-intent', message: { applicationId: 'app-1', action: 'view', params: {} } });

  assert.deepEqual(seen, ['view']);
});

test('api:trigger on_route emits ON_ROUTE and updates the router context', () => {
  const { api, target } = setup();
  const seen = [];
  api.addEventListener(ValuApi.ON_ROUTE, (data) => seen.push(`event:${data}`));
  api.setApplication({ onCreate: async () => {}, onUpdateRouterContext: (data) => seen.push(`app:${data}`) });
  target.ready();

  target.deliver({ name: 'api:trigger', message: { action: 'on_route', data: '/rooms/1' } });

  assert.deepEqual(seen, ['event:/rooms/1', 'app:/rooms/1']);
});

test('messages not addressed to valuApi are ignored', () => {
  const { api, target } = setup();
  target.deliver({ target: 'somethingElse', name: 'api:ready', message: { applicationId: 'x' } });
  assert.equal(api.connected, false);
});

test('getApi posts api:create-pointer and binds the returned version', async () => {
  const { api, target } = setup();
  target.ready();

  const pending = api.getApi('users', 2);
  const posted = target.lastPost();

  assert.equal(posted.name, 'api:create-pointer');
  assert.equal(posted.message.api, 'users');
  assert.equal(posted.message.version, 2);
  assert.equal(typeof posted.message.guid, 'string');
  assert.equal(typeof posted.message.requestId, 'number');
  assert.equal(posted.origin, 'https://valu.test');

  target.deliver({ name: 'api:pointer-created', message: { version: 2 }, requestId: posted.message.requestId });

  const pointer = await pending;
  assert.equal(pointer.apiName, 'users');
  assert.equal(pointer.version, 2);
  assert.equal(pointer.guid, posted.message.guid);
});

test('getApi rejects when the Valu Social app refuses the pointer', async () => {
  const { api, target } = setup();
  target.ready();

  const pending = api.getApi('nope');
  const { requestId } = target.lastPost().message;
  target.deliver({ name: 'api:pointer-created', message: { error: 'no such api' }, requestId });

  await assert.rejects(() => pending, /no such api/);
});

test('pointer.run posts api:run and resolves the application result', async () => {
  const { api, target } = setup();
  target.ready();

  const pending = api.getApi('users');
  const create = target.lastPost().message;
  target.deliver({ name: 'api:pointer-created', message: { version: 1 }, requestId: create.requestId });
  const pointer = await pending;

  const run = pointer.run('current', { id: 'u-1' });
  const posted = target.lastPost();

  assert.equal(posted.name, 'api:run');
  assert.deepEqual(posted.message, {
    apiPointerId: create.guid,
    functionName: 'current',
    params: { id: 'u-1' },
    requestId: posted.message.requestId,
  });

  target.deliver({ name: 'api:run-completed', message: { id: 'u-1' }, requestId: posted.message.requestId });
  assert.deepEqual(await run, { id: 'u-1' });
});

test('pointer.run rejects on an error result', async () => {
  const { api, target } = setup();
  target.ready();
  const pending = api.getApi('users');
  const create = target.lastPost().message;
  target.deliver({ name: 'api:pointer-created', message: { version: 1 }, requestId: create.requestId });
  const pointer = await pending;

  const run = pointer.run('current');
  const { requestId } = target.lastPost().message;
  target.deliver({ name: 'api:run-completed', message: { error: 'nope' }, requestId });

  await assert.rejects(() => run, (error) => error === 'nope');
});

test('sendIntent posts api:run-intent and resolves the reply', async () => {
  const { api, target } = setup();
  target.ready();

  const pending = api.sendIntent(new Intent('chatApp', Intent.ACTION_OPEN, { roomId: '1234' }));
  const posted = target.lastPost();

  assert.equal(posted.name, 'api:run-intent');
  assert.deepEqual(posted.message, {
    applicationId: 'chatApp',
    action: 'open',
    params: { roomId: '1234' },
    requestId: posted.message.requestId,
  });

  // The application answers api:run-intent with api:run-completed. It used to be
  // routed as if the reply belonged to an APIPointer, so the promise never
  // settled; correlation is by requestId now, so it does.
  target.deliver({ name: 'api:run-completed', message: { ok: true }, requestId: posted.message.requestId });
  assert.deepEqual(await pending, { ok: true });
});

test('callService posts api:service-intent and resolves the raw result', async () => {
  const { api, target } = setup();
  target.ready();

  const pending = api.callService(new Intent('CMS', 'resource-upload', { name: 'a.png' }));
  const posted = target.lastPost();

  assert.equal(posted.name, 'api:service-intent');
  assert.deepEqual(posted.message, {
    applicationId: 'CMS',
    action: 'resource-upload',
    params: { name: 'a.png' },
    requestId: posted.message.requestId,
  });

  target.deliver({ name: 'api:run-console-completed', message: { id: 'r-1' }, requestId: posted.message.requestId });
  assert.deepEqual(await pending, { id: 'r-1' });
});

test('runConsoleCommand posts api:run-console', async () => {
  const { api, target } = setup();
  target.ready();

  const pending = api.runConsoleCommand('/chat -h');
  const posted = target.lastPost();

  assert.equal(posted.name, 'api:run-console');
  assert.equal(posted.message.command, '/chat -h');

  target.deliver({ name: 'api:run-console-completed', message: 'help text', requestId: posted.message.requestId });
  assert.equal(await pending, 'help text');
});

test('pushRoute and replaceRoute post api:run-command with no requestId', () => {
  const { api, target } = setup();
  target.ready();

  api.pushRoute('/a');
  assert.deepEqual(target.lastPost(), {
    name: 'api:run-command',
    message: { command: 'pushRoute', data: '/a' },
    origin: 'https://valu.test',
  });

  api.replaceRoute('/b');
  assert.deepEqual(target.lastPost().message, { command: 'replaceRoute', data: '/b' });
});

test('posting before api:ready rejects with a message that says why', async () => {
  const { api } = setup();
  await assert.rejects(() => api.runConsoleCommand('/x'), /has not sent api:ready/);
});

test('api.services is the function surface over this instance\'s transport', async () => {
  const { api, target } = setup();
  target.ready();

  assert.equal(api.services.transport, api.transport);
  assert.equal(api.services, api.services, 'one surface per api instance');

  // Both ways of saying it are the same call: the name resolved early, or late.
  for (const call of [
    () => api.services.call('Users.current', {}),
    () => api.services.Users.current(),
  ]) {
    const pending = call();
    const posted = target.lastPost();
    assert.equal(posted.name, 'api:service-intent');
    assert.equal(posted.message.applicationId, 'Users');
    assert.equal(posted.message.action, 'current');

    target.deliver({ name: 'api:run-console-completed', message: { user: { id: 'u-1' } }, requestId: posted.message.requestId });
    assert.deepEqual((await pending).data, { user: { id: 'u-1' } });
  }
});

test('an application intent is not on the function surface, even over the bridge', async () => {
  const { api, target } = setup();
  target.ready();

  // The application WOULD answer this one — it is the transport that can. It is
  // refused anyway, because a function on `services` is a promise the SDK can
  // run it anywhere, and nothing here can open a picker.
  const ack = await api.services.call('DataProvider.pick-single', { providers: ['contacts'] });

  assert.equal(ack.error.code, 501);
  assert.match(ack.error.message, /is an application intent, not a service function/);
  assert.match(ack.error.description, /intents\.run/);
  assert.equal(target.posted.length, 0, 'nothing reached the bridge');
});

test('api.intents runs one by name, with the same message on the wire', async () => {
  const { api, target } = setup();
  target.ready();

  const pending = api.intents.run('DataProvider.pick-single', { providers: ['contacts'] });
  const posted = target.lastPost();
  assert.equal(posted.name, 'api:service-intent');
  assert.equal(posted.message.applicationId, 'DataProvider');
  assert.equal(posted.message.action, 'pick-single');

  target.deliver({ name: 'api:run-console-completed', message: { error: 'user cancelled' }, requestId: posted.message.requestId });
  const ack = await pending;
  assert.equal(ack.error.status, true);
  assert.equal(ack.error.message, 'user cancelled');
});

test('api.intents runs an intent this package has never heard of', async () => {
  const { api, target } = setup();
  target.ready();

  // The whole reason there is no method per intent: the application registers
  // them at runtime and may know names newer than this release.
  const pending = api.intents.run('Weather.forecast-tomorrow', { city: 'Kyiv' });
  const posted = target.lastPost();
  assert.equal(posted.message.applicationId, 'Weather');
  assert.equal(posted.message.action, 'forecast-tomorrow');

  target.deliver({ name: 'api:run-console-completed', message: { c: 21 }, requestId: posted.message.requestId });
  assert.deepEqual((await pending).data, { c: 21 });
});

test('a call made before api:ready resolves 503 rather than throwing', async () => {
  const { api } = setup();
  const ack = await api.services.call('Users.current', {});
  assert.equal(ack.error.code, 503);
});

test('close() releases the window listener and fails what was in flight', async () => {
  const { api, target } = setup();
  target.ready();
  const pending = api.runConsoleCommand('/x');

  await api.transport.close();

  await assert.rejects(() => pending, /transport closed/);
  assert.equal(target.listeners.size, 0);
});
