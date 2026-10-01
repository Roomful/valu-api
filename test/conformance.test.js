// The one suite, run against all three adapters. Same script, same assertions.
//
// The third entry is the whole cost of shipping a new adapter
// (docs/socket-adapters.md "Writing a third adapter"), and it is what says the
// socket this package opens itself answers the same 65 functions, the same way,
// as the two connections it is handed.
import { BrowserSocketAdapter } from '../src/socket/BrowserSocketAdapter.js';
import { NodeSocketAdapter } from '../src/socket/NodeSocketAdapter.js';
import { SocketIoSocketAdapter } from '../src/socket/SocketIoSocketAdapter.js';
import { FakeWebSocketService, FakeRoomfulConnection, FakeIoSocket } from './helpers/fakes.js';
import { runConformanceSuite, runPushSuite } from './conformance/suite.js';
import { runFunctionSuite } from './conformance/functions.js';

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
