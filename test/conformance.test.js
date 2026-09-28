// The one suite, run against both adapters. Same script, same assertions.
import { BrowserSocketAdapter } from '../src/socket/BrowserSocketAdapter.js';
import { NodeSocketAdapter } from '../src/socket/NodeSocketAdapter.js';
import { FakeWebSocketService, FakeRoomfulConnection } from './helpers/fakes.js';
import { runConformanceSuite, runPushSuite } from './conformance/suite.js';

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
