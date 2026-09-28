// The two adapters, where they differ from each other rather than where they
// agree — the agreement is what test/conformance.test.js is for.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BrowserSocketAdapter } from '../src/socket/BrowserSocketAdapter.js';
import { NodeSocketAdapter } from '../src/socket/NodeSocketAdapter.js';
import { isAckError, unwrapAck, normalizeAck } from '../src/socket/ValuSocket.js';
import { SocketTransport } from '../src/transport/SocketTransport.js';
import { ERROR_CODES } from '../src/Errors.js';
import { Responder, FakeWebSocketService, FakeRoomfulConnection } from './helpers/fakes.js';

test('an adapter needs the transport it adapts', () => {
  assert.throws(() => new BrowserSocketAdapter({ socket: {} }), /emitAsync/);
  assert.throws(() => new NodeSocketAdapter({ connection: {} }), /emit\(\)/);
  assert.throws(() => new SocketTransport({}), /needs a ValuSocket/);
});

test('the browser adapter turns a rejection into an ack', async () => {
  const responder = new Responder({ 'x:y': 'timeout', 'a:b': 'disconnect' });
  const socket = new BrowserSocketAdapter({
    socket: new FakeWebSocketService(responder), userId: 'u-1',
  });

  assert.equal((await socket.emit('x:y')).error.code, ERROR_CODES.TIMEOUT);
  assert.equal((await socket.emit('a:b')).error.code, ERROR_CODES.DISCONNECTED);
});

test('the node adapter fills in the code its connection does not set', async () => {
  const responder = new Responder({ 'x:y': 'timeout', 'a:b': 'disconnect' });
  const socket = new NodeSocketAdapter({ connection: new FakeRoomfulConnection(responder) });

  assert.equal((await socket.emit('x:y')).error.code, ERROR_CODES.TIMEOUT);
  assert.equal((await socket.emit('a:b')).error.code, ERROR_CODES.DISCONNECTED);
});

test('a connection that throws anyway still answers in the envelope', async () => {
  const socket = new NodeSocketAdapter({
    connection: { userId: 'u-1', emit: async () => { throw new Error('half torn down'); } },
  });

  const ack = await socket.emit('x:y');
  assert.equal(ack.error.code, ERROR_CODES.DISCONNECTED);
  assert.match(ack.error.message, /half torn down/);
});

test('the node adapter republishes the raw connection as underlying', () => {
  const connection = new FakeRoomfulConnection(new Responder());
  assert.equal(new NodeSocketAdapter({ connection }).underlying, connection);

  const wrapper = { userId: 'u-1', emit: async () => ({}), underlying: connection };
  assert.equal(new NodeSocketAdapter({ connection: wrapper }).underlying, connection,
    'a wrapper and the raw connection must key the same per-connection state');
});

test('push is optional, and a transport says which it is', () => {
  const responder = new Responder();
  const withPush = new SocketTransport({
    socket: new NodeSocketAdapter({ connection: new FakeRoomfulConnection(responder) }),
  });
  const withoutPush = new SocketTransport({
    socket: new BrowserSocketAdapter({ socket: new FakeWebSocketService(responder), userId: 'u-1' }),
  });

  assert.equal(withPush.supportsPush, true);
  assert.equal(withoutPush.supportsPush, false, 'no push hook means the consumer must poll');
});

test('selfUserId falls back to the credentialed user, and stays null when unknown', () => {
  const responder = new Responder();
  assert.equal(
    new BrowserSocketAdapter({ socket: new FakeWebSocketService(responder), userId: 'u-1' }).selfUserId,
    'u-1',
  );
  assert.equal(
    new NodeSocketAdapter({ connection: { userId: 'u-1', emit: async () => ({}) } }).selfUserId,
    null,
    'the headless connection resolves self from user_info; null until it has',
  );
});

test('normalizeAck leaves a good ack alone and completes a bad one', () => {
  assert.deepEqual(normalizeAck({ data: 1 }), { data: 1 });
  assert.deepEqual(normalizeAck(undefined), {});
  assert.deepEqual(normalizeAck({ error: { message: 'boom' } }).error, { status: true, message: 'boom' });
  assert.equal(normalizeAck({ error: { message: 'emit x timed out' } }).error.code, ERROR_CODES.TIMEOUT);
  assert.equal(normalizeAck({ error: { code: 404, message: 'timed out' } }).error.code, 404,
    'a code the transport set is never overwritten');
});

test('isAckError treats a bare error as a failure, and status:false as not one', () => {
  assert.equal(isAckError({ error: { message: 'x' } }), true);
  assert.equal(isAckError({ error: { status: false } }), false);
  assert.equal(isAckError({ data: null }), false);
  assert.equal(isAckError(undefined), false);
});

test('unwrapAck returns data or throws with the call named on it', () => {
  assert.equal(unwrapAck({ data: 7 }), 7);
  assert.throws(
    () => unwrapAck({ error: { status: true, code: 404, description: 'gone' } }, { service: 'Users', fn: 'get' }),
    (error) => error.name === 'ValuServiceError' && error.service === 'Users' && error.fn === 'get'
      && error.message === 'gone' && error.code === 404,
  );
});

test('a socket transport refuses to serve the bridge', async () => {
  const transport = new SocketTransport({
    socket: new NodeSocketAdapter({ connection: new FakeRoomfulConnection(new Responder()) }),
  });

  await assert.rejects(() => transport.request('api:run', {}), /does not support bridge requests/);
  assert.throws(() => transport.notify('api:run-command', {}), /does not support bridge messages/);
});

test('a handler that throws does not take the caller down', async () => {
  const { ServiceRegistry } = await import('../src/services/registry.js');
  const registry = new ServiceRegistry().define('Users.get', async () => { throw new Error('boom'); });
  const transport = new SocketTransport({
    socket: new NodeSocketAdapter({ connection: new FakeRoomfulConnection(new Responder()) }),
    registry,
  });
  const { findDescriptor } = await import('../src/services/descriptors.js');

  const ack = await transport.callService(findDescriptor('Users.get'), { userId: 'u-1' });

  assert.equal(ack.error.code, ERROR_CODES.DISCONNECTED);
  assert.match(ack.error.message, /Users\.get threw: boom/);
});

test('a closed socket transport answers 503', async () => {
  const { findDescriptor } = await import('../src/services/descriptors.js');
  const transport = new SocketTransport({
    socket: new NodeSocketAdapter({ connection: new FakeRoomfulConnection(new Responder()) }),
  });

  await transport.close();

  assert.equal(transport.connected, false);
  assert.equal((await transport.callService(findDescriptor('Users.get'), { userId: 'u-1' })).error.code, 503);
});
