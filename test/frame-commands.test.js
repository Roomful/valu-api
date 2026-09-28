// Phase 2d — the fifteen host-bound intents as a named API. The wire is
// unchanged (`api:service-intent`), which these tests assert directly: if the
// frame API and the old bridge traffic ever disagree, this file fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FrameCommands, FRAME_COMMANDS, FRAME_COMMAND_KINDS, frameCommandKind } from '../src/frame/FrameCommands.js';
import { PostMessageTransport } from '../src/transport/PostMessageTransport.js';
import { SocketTransport } from '../src/transport/SocketTransport.js';
import { listDescriptors } from '../src/services/descriptors.js';
import { ERROR_CODES } from '../src/Errors.js';
import { FakeWindow, FakeRoomfulConnection, Responder } from './helpers/fakes.js';
import { NodeSocketAdapter } from '../src/socket/NodeSocketAdapter.js';

/** A connected bridge, plus the window that carries it. */
function bridge() {
  const window = new FakeWindow();
  const transport = new PostMessageTransport({ target: window });
  window.ready();
  return { window, transport, frame: new FrameCommands(transport) };
}

/** Answer the last posted request as the host would. */
function reply(window, message) {
  const posted = window.lastPost();
  window.deliver({ name: 'api:run-completed', message, requestId: posted.message.requestId });
}

test('the fifteen are exactly the host-bound descriptors', () => {
  const declared = listDescriptors({ binding: 'host' }).map((d) => d.key).sort();
  assert.equal(FRAME_COMMANDS.length, 15);
  assert.deepEqual([...FRAME_COMMANDS].sort(), declared);
});

test('every frame command is classified, and only once', () => {
  const seen = new Set();
  for (const [kind, keys] of Object.entries(FRAME_COMMAND_KINDS)) {
    for (const key of keys) {
      assert.equal(seen.has(key), false, `${key} is in two kinds`);
      seen.add(key);
      assert.equal(frameCommandKind(key), kind);
    }
  }
  assert.equal(frameCommandKind('Users.get'), undefined, 'a service function is not a frame command');
});

test('a frame command is the SAME bridge message a service intent has always been', async () => {
  const { window, frame } = bridge();

  const pending = frame.openApplication('cart');
  const posted = window.lastPost();

  assert.equal(posted.name, 'api:service-intent');
  assert.equal(posted.message.applicationId, 'AiGuru');
  assert.equal(posted.message.action, 'open');
  assert.deepEqual(posted.message.params, { applicationId: 'cart' });

  reply(window, { opened: true });
  const ack = await pending;
  assert.deepEqual(ack.data, { opened: true });
});

test('a picker carries the params the manifest declares', async () => {
  const { window, frame } = bridge();

  const pending = frame.pickSingle({ providers: ['contacts'], title: 'Pick one', width: 400 });
  assert.deepEqual(window.lastPost().message.params, {
    providers: ['contacts'], title: 'Pick one', width: 400, height: undefined,
  });

  reply(window, { picked: { id: 'u-1' } });
  assert.deepEqual((await pending).data, { picked: { id: 'u-1' } });
});

test('a host refusal becomes an error ack, not a rejection', async () => {
  const { window, frame } = bridge();

  const pending = frame.closeSelf();
  reply(window, { error: { code: 403, message: 'not your application' } });

  const ack = await pending;
  assert.equal(ack.error.code, 403);
  assert.equal(ack.error.status, true);
});

test('a string error is an error ack too', async () => {
  const { window, frame } = bridge();
  const pending = frame.getLogs('text');
  reply(window, { error: 'no log buffer' });
  assert.equal((await pending).error.message, 'no log buffer');
});

test('a service function is refused — the mirror of the socket refusing a host intent', async () => {
  const { frame } = bridge();

  const ack = await frame.run('Users.get', { userId: 'u-1' });

  assert.equal(ack.error.code, ERROR_CODES.UNSUPPORTED);
  assert.match(ack.error.message, /not a frame command/);
});

test('an unknown name is 404', async () => {
  const { frame } = bridge();
  assert.equal((await frame.run('Nope.nope')).error.code, ERROR_CODES.UNKNOWN_FUNCTION);
});

test('before api:ready a frame command is 503, not a TypeError', async () => {
  const window = new FakeWindow();
  const frame = new FrameCommands(new PostMessageTransport({ target: window }));

  const ack = await frame.closeAll();

  assert.equal(ack.error.code, ERROR_CODES.DISCONNECTED);
  assert.equal(window.posted.length, 0);
});

test('a socket transport cannot be a frame — refused at construction', () => {
  const socket = new NodeSocketAdapter({ connection: new FakeRoomfulConnection(new Responder()) });
  const transport = new SocketTransport({ socket });
  assert.throws(() => new FrameCommands(transport), /speaks the host bridge; SocketTransport does not/);
});

test('every frame command reaches the bridge under its own declared name', async () => {
  const { window, frame } = bridge();
  const calls = [
    ['AiGuru.open', () => frame.openApplication('x')],
    ['AiGuru.close', () => frame.closeApplication('x')],
    ['AiGuru.has-application', () => frame.hasApplication('x')],
    ['AiGuru.is-application-loaded', () => frame.isApplicationLoaded('x')],
    ['AiGuru.get-applications', () => frame.getApplications()],
    ['Application.expand-application', () => frame.expandSelf()],
    ['Application.close-application', () => frame.closeSelf()],
    ['Application.close_all', () => frame.closeAll()],
    ['DataProvider.pick-single', () => frame.pickSingle({ providers: ['contacts'] })],
    ['DataProvider.pick-multiple', () => frame.pickMultiple({ providers: ['contacts'] })],
    ['Commerce.open-cart', () => frame.openCart()],
    ['Commerce.open-purchases', () => frame.openPurchases()],
    ['Commerce.open-products', () => frame.openProducts()],
    ['Application.get-identity-token', () => frame.getIdentityToken()],
    ['Logging.get-logs', () => frame.getLogs()],
  ];
  assert.equal(calls.length, 15, 'one method per frame command');

  for (const [key, call] of calls) {
    const pending = call();
    const posted = window.lastPost();
    const [service, action] = [key.slice(0, key.indexOf('.')), key.slice(key.indexOf('.') + 1)];
    assert.equal(posted.message.applicationId, service, key);
    assert.equal(posted.message.action, action, key);
    reply(window, {});
    await pending;
  }
});
