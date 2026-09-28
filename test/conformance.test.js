// The one suite, run against both adapters. Same script, same assertions.
import { BrowserSocketAdapter } from '../src/socket/BrowserSocketAdapter.js';
import { NodeSocketAdapter } from '../src/socket/NodeSocketAdapter.js';
import { FakeWebSocketService, FakeRoomfulConnection } from './helpers/fakes.js';
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

runFunctionSuite({ name: 'browser adapter', makeSocket: browserSocket });
runFunctionSuite({ name: 'node adapter', makeSocket: nodeSocket });
