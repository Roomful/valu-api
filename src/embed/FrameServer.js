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
//   // one per framed app: its slug as the host resolver names it, and no cache (the host's services have none)
//   const services = await connectValuServices({ socket: webSocketService, userId, applicationId: app.slug, cache: null });
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
//      was given an `appState`. Given one, every call carries it to the
//      services (`ServiceClient.call`'s `appState`), so a function on either
//      channel that reads app state (`VerusWallet.transfer`, TextChat's
//      decryption) reads the frame server's; without one, the services' own;
//   3. the params fit (400, the validation ack).
//
// No sign-in check: inside Valu Social the user is Valu Social's. The
// permission gate is Valu Social's to pass in (`gate`, from
// `createFrameGate`): an app may call only what its valu-permissions.json
// declares (the owner's decision, 2026-10-29), checked after the params, as
// the host checks it. Without one, nothing is gated (Valu Social's own apps,
// and a Valu Social from before the rule).
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
// INTENTS (typed app intents, docs/superpowers/specs/2026-11-03-typed-app-
// intents-design.md §5.5). An `api:call` that carries `intent: {target, id}`
// is an intent, not a function: `valu.Chats.openChannel()` (`application`,
// `textchat`), `valu.Commerce.getCart()` (`service`, `Commerce`), or the app's
// own route (`route`, `valu.route.push(path)`). Valu Social runs it with
// `intents(target, id, action, params)`, which it supplies, doing what its
// older bridge handlers do with the frame's own `Application`. Held to, in
// this order:
//
//   1. the catalogue names it: a typed intent for that target, id and action
//      (`INTENT_DESCRIPTORS`), or, for an app no descriptor names
//      (`valu.Apps.open/send`), an app intent the bridge's own table scopes
//      (`scopeOfAppIntent`, with `toFrame` from Valu Social); 404
//      `unknown_function` otherwise. This server never runs an intent the
//      catalogue cannot scope;
//   2. `intents` was given (501 `not_available` otherwise);
//   3. the params fit (400);
//   4. the gate, with the same scope the bridge computes for the same intent
//      (a route is never gated: it moves only the app's own address);
//   5. one attempt bounded as a call is, the reply read into an ack
//      (`intentAck`), then the leak guard. The one reply that may carry a
//      credential is `Application.get-identity-token`'s own `token`, the app's
//      short-lived token: exempt by the descriptor, never by anything in the
//      reply, as the host exempts it (HostBridge `markIdentityReply`).
//
// Intents need neither the app's slug nor the services: `services` is
// optional (without it every function answers 501), and `readyInfo` says
// `calls` and `intents` separately.
//
// No DOM, no postMessage, no timer but the call's: Valu Social does the posting.
// ===========================================================================
import { validationAck } from '../services/validate.js';
import { scopeOfDescriptor } from '../host/Permissions.js';
import { scopeOfAppIntent } from '../host/BridgeScopes.js';
import { INTENT_DESCRIPTORS } from '../services/descriptors.js';
import { appIntentDescriptor, findAppIntent, isFrameApp } from '../services/apps.js';
import { intentAck } from '../services/intents.js';
import {
  CALL_REPLIES, CALL_TIMEOUT_MS, TIMED_OUT, attemptTimeoutMs, callDescriptor, callOnce, callRefusal, isPlainObject,
  orAfter,
} from '../host/HostDispatch.js';
import {
  EMBEDDED_PROTOCOL_VERSION, HOST_ERRORS, MSG, assertNoHostLeak, blockedOutbound, identityOf,
} from '../host/protocol.js';

/** The default log: warnings and errors to the console. Valu Social passes its own. */
const consoleLog = (level, message) => {
  globalThis.console?.[level === 'error' ? 'error' : 'warn']?.(`[valu-frame-server] ${message}`);
};

/** What an intent is addressed to. */
export const INTENT_TARGETS = Object.freeze(['application', 'service', 'route']);

/** The typed SERVICE intents, by `<service id>\n<action>` (an app intent is found by `findAppIntent`). */
const SERVICE_INTENTS = new Map(INTENT_DESCRIPTORS
  .filter((d) => d.target === 'service')
  .map((d) => [`${d.to}\n${d.action}`, d]));

/** The route commands an app may send, as descriptors so the params are checked like any call's. */
const ROUTE_INTENTS = Object.freeze(Object.fromEntries(['push', 'replace'].map((action) => [action, Object.freeze({
  key: `route.${action}`,
  service: 'route',
  action,
  mutates: false,
  params: Object.freeze({
    required: Object.freeze([Object.freeze({ name: 'path', type: 'string', description: "The app's own route." })]),
    optional: Object.freeze([]),
  }),
})])));

/** The intent whose reply is the app's own short-lived token. */
const IDENTITY_TOKEN = 'Application.get-identity-token';

/** The shared replies, copied before they leave: whoever posts an answer may change it. */
const SHARED_REPLIES = new Set(Object.values(CALL_REPLIES));
const own = (reply) => (SHARED_REPLIES.has(reply) ? { ...reply, error: { ...reply.error } } : reply);

/**
 * Make the server Valu Social answers its framed apps' `api:call` with.
 *
 * @param {object} options
 * @param {{call: (name: string, params: object, options: object) => Promise<object>}|null} [options.services]
 *   The service functions over Valu Social's connection, for ONE framed app: a `ValuServiceApi`, from
 *   `connectValuServices({ socket: webSocketService, userId, applicationId: app.slug, cache: null })`. The
 *   app's storage shelf is addressed by that `applicationId`: the slug the host resolver names, never
 *   the launch intent's id or the `<workspace>/<slug>` address.
 * @param {import('../app-state/AppState.js').AppState|null} [options.appState] State Valu Social
 *   holds, for the `app-state` functions (`Developer.*`, `VerusWallet.get-balance`) and the others
 *   that read it; every call carries it. Without it the `app-state` functions answer 501
 *   `not_available`.
 * @param {(level: 'warn'|'error', message: string) => void} [options.log] Default: the console.
 * @param {(scope: string) => Promise<{ok: boolean, code?: string, scope?: string|null}>} [options.gate] The app's
 *   permission gate (`createFrameGate(...).permit`). A refusal is answered as the host answers it. Default: none.
 * @param {((target: 'application'|'service'|'route', id: string|null, action: string, params: object) => Promise<unknown>)|null} [options.intents]
 *   Runs an intent the app sent over `api:call`, as Valu Social's older bridge would with the frame's own
 *   `Application`: `application` → `application.run(new Intent(id, action, params))`, `service` →
 *   `application.callService(new Intent(id, action, params))`, `route` → move the app's route (`push` /
 *   `replace`, `params.path`). Its answer is read with `intentAck`. Without it intents answer 501, and
 *   `readyInfo` does not say `intents`.
 * @param {(appId: string) => boolean} [options.toFrame] Whether Valu Social frames `appId` (an intent to
 *   a frame is `apps:intent`), for an app no descriptor names. Default: the manifest snapshot's word, and
 *   a frame for an id it does not know.
 * @returns {Readonly<{
 *   readyInfo: (identity?: {user?: {id: string, name?: string|null}|null, network?: {id: string, name?: string|null}|null}) => {protocol: number, calls: boolean, intents?: true, user: {id: string, name: string|null}|null, network: {id: string, name: string|null}|null},
 *   handle: (message: unknown) => Promise<object>,
 *   intents: boolean,
 * }>}
 */
export function createFrameServer({
  services = null, appState = null, log = consoleLog, gate = null, intents = null, toFrame = isFrameApp,
} = {}) {
  if (services !== null && services !== undefined && typeof services?.call !== 'function') {
    throw new TypeError(
      'createFrameServer services must have call(): a ValuServiceApi, from connectValuServices({ socket, userId }), or null',
    );
  }
  if (intents !== null && intents !== undefined && typeof intents !== 'function') {
    throw new TypeError('createFrameServer intents must be a function (target, id, action, params) => reply, or null');
  }
  if (typeof toFrame !== 'function') throw new TypeError('createFrameServer toFrame must be a function (appId) => boolean');
  const runIntent = intents ?? null;
  const hasServices = services !== null && services !== undefined;
  if (appState !== null && appState !== undefined && typeof appState !== 'object') {
    throw new TypeError('createFrameServer appState must be an object (the AppState capabilities) or null');
  }
  if (typeof log !== 'function') throw new TypeError('createFrameServer log must be a function (level, message)');
  if (gate !== null && gate !== undefined && typeof gate !== 'function') {
    throw new TypeError('createFrameServer gate must be a function (scope) => verdict, from createFrameGate');
  }
  const state = appState ?? null;

  const say = (level, message) => {
    try {
      log(level, message);
    } catch { /* a logger that throws must not take the answer with it */ }
  };

  const serves = (channel) => hasServices && (channel === 'roomful' || (channel === 'app-state' && state !== null));
  // No cache: the app's own client caches, and a second layer here would only serve staler answers.
  const callOptions = state === null ? { bypassCache: true } : { bypassCache: true, appState: state };

  /** The descriptor an intent call names, and its scope; null when the catalogue names nothing. */
  function intentOf(target, id, action) {
    if (typeof action !== 'string' || action === '') return null;
    if (target === 'route') return Object.hasOwn(ROUTE_INTENTS, action) ? { descriptor: ROUTE_INTENTS[action], scope: null } : null;
    if (typeof id !== 'string' || id === '') return null;
    if (target === 'service') {
      const descriptor = SERVICE_INTENTS.get(`${id}\n${action}`);
      return descriptor ? { descriptor, scope: scopeOfDescriptor(descriptor) } : null;
    }
    if (target !== 'application') return null;
    const known = findAppIntent(id, action);
    if (known) return { descriptor: known, scope: scopeOfDescriptor(known) };
    // `valu.Apps.open/send`: an app no descriptor names, scoped as the bridge scopes it, with Valu Social's
    // own word on whether that app is a frame.
    let frame;
    try {
      frame = toFrame(id) === true;
    } catch {
      frame = false;
    }
    const scope = scopeOfAppIntent(id, action, { toFrame: frame });
    const descriptor = scope ? appIntentDescriptor(id, action) : null;
    return descriptor ? { descriptor, scope } : null;
  }

  /** One intent `api:call`, to its ack (see the header's order). */
  async function answerIntent({ intent, action, params, timeoutMs }) {
    const { target, id } = isPlainObject(intent) ? intent : {};
    const found = INTENT_TARGETS.includes(target) ? intentOf(target, id, action) : null;
    if (!found) return { reply: callRefusal({ code: HOST_ERRORS.UNKNOWN_FUNCTION }) };
    if (!runIntent) return { reply: callRefusal({ code: HOST_ERRORS.NOT_AVAILABLE }) };
    const { descriptor, scope } = found;
    const input = params === undefined ? {} : params;
    const invalid = validationAck(descriptor, input);
    if (invalid) return { reply: invalid };
    if (gate && target !== 'route') {
      const verdict = await gate(scope);
      if (!verdict?.ok) return { reply: callRefusal({ code: verdict?.code ?? HOST_ERRORS.UNAVAILABLE, scope: verdict?.scope }) };
    }

    const bound = attemptTimeoutMs(timeoutMs, CALL_TIMEOUT_MS);
    const attempt = Promise.resolve()
      .then(() => runIntent(target, target === 'route' ? null : id, action, input))
      .then(intentAck, (error) => {
        say('warn', `the intent ${target === 'route' ? 'route' : id}.${action} failed (${error?.code ?? error?.name ?? 'error'})`);
        return CALL_REPLIES.failed;
      });
    const answered = await orAfter(attempt, bound, TIMED_OUT);
    if (answered === TIMED_OUT) return { reply: descriptor.mutates ? CALL_REPLIES.timeoutAfterWrite : CALL_REPLIES.timeout };
    return { reply: answered, identity: descriptor.key === IDENTITY_TOKEN };
  }

  /** One `api:call`, to its ack: the checks, then one bounded attempt. */
  async function answer(message) {
    const { service, action, params, timeoutMs } = isPlainObject(message) ? message : {};
    const descriptor = callDescriptor({ service, action });
    if (!descriptor) return callRefusal({ code: HOST_ERRORS.UNKNOWN_FUNCTION });
    if (!serves(descriptor.channel)) return callRefusal({ code: HOST_ERRORS.NOT_AVAILABLE });
    const input = params === undefined ? {} : params;
    const invalid = validationAck(descriptor, input);
    if (invalid) return invalid;
    if (gate) {
      const verdict = await gate(scopeOfDescriptor(descriptor));
      if (!verdict?.ok) return callRefusal({ code: verdict?.code ?? HOST_ERRORS.UNAVAILABLE, scope: verdict?.scope });
    }

    const bound = attemptTimeoutMs(timeoutMs, CALL_TIMEOUT_MS);
    const attempt = callOnce(services, descriptor, input, bound, callOptions);
    const answered = await orAfter(attempt, bound, TIMED_OUT);
    if (answered !== TIMED_OUT) return answered;
    return descriptor.mutates ? CALL_REPLIES.timeoutAfterWrite : CALL_REPLIES.timeout;
  }

  /**
   * The answer, if it carries no credential; the host's `blocked outbound credential` otherwise.
   * `identity`: the reply of `Application.get-identity-token`, whose own `data.token` (a string) may leave;
   * everything else in it is still read.
   */
  function guarded(reply, identity = false) {
    try {
      const token = identity && isPlainObject(reply?.data) && typeof reply.data.token === 'string';
      const checked = token
        ? { ...reply, data: Object.fromEntries(Object.entries(reply.data).filter(([key]) => key !== 'token')) }
        : reply;
      assertNoHostLeak(checked, `outbound ${MSG.CALL_COMPLETED}`);
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
      return {
        protocol: EMBEDDED_PROTOCOL_VERSION,
        calls: hasServices,
        ...(runIntent ? { intents: true } : {}),
        user: identityOf(user),
        network: identityOf(network),
      };
    },

    /**
     * One `api:call` message (`{service, action, params, requestId, timeoutMs}`),
     * to the `ValuAck` Valu Social posts back as `api:call-completed`, with the
     * envelope's `requestId`, to the frame's origin. Never rejects.
     */
    async handle(message) {
      let reply;
      let identity = false;
      try {
        if (isPlainObject(message) && message.intent !== undefined) ({ reply, identity = false } = await answerIntent(message));
        else reply = await answer(message);
      } catch (error) {
        say('error', `a call failed (${error?.code ?? error?.name ?? 'error'})`);
        reply = CALL_REPLIES.failed;
      }
      return guarded(reply, identity);
    },

    /** Whether this server answers intents (`intents` was given). */
    get intents() { return runIntent !== null; },
  });
}
