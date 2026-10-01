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

test('a socket transport refuses to serve the postMessage bridge', async () => {
  const transport = new SocketTransport({
    socket: new NodeSocketAdapter({ connection: new FakeRoomfulConnection(new Responder()) }),
  });

  await assert.rejects(() => transport.request('api:run', {}), /does not support postMessage requests/);
  assert.throws(() => transport.notify('api:run-command', {}), /does not support postMessage messages/);
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

// ---------------------------------------------------------------------------
// docs/socket-adapters.md — the numbers and the claims, read back out of the
// code. The doc explains what an adapter IS, which is prose; but it counts
// functions, names error codes and promises that both adapters answer the same
// list, and all of that can rot silently.
// ---------------------------------------------------------------------------

test('the adapter reference still describes this package', async () => {
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync(new URL('../docs/socket-adapters.md', import.meta.url), 'utf8');
  const { catalogSummary } = await import('../src/services/descriptors.js');
  const { CASES } = await import('./conformance/functions.js');
  const summary = catalogSummary();

  // The headline count, and the socket count it rests on.
  assert.match(doc, new RegExp(`${summary.total} functions`));
  assert.equal(summary.socket, summary.roomful, 'one socket — the doc says so in three places');

  // The per-function table it points a third-adapter author at.
  assert.match(doc, new RegExp(`${CASES.length}-case per-function table`));

  // The two codes it names for the browser adapter's rejection conversion.
  assert.equal(ERROR_CODES.TIMEOUT, 408);
  assert.equal(ERROR_CODES.DISCONNECTED, 503);
  assert.match(doc, /`408`/);
  assert.match(doc, /`503`/);

  // Every member of the contract the doc tabulates is a member the shipped
  // adapters actually have, under that exact name.
  const responder = new Responder();
  const browser = new BrowserSocketAdapter({
    socket: new FakeWebSocketService(responder), userId: 'u-1',
    onResourceUpdated: () => () => {},
  });
  const node = new NodeSocketAdapter({ connection: new FakeRoomfulConnection(responder) });
  for (const socket of [browser, node]) {
    for (const member of ['emit', 'userId', 'networkId', 'selfUserId', 'onResourceUpdated']) {
      assert.notEqual(socket[member], undefined, member);
    }
  }
  assert.equal(browser.transport instanceof FakeWebSocketService, true, '.transport, as the table says');
  assert.ok(node.underlying, '.underlying, as the table says');
});

test('both adapters answer the catalogue, and neither one more than the other', async () => {
  // The doc's central promise: the function list does not depend on which
  // adapter is underneath. Asserted by dispatching every declared function
  // against both and comparing the REFUSALS — a function missing from one
  // transport would refuse there and not here.
  const { SERVICE_DESCRIPTORS, findDescriptor } = await import('../src/services/descriptors.js');
  const { serviceRegistry } = await import('../src/services/registry.js');
  await import('../src/services/impl/index.js');

  const unsupported = async (socket) => {
    const transport = new SocketTransport({ socket, registry: serviceRegistry });
    const refused = [];
    for (const d of SERVICE_DESCRIPTORS) {
      const ack = await transport.callService(d, {});
      if (ack.error?.code === ERROR_CODES.UNSUPPORTED) refused.push(d.key);
    }
    return refused;
  };

  const responder = new Responder();
  const viaBrowser = await unsupported(new BrowserSocketAdapter({
    socket: new FakeWebSocketService(responder), userId: 'u-1',
  }));
  const viaNode = await unsupported(new NodeSocketAdapter({
    connection: new FakeRoomfulConnection(responder),
  }));

  assert.deepEqual(viaBrowser, viaNode);
  // And what they refuse is application state, never a channel: with no
  // `appState` supplied, the only 501 a complete socket can produce is a
  // function whose answer was never on a connection in the first place.
  assert.ok(viaBrowser.length > 0, 'a sweep that refuses nothing is not testing the refusal');
  for (const key of viaBrowser) {
    assert.equal(findDescriptor(key).channel, 'app-state', key);
  }
});
