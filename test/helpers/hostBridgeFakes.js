// ===========================================================================
// Fakes and a harness for the host bridge's tests: a bridge on a window pair
// (`setup`), a resolver, an `auth`, a master-connection factory, and the few
// constants (origins, an app, a session) they share. `hostFakes.js` has the
// windows, storage and HTTP fakes these are built on.
//
// Reading the wire: the host answers through `win.parent.postMessage(msg,
// origin)`, which on the pair is a call ON `app`: it is recorded in
// `app.posted` and delivered to the app's own listeners. `setup` returns
// `posts()` (every reply, in order, with its target origin) and sends into the
// host with `host.dispatch`, which lets a test choose the origin and source;
// the bridge's async steps (the resolver, `auth.restore`, `connect`) finish
// when a test awaits `settle()`.
// ===========================================================================
import { HostBridge } from '../../src/host/HostBridge.js';
import { MSG, PROTOCOL_VERSION } from '../../src/host/protocol.js';
import { FakeWindowPair } from './hostFakes.js';

export const APP_ORIGIN = 'https://demo-ws-1.valuguru.app';
export const HOST_ORIGIN = 'https://valuguru.texpo.io';
export const OTHER_ORIGIN = 'https://other-ws-1.valuguru.app';
export const LOCAL_ORIGIN = 'http://localhost:3005';

export const APP = {
  address: 'ws_1/demo', workspaceId: 'ws_1', slug: 'demo', devAppId: 'dev-1', name: 'Demo', homeNetworkId: 'net-1',
};
export const INFO = {
  userId: 'u1',
  networkId: 'n1',
  user: { id: 'u1', name: 'Ada Lovelace' },
  network: { id: 'n1', fullName: 'Roomful' },
};
export const SESSION = { userId: 'u1', sessionId: 'sess-SECRET-1' };
/** What a redeemed token becomes: the session the sign-in popup's user ends up with. */
export const REDEEMED = { userId: 'u1', sessionId: 'sess-SECRET-2', networkId: 'net-1' };

/** Let every promise the bridge is awaiting run to its next real wait. */
export const settle = () => new Promise((resolve) => { setImmediate(resolve); });

export const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

export const codedError = (code) => Object.assign(new Error(`failed (${code})`), { code });

/** A resolver over a table of origin -> app (`null`: unknown); records every ask. */
export function fakeResolver(table = { [APP_ORIGIN]: APP }) {
  const resolver = {
    calls: [],
    async resolve(origin) {
      resolver.calls.push(origin);
      return Object.hasOwn(table, origin) ? table[origin] : null;
    },
  };
  return resolver;
}

/**
 * An `auth` whose `restore` answers `session` (or runs `restore`) and whose `redeem`
 * runs `redeem(token, options)` (a result `{userId, sessionId, networkId}`, or a throw),
 * recording what each was asked. Without a `redeem`, a token is redeemed into `REDEEMED`.
 */
export function fakeAuth({ session = null, restore, redeem } = {}) {
  const auth = {
    restoreCalls: [],
    redeemCalls: [],
    signOutCalls: 0,
    restore: async (options) => {
      auth.restoreCalls.push(options);
      return restore ? restore(options) : session;
    },
    redeem: async (token, options) => {
      auth.redeemCalls.push({ token, options });
      return redeem ? redeem(token, options) : REDEEMED;
    },
    signOut() { auth.signOutCalls += 1; },
  };
  return auth;
}

/**
 * `makeConnection` over a scripted master: `connect` answers `info`, or rejects with
 * `error` (a function of the connection when `connect` is given). Each connection
 * is a `MasterConnection` as far as the host reads it: `onStateChange` and
 * `onReconnected` (cleared by `close()`, as the real one does), `state`,
 * `lastError`. A test moves it with `setState(next, lastError?)` and `reconnected(info)`.
 */
export function fakeMaker({ info = INFO, error = null, connect } = {}) {
  const maker = {
    sessions: [],
    connections: [],
    /** Set to keep a closed connection's subscribers, so a test can fire events at a master that was let go of. */
    keepHandlers: false,
    make(sessionId) {
      maker.sessions.push(sessionId);
      const stateHandlers = new Set();
      const reconnectedHandlers = new Set();
      const connection = {
        closed: 0,
        state: 'idle',
        lastError: null,
        socket: { emit: async () => ({ data: {} }) },
        connect: connect ? () => connect(connection) : async () => {
          if (error) throw error;
          connection.state = 'ready';
          return info;
        },
        close: async () => {
          connection.closed += 1;
          connection.state = 'closed';
          if (maker.keepHandlers) return; // a connection that goes on calling after it was closed
          stateHandlers.clear();
          reconnectedHandlers.clear();
        },
        onStateChange(handler) {
          stateHandlers.add(handler);
          return () => stateHandlers.delete(handler);
        },
        onReconnected(handler) {
          reconnectedHandlers.add(handler);
          return () => reconnectedHandlers.delete(handler);
        },
        /** Move the master to `next` (with the error that explains a `failed`), and tell every subscriber. */
        setState(next, lastError) {
          const previous = connection.state;
          connection.state = next;
          if (lastError !== undefined) connection.lastError = lastError;
          for (const handler of [...stateHandlers]) handler(next, previous);
        },
        /** The master came back and re-read `user_info`. */
        reconnected(fresh) {
          for (const handler of [...reconnectedHandlers]) handler(fresh);
        },
        subscribers: () => stateHandlers.size + reconnectedHandlers.size,
      };
      maker.connections.push(connection);
      return connection;
    },
  };
  return maker;
}

export const noopStore = { onChange: () => () => {} };

/**
 * A bridge on a window pair, started. `send` posts an app message into the
 * host as the app (the parent window) unless told otherwise.
 */
export function setup({
  appOrigin = APP_ORIGIN, resolver = fakeResolver(), auth = fakeAuth(), maker = fakeMaker(),
  config = {}, sessionStore = noopStore, start = true, ancestors, ...rest
} = {}) {
  const pair = FakeWindowPair({ appOrigin, hostOrigin: HOST_ORIGIN });
  const { app, host } = pair;
  if (ancestors) host.location = { ancestorOrigins: ancestors };
  const logs = [];
  const bridge = new HostBridge({
    win: host,
    resolver,
    auth,
    sessionStore,
    makeConnection: (sessionId) => maker.make(sessionId),
    config: { hostOrigin: HOST_ORIGIN, signInOrigins: [], ...config },
    log: (level, message) => logs.push({ level, message }),
    ...rest,
  });
  if (start) bridge.start();

  const send = (data, { origin = appOrigin, source = app } = {}) => host.dispatch({ data, origin, source });
  const hello = (extra, options) => send({ name: MSG.HELLO, message: { protocol: PROTOCOL_VERSION, client: 'test', ...extra } }, options);
  const call = (name, message = {}, options) => send({ name, message }, options);
  /** What the host posted to the app, in order: `{data, targetOrigin}`. */
  const posts = () => app.posted;
  const names = () => app.posted.map((p) => p.data.name);
  const last = () => app.posted.at(-1);
  /** Run the handshake to the end and forget what it posted. */
  const open = async (extra) => {
    hello(extra);
    await settle();
    app.posted.length = 0;
  };
  return {
    pair, app, host, bridge, resolver, auth, maker, logs, send, hello, call, posts, names, last, open,
  };
}
