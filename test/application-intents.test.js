// ===========================================================================
// Application intents — one dynamic call, and no methods to go stale.
//
// This file replaces test/frame-commands.test.js, which asserted fifteen
// hand-written methods. The wire is what survived that change and these tests
// pin it: `api:service-intent`, the same message the fifteen methods sent and
// the same one `ServiceClient` sends over the bridge. If the intent path and
// the old frame traffic ever disagree, this file fails.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApplicationIntents, parseIntentName } from '../src/intents/ApplicationIntents.js';
import { PostMessageTransport } from '../src/transport/PostMessageTransport.js';
import { SocketTransport } from '../src/transport/SocketTransport.js';
import { listDescriptors, APPLICATION_INTENTS } from '../src/services/descriptors.js';
import { ERROR_CODES } from '../src/Errors.js';
import { FakeWindow, FakeRoomfulConnection, Responder } from './helpers/fakes.js';
import { NodeSocketAdapter } from '../src/socket/NodeSocketAdapter.js';

/** A connected bridge, plus the window that carries it. */
function bridge() {
  const window = new FakeWindow();
  const transport = new PostMessageTransport({ target: window });
  window.ready();
  return { window, transport, intents: new ApplicationIntents(transport) };
}

/** Answer the last posted request as the Valu Social application would. */
function reply(window, message) {
  const posted = window.lastPost();
  window.deliver({ name: 'api:run-completed', message, requestId: posted.message.requestId });
}

test('the exclusive list is exactly the postMessage-bound descriptors', () => {
  const declared = listDescriptors({ binding: 'postmessage' }).map((d) => d.key).sort();
  assert.equal(APPLICATION_INTENTS.length, 15);
  assert.deepEqual(ApplicationIntents.exclusive().map((d) => d.key).sort(), declared);
});

test('list() is what the application declares — and only that', () => {
  const listed = ApplicationIntents.list();
  assert.equal(listed.length, 92, 'the manifest\'s 92, bridge-servable every one');
  // A function this package declares itself is not something the application
  // knows how to answer, so it is not on this list.
  assert.equal(listed.some((d) => d.declaredBy === 'sdk'), false);
  assert.equal(listed.some((d) => d.key === 'Users.list-connection-requests'), false);
  // And the catalogue is still there to read an intent's params off.
  assert.equal(ApplicationIntents.describe('DataProvider.pick-single').params.optional.length > 0, true);
  assert.equal(ApplicationIntents.describe('Nope.nope'), undefined);
});

test('a declared intent is the SAME bridge message it has always been', async () => {
  const { window, intents } = bridge();

  const pending = intents.run('AiGuru.open', { applicationId: 'cart' });
  const posted = window.lastPost();

  assert.equal(posted.name, 'api:service-intent');
  assert.equal(posted.message.applicationId, 'AiGuru');
  assert.equal(posted.message.action, 'open');
  assert.deepEqual(posted.message.params, { applicationId: 'cart' });

  reply(window, { opened: true });
  assert.deepEqual((await pending).data, { opened: true });
});

test('the name forms the platform uses all resolve to the declared action', async () => {
  const { window, intents } = bridge();

  for (const name of [
    'Application.close-application', 'Application.close_application',
    'Application.closeApplication', 'service__Application__close_application',
  ]) {
    const pending = intents.run(name);
    const { message } = window.lastPost();
    assert.equal(message.applicationId, 'Application', name);
    assert.equal(message.action, 'close-application', name);
    reply(window, {});
    await pending;
  }
});

test('an intent this package has never heard of is posted as written', async () => {
  const { window, intents } = bridge();

  // The reason there is no method per intent: the application registers them
  // at runtime, and a method here would be a copy of a list that moves.
  const pending = intents.run('Weather.forecast-tomorrow', { city: 'Kyiv' });
  const { message } = window.lastPost();
  assert.equal(message.applicationId, 'Weather');
  assert.equal(message.action, 'forecast-tomorrow');

  reply(window, { c: 21 });
  assert.deepEqual((await pending).data, { c: 21 });
});

test('a service function may be run as an intent — the application serves those too', async () => {
  const { window, intents } = bridge();

  // No refusal: over the bridge this is exactly what the application answers.
  // What the caller gives up by taking this path is the validation, the cache
  // and the retry policy — not the answer.
  const pending = intents.run('Users.get', { userId: 'u-1' });
  assert.equal(window.lastPost().message.action, 'get');

  reply(window, { user: { id: 'u-1' } });
  assert.deepEqual((await pending).data, { user: { id: 'u-1' } });
});

test('a name with no service part is 404, and never reaches the bridge', async () => {
  const { window, intents } = bridge();
  const ack = await intents.run('closeEverything');
  assert.equal(ack.error.code, ERROR_CODES.UNKNOWN_FUNCTION);
  assert.equal(window.posted.length, 0);
  assert.equal(parseIntentName('closeEverything'), undefined);
});

test('an application refusal becomes an error ack, not a rejection', async () => {
  const { window, intents } = bridge();

  const pending = intents.run('Application.close-application');
  reply(window, { error: { code: 403, message: 'not your application' } });

  const ack = await pending;
  assert.equal(ack.error.code, 403);
  assert.equal(ack.error.status, true);
});

test('a string error is an error ack too', async () => {
  const { window, intents } = bridge();
  const pending = intents.run('Logging.get-logs', { format: 'text' });
  reply(window, { error: 'no log buffer' });
  assert.equal((await pending).error.message, 'no log buffer');
});

test('before api:ready an intent is 503, not a TypeError', async () => {
  const window = new FakeWindow();
  const intents = new ApplicationIntents(new PostMessageTransport({ target: window }));

  const ack = await intents.run('Application.close_all');

  assert.equal(ack.error.code, ERROR_CODES.DISCONNECTED);
  assert.equal(window.posted.length, 0);
});

test('a socket transport has no application to ask — refused at construction', () => {
  const socket = new NodeSocketAdapter({ connection: new FakeRoomfulConnection(new Responder()) });
  const transport = new SocketTransport({ socket });
  assert.throws(
    () => new ApplicationIntents(transport),
    /speaks the postMessage bridge; SocketTransport does not/,
  );
});

test('every exclusive intent reaches the bridge under its own declared name', async () => {
  const { window, intents } = bridge();

  for (const descriptor of ApplicationIntents.exclusive()) {
    const pending = intents.run(descriptor.key);
    const { message } = window.lastPost();
    assert.equal(message.applicationId, descriptor.service, descriptor.key);
    assert.equal(message.action, descriptor.action, descriptor.key);
    reply(window, {});
    await pending;
  }
});
