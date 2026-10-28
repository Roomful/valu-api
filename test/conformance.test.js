// The one suite, run against all three socket adapters and the host. Same
// script, same assertions.
//
// The third entry is the whole cost of shipping a new adapter
// (docs/socket-adapters.md "Writing a third adapter"), and it is what says the
// socket this package opens itself answers the same 65 functions, the same way,
// as the two connections it is handed. The host entries (the end of this file)
// say the same of an app that holds no connection at all: its calls travel to
// a real HostBridge, which serves them over a real MasterConnection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSocketAdapter } from '../src/socket/BrowserSocketAdapter.js';
import { NodeSocketAdapter } from '../src/socket/NodeSocketAdapter.js';
import { SocketIoSocketAdapter } from '../src/socket/SocketIoSocketAdapter.js';
import { ServiceRegistry } from '../src/services/registry.js';
import { registerAll } from '../src/services/impl/index.js';
import { FakeWebSocketService, FakeRoomfulConnection, FakeIoSocket, Responder } from './helpers/fakes.js';
import { runConformanceSuite, runPushSuite } from './conformance/suite.js';
import { CASES, runFunctionSuite } from './conformance/functions.js';
import { hostRefuses, makeDroppingHostServices, makeHostServices } from './conformance/host-adapter.js';
import { makeEmbeddedServices } from './conformance/embedded-adapter.js';

runConformanceSuite({
  name: 'browser adapter',
  makeSocket: (responder) => {
    const service = new FakeWebSocketService(responder);
    const handlers = new Set();
    return {
      socket: new BrowserSocketAdapter({
        socket: service,
        userId: 'user-1',
        networkId: 'roomful',
        onResourceUpdated: (handler) => {
          handlers.add(handler);
          return () => handlers.delete(handler);
        },
      }),
      push: (payload) => handlers.forEach((handler) => handler(payload)),
    };
  },
});

runConformanceSuite({
  name: 'node adapter',
  makeSocket: (responder) => {
    const connection = new FakeRoomfulConnection(responder);
    return {
      socket: new NodeSocketAdapter({ connection }),
      push: (payload) => connection.pushResourceUpdated(payload),
    };
  },
});

runConformanceSuite({
  name: 'socket.io adapter',
  makeSocket: (responder) => {
    const socket = new FakeIoSocket(responder).connect();
    return {
      socket: new SocketIoSocketAdapter({ socket, userId: 'user-1' }),
      push: (payload) => socket.push('resource:updated', payload),
    };
  },
});

runPushSuite({
  name: 'browser adapter',
  makeSocket: (responder) => {
    const service = new FakeWebSocketService(responder);
    const handlers = new Set();
    return {
      socket: new BrowserSocketAdapter({
        socket: service,
        userId: 'user-1',
        onResourceUpdated: (handler) => {
          handlers.add(handler);
          return () => handlers.delete(handler);
        },
      }),
      push: (payload) => handlers.forEach((handler) => handler(payload)),
    };
  },
});

runPushSuite({
  name: 'node adapter',
  makeSocket: (responder) => {
    const connection = new FakeRoomfulConnection(responder);
    return {
      socket: new NodeSocketAdapter({ connection }),
      push: (payload) => connection.pushResourceUpdated(payload),
    };
  },
});

runPushSuite({
  name: 'socket.io adapter',
  makeSocket: (responder) => {
    const socket = new FakeIoSocket(responder).connect();
    return {
      socket: new SocketIoSocketAdapter({ socket, userId: 'user-1' }),
      push: (payload) => socket.push('resource:updated', payload),
    };
  },
});

// --- Phase 2: the per-function suite, the same table against both adapters ---

const browserSocket = (responder) => ({
  socket: new BrowserSocketAdapter({
    socket: new FakeWebSocketService(responder),
    userId: 'user-1',
    networkId: 'roomful',
  }),
});

const nodeSocket = (responder) => ({
  socket: new NodeSocketAdapter({ connection: new FakeRoomfulConnection(responder) }),
});

const socketIoSocket = (responder) => ({
  socket: new SocketIoSocketAdapter({
    socket: new FakeIoSocket(responder).connect(),
    userId: 'user-1',
  }),
});

runFunctionSuite({ name: 'browser adapter', makeSocket: browserSocket });
runFunctionSuite({ name: 'node adapter', makeSocket: nodeSocket });
runFunctionSuite({ name: 'socket.io adapter', makeSocket: socketIoSocket });

// --- The host: the same suites through a HostBridge --------------------------
//
// No `runPushSuite` entry: the host does not push `resource:updated` in the
// core, so there is no push for it to assert (see host-adapter.js).

runConformanceSuite({ name: 'host adapter', makeServices: makeHostServices });

runFunctionSuite({
  name: 'host adapter',
  makeServices: makeHostServices,
  // What the host answers for a function it will not run: see host-adapter.js.
  expectRefused: hostRefuses,
});

// The same table with the master's socket down when each case starts, so the
// first call of every case is held by the connection and answered when it is
// back. (Not the clause suite: its reconnect clauses count the `reconnected`
// events a subscriber sees, and an outage is one more.)
//
// The outage tests nothing for the cases that never ask the master anything,
// and they pass without it: the 16 the host refuses by design (`hostRefuses`:
// answered before the function runs) and the 3 the function itself refuses
// before any wire call. That leaves 67 of the 86 cases held across the outage,
// which the adapter checks (it fails a case whose outage ended with no call
// waiting on it).
runFunctionSuite({
  name: 'host adapter, dropping',
  makeServices: makeDroppingHostServices,
  expectRefused: hostRefuses,
});

// --- Embedded: the same table through Valu Social's frame server ------------
//
// An app built with createValuApp() inside a Valu Social frame: every function
// answers exactly as it does over a socket of its own, with nothing refused
// (no permission tiers inside Valu Social; `local` runs in the page; Valu Social
// hands its frame server the app state). See embedded-adapter.js.

runFunctionSuite({ name: 'embedded adapter', makeServices: makeEmbeddedServices });

// Two things the entries above cannot say about themselves.

const hostOptions = () => ({ cache: null, registry: registerAll(new ServiceRegistry()) });

test('host adapter, dropping: the first call waits out the outage on the master and is answered when it is back', async (t) => {
  const responder = new Responder({ 'social:getUsersSimpleInfo': { data: { users: [{ id: 'u-9' }] } } });
  const host = await makeDroppingHostServices(responder, hostOptions());
  t.after(() => host.close());

  const ack = await host.services.call('Users.get', { userId: 'u-9' }, { retries: 0 });

  assert.equal(ack.data.user.id, 'u-9');
  // At the moment the socket came back, the app's call was waiting and the
  // wire had seen nothing: the call was HELD, not retried and not sent early.
  assert.deepEqual(host.outage.atRecovery, { master: 'reconnecting', calls: 1, wire: 0 });
  assert.equal(responder.calls.length, 1);
});

test('host adapter: local, forbidden and application-state functions are refused by the host, for its own reasons', async (t) => {
  const responder = new Responder();
  const host = await makeHostServices(responder, hostOptions());
  t.after(() => host.close());
  const answer = (key) => host.services.call(key, CASES.find((c) => c.key === key).params, { retries: 0 });

  // The client runs `local` functions in the page; they are not the host's to serve.
  assert.deepEqual((await answer('Http.get')).error, { status: true, code: 501, message: 'not_available' });
  // Never allowed, never asked about.
  for (const key of ['Cbac.create-policy', 'VerusWallet.transfer']) {
    assert.deepEqual((await answer(key)).error, { status: true, code: 403, message: 'forbidden' }, key);
  }
  // The host holds no application state: refused by channel before the scope is weighed, so nobody is
  // asked to consent to VerusWallet.get-balance, and Developer.* answers 501 although its scopes are forbidden.
  for (const key of ['VerusWallet.get-balance', 'Developer.list-applications', 'Developer.create-application']) {
    assert.deepEqual((await answer(key)).error, { status: true, code: 501, message: 'not_available' }, key);
  }
  assert.equal(responder.calls.length, 0, 'none of them reached the master');
});
