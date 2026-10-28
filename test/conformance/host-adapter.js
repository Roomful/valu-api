// ===========================================================================
// The conformance adapter for the HOST: a service client in an app page whose
// calls travel to a real `HostBridge`, which serves them over a real
// `MasterConnection` on a fake socket.io. It is what lets the same suites that
// prove every function behaves the same over a window socket, a headless
// connection and a socket.io client prove it for an app that never holds a
// connection of its own.
//
//   services (ServiceClient: validation, cache, retry)
//     -> PairCallTransport          api:call over a FakeWindowPair
//       -> HostBridge               source/origin gates, the permission tiers
//         -> services (host side)   the same 65 handlers, ONE attempt per call
//           -> MasterConnection     hold while reconnecting, settle in-flight
//             -> ValuSocketConnection on readyIo(responder)
//
// The responder the case scripted is the master's socket, so a clause that
// reads `responder.calls` reads the real wire.
//
// WHAT THE HOST REFUSES, BY DESIGN (`hostRefuses` below), and a suite is told so
// instead of being weakened for everybody:
//   - `local`-channel functions (Http.*, Resources.generate-*, Time.*) answer
//     501: the client runs those in the page, they never reach the host;
//   - `app-state` functions (Developer.*, VerusWallet.get-balance) need state a
//     runtime holds and the host holds none: 501, answered before the scope is
//     weighed, so nobody is asked to consent to one (Developer.* too, although
//     its scopes are forbidden);
//   - forbidden-tier functions (Cbac writes, VerusWallet.transfer) answer 403
//     and are never asked about, whatever the user has granted.
//
// WHAT THE HOST'S OWN SERVICES ARE: not production's. `hostServicesFor` builds the
// host-side services in place of `defaultMakeServices` (slug stamping,
// `cache: null`, the real `webBase`/`apiGate`), because the suites inject
// `fetchImpl`, `config`, `now` and `registry` and read them back in their
// expectations. What `defaultMakeServices` builds is covered by
// `test/host/host-bridge-calls.test.js`, not here.
//
// WHAT IS NOT HERE: `resource:updated`. The host does not push it in the core,
// so there is nothing for `runPushSuite` to assert and it is not run for this
// adapter. When the host forwards it, the transport below translates it the
// way it does `reconnected` and a push entry is added.
// ===========================================================================
import { createValuApp } from '../../src/createValuApp.js';
import { ERROR_CODES, errorAck } from '../../src/Errors.js';
import { HostAuth } from '../../src/host/HostAuth.js';
import { MasterConnection } from '../../src/host/MasterConnection.js';
import { MSG, PROTOCOL_VERSION } from '../../src/host/protocol.js';
import { SessionStore } from '../../src/host/SessionStore.js';
import { createValuServices } from '../../src/services/api.js';
import { SocketTransport } from '../../src/transport/SocketTransport.js';
import { Transport } from '../../src/transport/Transport.js';
import { fakeBootstrapFetch, readyIo } from '../helpers/fakes.js';
import {
  APP, APP_ORIGIN, HOST_ORIGIN, fakeResolver, settle, setup,
} from '../helpers/hostBridgeFakes.js';
import { FakeStorage, fakeAuthFetch, fakeDocumentFor } from '../helpers/hostFakes.js';

/** Who `user_info` says the user is: what the cases' payloads (`forUser`, `app:app-1:...:user-1`) expect. */
const USER = Object.freeze({ userId: 'user-1', networkId: 'roomful' });

/** The app the host binds: slug `app-1` is the id the function cases are written for. */
const APP_UNDER_TEST = Object.freeze({ ...APP, slug: 'app-1', homeNetworkId: USER.networkId });

/** The scopes no user can grant to an app (spec §4.6). Written out here, not read from the tiers the host uses. */
const FORBIDDEN_SCOPES = Object.freeze(['veruswallet:read', 'veruswallet:write', 'cbac:write', 'developer:write', 'developer:read']);

/**
 * The code the host refuses `descriptor` with before the function runs, or
 * `null` when it runs it. For `runFunctionSuite`'s `expectRefused`.
 * @param {import('../../src/services/descriptors.js').ServiceDescriptor} descriptor
 * @returns {number|null}
 */
export function hostRefuses(descriptor) {
  if (descriptor.channel === 'local' || descriptor.channel === 'app-state') return ERROR_CODES.UNSUPPORTED;
  if (FORBIDDEN_SCOPES.includes(descriptor.scopes[0])) return ERROR_CODES.FORBIDDEN;
  return null;
}

// ---------------------------------------------------------------------------
// The app's side of the window pair
// ---------------------------------------------------------------------------

/**
 * A minimal transport over `pair`, for the conformance suites only: it speaks
 * the host's wire (`host:hello`, `api:call`, `api:call-completed`,
 * `api:trigger`) and nothing else — no iframe, no ping, no local channel.
 * `HostTransport` is the client the package ships; this is the smallest thing
 * that speaks the same messages, so the suites can run through the host
 * without it.
 */
export class PairCallTransport extends Transport {
  #pair;
  #hostOrigin;
  #readyTimeoutMs;
  #nextId = 1;
  /** @type {Map<number, {resolve: Function, timer: any}>} */
  #pending = new Map();
  #readyWaiter = null;
  #reconnects = 0;
  #listener = (event) => this.#onMessage(event);

  /**
   * @param {{app: object, host: object}} pair
   * @param {string} hostOrigin
   * @param {{readyTimeoutMs?: number}} [options]
   */
  constructor(pair, hostOrigin, { readyTimeoutMs = 5_000 } = {}) {
    super();
    this.#pair = pair;
    this.#hostOrigin = hostOrigin;
    this.#readyTimeoutMs = readyTimeoutMs;
    pair.app.addEventListener('message', this.#listener);
  }

  get servesServiceFunctions() { return true; }

  /** Calls sent and not yet answered. */
  get pending() { return this.#pending.size; }

  /** How many times the host has said the connection came back. */
  get reconnects() { return this.#reconnects; }

  /** Say hello and resolve with the host's `api:ready` message; reject on `host:error` or when it does not come. */
  open() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#readyWaiter = null;
        reject(new Error(`the host did not answer host:hello in ${this.#readyTimeoutMs} ms`));
      }, this.#readyTimeoutMs);
      this.#readyWaiter = {
        resolve: (message) => { clearTimeout(timer); resolve(message); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      this.#post(MSG.HELLO, { protocol: PROTOCOL_VERSION, client: 'conformance' });
    });
  }

  /**
   * One attempt: post `api:call`, resolve the ack the host answers it with,
   * or a 408 when `timeoutMs` passes first. Never rejects.
   * @param {import('../../src/services/descriptors.js').ServiceDescriptor} descriptor
   * @param {object} params
   * @param {{timeoutMs?: number}} [options]
   */
  callService(descriptor, params, { timeoutMs = 30_000 } = {}) {
    const requestId = this.#nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        resolve(errorAck(ERROR_CODES.TIMEOUT, 'timeout'));
      }, timeoutMs);
      this.#pending.set(requestId, { resolve, timer });
      this.#post(MSG.CALL, { service: descriptor.service, action: descriptor.action, params, requestId });
    });
  }

  /** Stop listening and answer what is still waiting. */
  async close() {
    this.#pair.app.removeEventListener('message', this.#listener);
    for (const { resolve, timer } of this.#pending.values()) {
      clearTimeout(timer);
      resolve(errorAck(ERROR_CODES.DISCONNECTED, 'transport closed'));
    }
    this.#pending.clear();
    this.#readyWaiter?.reject(new Error('transport closed'));
    this.#readyWaiter = null;
  }

  /** The app page writing to the host iframe. */
  #post(name, message) {
    this.#pair.host.postMessage({ name, message }, this.#hostOrigin);
  }

  #onMessage({ data, origin, source }) {
    if (source !== this.#pair.host || origin !== this.#hostOrigin || data?.target !== 'valuApi') return;
    switch (data.name) {
      case MSG.READY:
        this.#readyWaiter?.resolve(data.message);
        this.#readyWaiter = null;
        break;
      case MSG.ERROR:
        this.#readyWaiter?.reject(Object.assign(new Error(data.message?.message ?? 'host error'), { code: data.message?.code }));
        this.#readyWaiter = null;
        break;
      case MSG.CALL_COMPLETED: {
        const waiting = this.#pending.get(data.requestId);
        if (!waiting) break;
        this.#pending.delete(data.requestId);
        clearTimeout(waiting.timer);
        waiting.resolve(data.message);
        break;
      }
      case MSG.TRIGGER:
        if (data.message?.action === 'connection' && data.message.data?.reconnected === true) {
          this.#reconnects += 1;
          this.events.emit(Transport.RECONNECTED, data.message.data);
        }
        break;
      default:
    }
  }
}

// ---------------------------------------------------------------------------
// The host's side
// ---------------------------------------------------------------------------

/** Valu Guru, as far as these suites need it: there are no Commerce events and nothing to close. */
const fakeGuru = () => ({ close() {} });

/** A grants store that reports every consent scope granted. */
const fakeGrants = () => ({
  has: async () => true,
  grant: async () => {},
  invalidate() {},
});

/**
 * The host-side services for one case: the same function handlers over the
 * master's socket, for the app the host is bound to, built from what the suite
 * would have given a `SocketTransport` (`registry`, `fetchImpl`, `config`,
 * `now`, `applicationId`). The suite's `appState` is NOT passed on: the host
 * holds none, which is why the `app-state` functions refuse.
 *
 * Every `api:call` is ONE attempt here (`retries: 0`). `HostBridge` asks its
 * services with their default policy, which retries a read that timed out or
 * lost its connection twice, on top of the client's own: the retry clauses
 * measure the client's policy, and with both layers a read that times out is
 * tried three times per client attempt (verified: leave the `retries: 0` out
 * and "a read retries twice, with backoff" fails, after the host's own
 * sleeps).
 *
 * The bridge itself now passes `retries: 0` (a fix landing on feat/host-core in
 * parallel), so this wrapper can be removed once that is merged here.
 */
function hostServicesFor(options) {
  return (connection, app) => {
    const services = createValuServices({
      socket: connection.socket,
      cache: null,
      registry: options.registry,
      fetchImpl: options.fetchImpl,
      config: options.config,
      now: options.now,
      applicationId: 'applicationId' in options ? options.applicationId : app.slug,
    });
    return {
      call: (name, params, callOptions) => services.call(name, params, { retries: 0, ...callOptions }),
      close: () => services.close(),
    };
  };
}

/** Wait, in macrotasks, until `done()`; a host that never gets there is a failed case, not a hung run. */
async function until(done, what) {
  for (let spent = 0; spent < 200; spent += 1) {
    if (done()) return;
    await settle();
  }
  throw new Error(`the host adapter gave up waiting for ${what}`);
}

/**
 * A `HostBridge` on a window pair, started, for a signed-in user whose session
 * the master on `readyIo(responder)` accepts: the host's half of every adapter
 * here. `master()` is the connection it opened.
 * @param {import('../helpers/fakes.js').Responder} responder
 * @param {object} options The host-side `registry`, `fetchImpl`, `config`, `now`, `applicationId`.
 */
export function startBridge(responder, options) {
  const io = readyIo(responder, USER);
  let master = null;
  const makeConnection = (sessionId) => {
    master = new MasterConnection({ sessionId, io, fetchImpl: fakeBootstrapFetch() });
    return master;
  };

  // A signed-in user: a session stored for the app's home network, which the master accepts.
  const sessionStore = new SessionStore({ storage: new FakeStorage() });
  sessionStore.set({ ...USER, sessionId: 'sess-conformance' });
  const auth = new HostAuth({ sessionStore, fetchImpl: fakeAuthFetch({ check: 200 }), makeConnection });

  const harness = setup({
    resolver: fakeResolver({ [APP_ORIGIN]: APP_UNDER_TEST }),
    auth,
    sessionStore,
    maker: { make: makeConnection },
    makeServices: hostServicesFor(options),
    makeGuru: fakeGuru,
    makeGrants: fakeGrants,
  });
  return { ...harness, io, master: () => master };
}

/**
 * @param {import('../helpers/fakes.js').Responder} responder
 * @param {object} options What the suite configures: the app-side `cache`, `auth`
 *   and `hooks`; the host-side `registry`, `fetchImpl`, `config`, `now`,
 *   `applicationId`.
 * @param {{dropping: boolean}} mode `dropping`: the master's socket goes down
 *   before the case and comes back once its first call is waiting.
 */
async function startHost(responder, options, { dropping }) {
  const { pair, bridge, logs, io, master: masterOf } = startBridge(responder, options);

  const transport = new PairCallTransport(pair, HOST_ORIGIN);
  const services = createValuServices({
    transport,
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
    ...(options.auth !== undefined ? { auth: options.auth } : {}),
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
  });
  /** What the outage looked like at the moment it ended: the proof that a call was held across it. */
  const outage = { atRecovery: null };
  let closed = false;
  let recovery = null;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (recovery) clearImmediate(recovery);
    await services.close();
    await bridge.stop();
    // A bridge that logged is a bridge that met something it did not expect.
    if (logs.length > 0) throw new Error(`the host logged: ${JSON.stringify(logs)}`);
    // An outage that ended with nothing waiting on it tested nothing: say so, rather than pass.
    const { atRecovery } = outage;
    if (atRecovery && (atRecovery.master !== 'reconnecting' || atRecovery.calls < 1 || atRecovery.wire !== 0)) {
      throw new Error(`the outage did not hold a call: ${JSON.stringify(atRecovery)}`);
    }
  };

  try {
    const ready = await transport.open();
    if (ready?.host?.signedIn !== true) throw new Error('the host came up signed out');
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }

  if (dropping) {
    io.last.drop('transport close');
    recovery = setImmediate(() => {
      recovery = null;
      outage.atRecovery = { master: masterOf().state, calls: transport.pending, wire: responder.calls.length };
      io.last.reopen();
      io.last.ready(USER);
    });
  }

  return {
    services,
    /** The master's socket: what the identity clause reads. */
    socket: masterOf().socket,
    outage,
    /** The connection drops and comes back; resolves once the host has told the app. */
    reconnect: async () => {
      const before = transport.reconnects;
      io.last.drop('transport close');
      io.last.reopen();
      io.last.ready(USER);
      await until(() => transport.reconnects > before, 'the host to say the connection came back');
    },
    close,
  };
}

/** The host, up and signed in, with the suites' service client in front of it. */
export const makeHostServices = (responder, options) => startHost(responder, options, { dropping: false });

/**
 * The same, with the master's socket dropped before the case and brought back
 * once the case's first call is waiting on it, so that call is held across the
 * outage and answered after it.
 */
export const makeDroppingHostServices = (responder, options) => startHost(responder, options, { dropping: true });

/**
 * The same host, with the client an app really builds in front of it:
 * `createValuApp()` in dedicated mode, its `HostTransport` injecting the host
 * iframe into a fake document on the pair. `local` functions run in the page
 * with what the case gives (`fetchImpl`, `config`, `now`, `registry`), as they do
 * over a socket; the host's own refusals (`hostRefuses`, less `local`) stand.
 * No outage and no reconnect: the parity with embedded mode is about answers.
 */
export async function makeHostAppServices(responder, options = {}) {
  const { pair, bridge, logs } = startBridge(responder, options);
  pair.app.location = { search: '' };
  pair.app.navigator = {};
  let valu = null;
  const close = async () => {
    await valu?.close();
    await bridge.stop();
    if (logs.length > 0) throw new Error(`the host logged: ${JSON.stringify(logs)}`);
  };
  try {
    valu = await createValuApp({
      hostOrigin: HOST_ORIGIN,
      window: pair.app,
      document: fakeDocumentFor(pair),
      localTransport: new SocketTransport({
        socket: null, fetchImpl: options.fetchImpl, config: options.config, now: options.now, registry: options.registry,
      }),
    });
    if (valu.auth.state.signedIn !== true) throw new Error('the host came up signed out');
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  return { services: valu, close };
}
