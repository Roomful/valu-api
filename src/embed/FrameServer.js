// ===========================================================================
// The frame server: valu-api's service functions for the apps Valu Social
// frames (embedded mode; docs/superpowers/specs/2026-10-28-embedded-service-
// functions-design.md §3, §4.1).
//
// An app calls `valu.Rooms.searchMyRooms()` the same way at its own address
// and inside Valu Social. At its own address the call is an `api:call` to the
// host iframe (src/host/HostBridge.js), which checks the grants and runs
// valu-api's function over the master. Inside Valu Social it is the same
// `api:call`, posted to the window that frames the app, and Valu Social
// answers it with this module: valu-api's own function over Valu Social's own
// connection, so the answer is the one the host gives.
//
//   const services = await connectValuServices({ socket: webSocketService, userId });
//   const frames = createFrameServer({ services });
//
//   // the api:ready Valu Social posts to a frame carries one more key:
//   post('api:ready', { ...startIntent, valuApi: frames.readyInfo({ user, network }) });
//   // an api:call from that frame (event.source === iframe.contentWindow, from its origin):
//   post('api:call-completed', await frames.handle(event.data.message), requestId);  // to the frame's origin
//
// What a call is held to, in the host's order (`HostDispatch.answerCall`),
// less the two checks that are the host's alone:
//
//   1. the function is in the catalogue (404 `unknown_function`);
//   2. its channel is served here (501 `not_available`): never `local` (the
//      app runs those in its own page) and `app-state` only when the server
//      was given an `appState`;
//   3. the params fit (400, the validation ack).
//
// No sign-in check and no permission gate: inside Valu Social the user is
// Valu Social's, and a framed app has the trust Valu Social gives framed
// apps' intents (spec §2).
//
// ONE attempt per call (`retries: 0`: the app's own client owns retries, the
// host-core rule), bounded by the call's `timeoutMs` capped at the host's
// `CALL_TIMEOUT_MS` (30 s, which is also what a call that names no usable
// timeout gets). A call that runs out answers 408 `timeout`, with
// `retryable: false` for a write (it may still be applied), and a write the
// services answer cut off is marked so too. No cache (`bypassCache`): the
// app's own client caches. Every answer passes the host's leak guard
// (`assertNoHostLeak`): one that carries a credential is replaced by the
// host's own `blocked outbound credential` answer and logged by key path,
// never by value. `handle` never rejects.
//
// No DOM, no postMessage, no timer but the call's: Valu Social does the posting.
// ===========================================================================
import { ServiceClient } from '../services/ServiceClient.js';
import { validationAck } from '../services/validate.js';
import { SocketTransport } from '../transport/SocketTransport.js';
import {
  CALL_REPLIES, CALL_TIMEOUT_MS, TIMED_OUT, attemptTimeoutMs, callDescriptor, callOnce, callRefusal, isPlainObject,
  orAfter,
} from '../host/HostDispatch.js';
import {
  HOST_ERRORS, MSG, PROTOCOL_VERSION, assertNoHostLeak, blockedOutbound, identityOf,
} from '../host/protocol.js';
// Registers the service functions: an `app-state` call runs on a transport of its own.
import '../services/impl/index.js';

/** The default log: warnings and errors to the console. Valu Social passes its own. */
const consoleLog = (level, message) => {
  globalThis.console?.[level === 'error' ? 'error' : 'warn']?.(`[valu-frame-server] ${message}`);
};

/** The shared replies, copied before they leave: whoever posts an answer may change it. */
const SHARED_REPLIES = new Set(Object.values(CALL_REPLIES));
const own = (reply) => (SHARED_REPLIES.has(reply) ? { ...reply, error: { ...reply.error } } : reply);

/**
 * One `app-state` call, over a transport of its own: Valu Social's socket and
 * settings, this server's app state. A `SocketTransport` takes its app state
 * when it is made, so one is made per call; the socket is read at the call, so
 * a socket the services were handed on a reconnect is the one used.
 */
async function appStateCall(services, appState, descriptor, input, timeoutMs) {
  const transport = new SocketTransport({
    socket: services.socket ?? null,
    appState,
    config: services.transport?.config,
    applicationId: services.transport?.applicationId ?? undefined,
  });
  try {
    return await callOnce(new ServiceClient({ transport, cache: null }), descriptor, input, timeoutMs);
  } finally {
    await transport.close();
  }
}

/**
 * Make the server Valu Social answers its framed apps' `api:call` with.
 *
 * @param {object} options
 * @param {{call: (name: string, params: object, options: object) => Promise<object>, socket?: object, transport?: object}} options.services
 *   The service functions over Valu Social's connection: a `ValuServiceApi`, from
 *   `connectValuServices({ socket: webSocketService, userId })`.
 * @param {import('../app-state/AppState.js').AppState|null} [options.appState] State Valu Social
 *   holds, for the `app-state` functions (`Developer.*`, `VerusWallet.get-balance`). Without
 *   it they answer 501 `not_available`.
 * @param {(level: 'warn'|'error', message: string) => void} [options.log] Default: the console.
 * @returns {Readonly<{
 *   readyInfo: (identity?: {user?: {id: string, name?: string|null}|null, network?: {id: string, name?: string|null}|null}) => {protocol: number, calls: true, user: {id: string, name: string|null}|null, network: {id: string, name: string|null}|null},
 *   handle: (message: unknown) => Promise<object>,
 * }>}
 */
export function createFrameServer({ services, appState = null, log = consoleLog } = {}) {
  if (typeof services?.call !== 'function') {
    throw new TypeError(
      'createFrameServer needs services with call(): a ValuServiceApi, from connectValuServices({ socket, userId })',
    );
  }
  if (appState !== null && appState !== undefined && typeof appState !== 'object') {
    throw new TypeError('createFrameServer appState must be an object (the AppState capabilities) or null');
  }
  if (typeof log !== 'function') throw new TypeError('createFrameServer log must be a function (level, message)');
  const state = appState ?? null;

  const say = (level, message) => {
    try {
      log(level, message);
    } catch { /* a logger that throws must not take the answer with it */ }
  };

  const serves = (channel) => channel === 'roomful' || (channel === 'app-state' && state !== null);

  /** One `api:call`, to its ack: the checks, then one bounded attempt. */
  async function answer(message) {
    const { service, action, params, timeoutMs } = isPlainObject(message) ? message : {};
    const descriptor = callDescriptor({ service, action });
    if (!descriptor) return callRefusal({ code: HOST_ERRORS.UNKNOWN_FUNCTION });
    if (!serves(descriptor.channel)) return callRefusal({ code: HOST_ERRORS.NOT_AVAILABLE });
    const input = params === undefined ? {} : params;
    const invalid = validationAck(descriptor, input);
    if (invalid) return invalid;

    const bound = attemptTimeoutMs(timeoutMs, CALL_TIMEOUT_MS);
    const attempt = descriptor.channel === 'app-state'
      ? appStateCall(services, state, descriptor, input, bound)
      : callOnce(services, descriptor, input, bound, { bypassCache: true });
    const answered = await orAfter(attempt, bound, TIMED_OUT);
    if (answered !== TIMED_OUT) return answered;
    return descriptor.mutates ? CALL_REPLIES.timeoutAfterWrite : CALL_REPLIES.timeout;
  }

  /** The answer, if it carries no credential; the host's `blocked outbound credential` otherwise. */
  function guarded(reply) {
    try {
      assertNoHostLeak(reply, `outbound ${MSG.CALL_COMPLETED}`);
      return own(reply);
    } catch (error) {
      say('error', `blocked an outbound ${MSG.CALL_COMPLETED}: ${error.message}`);
      return blockedOutbound();
    }
  }

  return Object.freeze({
    /**
     * The `valuApi` key of the `api:ready` Valu Social posts to a frame: this
     * server answers `api:call` (`calls: true`), and who the user and the
     * network are, as `{id, name}` (`name` null when unknown), or `null`.
     */
    readyInfo(identity) {
      const { user, network } = isPlainObject(identity) ? identity : {};
      return { protocol: PROTOCOL_VERSION, calls: true, user: identityOf(user), network: identityOf(network) };
    },

    /**
     * One `api:call` message (`{service, action, params, requestId, timeoutMs}`),
     * to the `ValuAck` Valu Social posts back as `api:call-completed`, with the
     * envelope's `requestId`, to the frame's origin. Never rejects.
     */
    async handle(message) {
      let reply;
      try {
        reply = await answer(message);
      } catch (error) {
        say('error', `a call failed (${error?.code ?? error?.name ?? 'error'})`);
        reply = CALL_REPLIES.failed;
      }
      return guarded(reply);
    },
  });
}
