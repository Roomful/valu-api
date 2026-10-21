// ===========================================================================
// How the host answers what its app asks (spec §4.5-§4.7, §4.11): one
// `api:call` (`answerCall`), one `api:service-intent` (`answerIntent`: Commerce,
// its event subscriptions, the identity token), the permission order they share
// (`permit`), and the answers a refusal, a busy host or a timeout gives.
// `HostBridge` owns the state (the session, the sockets, the waiting, the cap);
// what it lends this module is the `DispatchHost` below, so what the app is told
// for each case is read, and tested, in one place without a window.
//
// Two shapes are answered, and which one a refusal takes depends on the
// message it answers:
//
//   api:call            a ValuAck: `{error:{status:true, code, message, …}}`
//   api:service-intent  Valu Social's: `{success:false, code, error, …}`
//
// No DOM, no state of its own; the I/O is whatever the seams do.
// ===========================================================================
import { ERROR_CODES } from '../Errors.js';
import { findDescriptor } from '../services/descriptors.js';
import { validationAck } from '../services/validate.js';
import { cartCount as countCartRows } from './commerceShapes.js';
import { HOST_ERRORS, MSG } from './protocol.js';

/**
 * What a request and the bridge's wait for it tell each other (see `answerCall`).
 * @typedef {object} Track
 * @property {boolean} wrote a function that writes was handed to the services.
 * @property {boolean} abandoned the answer was given already; do not start.
 */

/**
 * What the bridge lends the dispatch. State is read through functions, so a
 * session that ends between two awaits is seen as it ends.
 *
 * @typedef {object} DispatchHost
 * @property {object} permissions `decide`, `scopeOfDescriptor`, `scopeOfIntent` (the Permissions module).
 * @property {object} commerce `COMMERCE_INTENTS`, `COMMERCE_APP_EVENTS`, `runCommerceIntent`.
 * @property {() => boolean} signedIn
 * @property {() => {slug: string}} app the bound app: its slug is the only id stamped on anything.
 * @property {() => {call: Function}} services the SDK's service functions over the master.
 * @property {() => {has: (scope: string) => Promise<boolean>}} grants may throw when the Guru client cannot be made.
 * @property {() => object} guru the Guru client; may throw the same way.
 * @property {() => object|null} user the master's `user_info.user`.
 * @property {number} callTimeoutMs the longest one attempt of a call may take (`config.callTimeoutMs`).
 * @property {() => string|null} networkId
 * @property {(ns: string, data: object) => Promise<{data?: any, error?: any}>} emit an RPC over the master.
 * @property {() => Set<string>} subscribed the Commerce events the app listens for.
 * @property {(events: Set<string>) => void} setSubscribed
 * @property {(level: 'warn'|'error', message: string) => void} log
 */

/** The numeric ack codes the host answers with that `ERROR_CODES` does not name. */
export const ACK = Object.freeze({ UNAUTHENTICATED: 401, BUSY: 429, INTERNAL: 500, UNAVAILABLE: 503 });

/** The longest nonce a consent request may carry, and the most scopes it may name. */
export const NONCE_MAX = 128;
export const SCOPES_MAX = 64;

const isPositiveNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * How long the host lets its one attempt of a call run: what the client asked
 * for (`message.timeoutMs`), never more than `ceiling` (`config.callTimeoutMs`),
 * and the ceiling when the client asked for nothing usable (missing, not a
 * finite positive number).
 * @param {unknown} requested
 * @param {number} ceiling
 */
export function attemptTimeoutMs(requested, ceiling) {
  return isPositiveNumber(requested) ? Math.min(requested, ceiling) : ceiling;
}

/** A ValuAck error; `extra` rides on the error object (`scope`, `retryable`). */
export const ackError = (code, message, extra) => ({ error: { status: true, code, message, ...extra } });

/** An intent refusal, in the shape Valu Social documents for every intent. */
export const intentError = (code, error, extra) => ({ success: false, code, error, ...extra });

/**
 * What a refused `api:call` answers, from the verdict (`{ok:false, code, scope?}`,
 * the codes of `Permissions.decide` plus `sign_in_required` and `unavailable`).
 */
export function callRefusal({ code, scope }) {
  switch (code) {
    case HOST_ERRORS.SIGN_IN_REQUIRED: return ackError(ACK.UNAUTHENTICATED, HOST_ERRORS.SIGN_IN_REQUIRED);
    case HOST_ERRORS.FORBIDDEN: return ackError(ERROR_CODES.FORBIDDEN, HOST_ERRORS.FORBIDDEN);
    case HOST_ERRORS.CONSENT_REQUIRED: return ackError(ERROR_CODES.FORBIDDEN, HOST_ERRORS.CONSENT_REQUIRED, { scope });
    case HOST_ERRORS.NOT_AVAILABLE: return ackError(ERROR_CODES.UNSUPPORTED, HOST_ERRORS.NOT_AVAILABLE);
    case HOST_ERRORS.UNAVAILABLE: return ackError(ACK.UNAVAILABLE, HOST_ERRORS.UNAVAILABLE);
    default: return ackError(ERROR_CODES.UNKNOWN_FUNCTION, HOST_ERRORS.UNKNOWN_FUNCTION);
  }
}

const INTENT_REFUSALS = Object.freeze({
  [HOST_ERRORS.SIGN_IN_REQUIRED]: 'sign in to use this',
  [HOST_ERRORS.FORBIDDEN]: 'this app is never allowed to do that',
  [HOST_ERRORS.CONSENT_REQUIRED]: 'the user has not allowed this app to do that yet',
  [HOST_ERRORS.NOT_AVAILABLE]: 'that is not available through the valu-api host',
  [HOST_ERRORS.UNAVAILABLE]: 'the permission check could not be made; try again',
});

/** What a refused intent answers, from the same verdict. A code that is none of these is `not_available`. */
export function intentRefusal({ code, scope }) {
  const known = Object.hasOwn(INTENT_REFUSALS, code) ? code : HOST_ERRORS.NOT_AVAILABLE;
  return intentError(known, INTENT_REFUSALS[known], known === HOST_ERRORS.CONSENT_REQUIRED ? { scope } : undefined);
}

/**
 * Per kind of request: the reply name, and what it answers when it is not taken
 * (busy), not finished (timeout), fails, or is still waiting when the session
 * ends because the master refused it (`signInRequired`).
 */
export const CALL_REPLIES = Object.freeze({
  reply: MSG.CALL_COMPLETED,
  signInRequired: callRefusal({ code: HOST_ERRORS.SIGN_IN_REQUIRED }),
  busy: ackError(ACK.BUSY, HOST_ERRORS.BUSY),
  timeout: ackError(ERROR_CODES.TIMEOUT, HOST_ERRORS.TIMEOUT),
  // A call that WROTE and ran out of time may still be applied: the app decides.
  timeoutAfterWrite: ackError(ERROR_CODES.TIMEOUT, HOST_ERRORS.TIMEOUT, { retryable: false }),
  failed: ackError(ACK.INTERNAL, 'internal'),
});
export const INTENT_REPLIES = Object.freeze({
  reply: MSG.RUN_CONSOLE_COMPLETED,
  signInRequired: intentRefusal({ code: HOST_ERRORS.SIGN_IN_REQUIRED }),
  busy: intentError(HOST_ERRORS.BUSY, 'too many requests are running; try again'),
  timeout: intentError(HOST_ERRORS.TIMEOUT, 'the host did not answer in time'),
  failed: intentError('error', 'the host could not serve that request'),
});

/** A string from the app, short enough to put in a message or a log; `?` for anything else. */
export const label = (value) => (typeof value === 'string' ? value.slice(0, 60) : '?');

export const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The ack of a function that WRITES, when its call was cut off (503, the socket
 * dropped under it) or ran out of time (408). Either way the master may have
 * applied it, so the app, not the host, decides whether to repeat it
 * (`retryable: false`, spec §4.11); a read is answered as it came. The ack is
 * not changed.
 */
export function markUnretryable(descriptor, ack) {
  const code = ack.error?.code;
  if (!descriptor.mutates || (code !== ERROR_CODES.DISCONNECTED && code !== ERROR_CODES.TIMEOUT)) return ack;
  return { ...ack, error: { ...ack.error, retryable: false } };
}

/**
 * The event names an intent was given, checked: a list of known names, each
 * kept once. Anything else is a reason to refuse, so a typo is never a
 * subscription the app believes it has (`commerceEvents.js`' own rule). Only
 * strings are echoed, shortened, so a hostile name cannot fill the answer.
 * @param {unknown} value
 * @param {readonly string[]} known
 * @returns {{names: string[]}|{error: string}}
 */
export function readEventNames(value, known) {
  if (!Array.isArray(value)) return { error: `events must be a list of event names: ${known.join(', ')}` };
  const unknown = value.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    const shown = unknown.slice(0, 5).map((name) => (typeof name === 'string' ? name.slice(0, 40) : typeof name));
    return { error: `Unknown event ${shown.join(', ')}. The events are: ${known.join(', ')}` };
  }
  return { names: [...new Set(value)] };
}

/**
 * The count a `cart-updated` event carries: this app's rows of the server's
 * `cart.get` answer, the ones saved for later left out. It is the rule
 * `get-cart` counts with (`commerceShapes.cartCount`), narrowed to one app.
 * @param {{items?: unknown}|null|undefined} data
 * @param {string} appId the host's stamp, the one the app's cart rows carry
 */
export const cartCount = (data, appId) => countCartRows(data?.items, appId);

/**
 * The scopes of a consent request, or `null` when it is not one the user may
 * be asked: a short list of strings, every one a consent-tier scope. A basic
 * scope needs no asking, a forbidden one is never asked about, and a scope
 * nobody has heard of is not worth a dialog. Each is kept once.
 * @param {unknown} scopes
 * @param {(scope: string) => string|null} tierOf
 * @returns {string[]|null}
 */
export function validConsentScopes(scopes, tierOf) {
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > SCOPES_MAX) return null;
  if (!scopes.every((scope) => typeof scope === 'string' && tierOf(scope) === 'consent')) return null;
  return [...new Set(scopes)];
}

// ---------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------

/** The Commerce event subscriptions: intents of the host's own, not Guru ops. */
const SUBSCRIBE = 'subscribe-events';
const UNSUBSCRIBE = 'unsubscribe-events';

/**
 * The replies built from the identity token ack: the ONLY messages whose
 * top-level `token` the bridge's leak guard lets through. Membership is by
 * object identity and only `identityToken` marks one, so nothing an app sends
 * can be in it.
 * @type {WeakSet<object>}
 */
const identityReplies = new WeakSet();

/** Mark a reply the host built from the identity token ack. */
export const markIdentityReply = (reply) => { identityReplies.add(reply); return reply; };

/** Is this one of the replies {@link markIdentityReply} marked? */
export const isIdentityReply = (message) => identityReplies.has(message);

/** The answer for something the host does not do. */
export const notAvailable = (what) => ({
  error: { code: HOST_ERRORS.NOT_AVAILABLE, message: `${what} is not available through the valu-api host` },
});

/**
 * May a request that needs `scope` run? `{ok:true}`, or `{ok:false, code,
 * scope}`: the code of `Permissions.decide` (`forbidden`, `consent_required`,
 * `not_available`, `unknown_function`), `sign_in_required` (also when the
 * session went while the grants were being read), or `unavailable` (the grants
 * could not be read). The grants are read only for a `consent` scope, and never
 * for one that is refused anyway.
 * @param {DispatchHost} host
 * @param {string|null} scope
 */
export async function permit(host, scope) {
  if (!host.signedIn()) return { ok: false, code: HOST_ERRORS.SIGN_IN_REQUIRED };
  let verdict = host.permissions.decide({ scope });
  if (!verdict.ok && verdict.code === HOST_ERRORS.CONSENT_REQUIRED) {
    let hasGrant;
    try {
      hasGrant = await host.grants().has(scope);
    } catch (error) {
      host.log('warn', `the grants could not be read (${error?.code ?? error?.name ?? 'error'})`);
      return { ok: false, code: HOST_ERRORS.UNAVAILABLE };
    }
    if (!host.signedIn()) return { ok: false, code: HOST_ERRORS.SIGN_IN_REQUIRED };
    verdict = host.permissions.decide({ scope, hasGrant });
  }
  return verdict.ok ? verdict : { ...verdict, scope };
}

/**
 * The channels the host does not serve: `local` (the client runs those in the
 * app page itself) and `app-state` (`Developer.*`, `VerusWallet.get-balance`:
 * they read state a Valu Social runtime holds, and the host holds none).
 */
const UNSERVED_CHANNELS = new Set(['local', 'app-state']);

/**
 * One `api:call`, to its ValuAck. In this order, each refusing before the next
 * is asked: a known function (404), a signed-in user (401), a channel the host
 * serves (501 for `local` and `app-state`: the channel is checked before the
 * scope, so a local function with a basic scope is refused too, and the user is
 * never asked to consent to a function that would then answer 501), params that
 * fit (400), the scope's tier (403), and only then the services, whose ack is
 * returned unchanged except that a write cut off by a drop or a timeout is
 * marked `retryable: false`. The services are asked once (`retries: 0`) with the
 * client's `timeoutMs` (capped at `callTimeoutMs`, which is also the default):
 * retrying a read is the client's policy, and the host's own would only multiply
 * the wire attempts and sleep past the client's timer.
 *
 * `track` is how the caller and the call talk while it runs. `track.wrote` is
 * set the moment a function that writes is handed to the services, so a caller
 * that gives up on the call (the bridge's own timeout) knows it may still be
 * applied. `track.abandoned` is set by that caller when it has answered
 * already: a call that has not reached the services by then never will, since
 * the app was told it timed out and may repeat it.
 * @param {DispatchHost} host
 * @param {{service?: unknown, action?: unknown, params?: unknown}} message
 * @param {Track} [track]
 */
export async function answerCall(host, { service, action, params, timeoutMs }, track) {
  const descriptor = typeof service === 'string' && typeof action === 'string'
    ? findDescriptor(`${service}.${action}`)
    : undefined;
  if (!descriptor) return callRefusal({ code: HOST_ERRORS.UNKNOWN_FUNCTION });
  if (!host.signedIn()) return callRefusal({ code: HOST_ERRORS.SIGN_IN_REQUIRED });
  if (UNSERVED_CHANNELS.has(descriptor.channel)) return callRefusal({ code: HOST_ERRORS.NOT_AVAILABLE });
  const input = params === undefined ? {} : params;
  const invalid = validationAck(descriptor, input);
  if (invalid) return invalid;

  const verdict = await permit(host, host.permissions.scopeOfDescriptor(descriptor));
  if (!verdict.ok) return callRefusal(verdict);

  if (track?.abandoned) return CALL_REPLIES.timeout;
  const services = host.services();
  if (track) track.wrote = descriptor.mutates;
  // One attempt: the retries belong to the client (its own policy retries a read, and the host
  // retrying under it would multiply the wire attempts and sleep past the client's timer).
  const ack = await services.call(descriptor.key, input, {
    retries: 0, timeoutMs: attemptTimeoutMs(timeoutMs, host.callTimeoutMs),
  });
  return isPlainObject(ack) ? markUnretryable(descriptor, ack) : CALL_REPLIES.failed;
}

/**
 * One `api:service-intent`, to its answer. The host serves the Commerce intents
 * (the 30 data intents and the two subscriptions) and
 * `Application.get-identity-token`; anything else is `not_available`. A service
 * function asked for this way (`Users.current` as an intent) is `not_available`
 * too, with a message naming the SDK method that serves it
 * (`use valu.Users.current()`). As for `answerCall`, an intent that has not
 * started by the time `track.abandoned` is set never does.
 * @param {DispatchHost} host
 * @param {{applicationId?: unknown, action?: unknown, params?: unknown}} message
 * @param {Track} [track]
 */
export async function answerIntent(host, { applicationId, action, params }, track) {
  const input = isPlainObject(params) ? params : {};
  if (applicationId === 'Commerce' && isCommerceAction(host, action)) return commerceIntent(host, action, input, track);
  if (applicationId === 'Application' && action === 'get-identity-token') return identityToken(host, track);
  const descriptor = typeof applicationId === 'string' && typeof action === 'string'
    ? findDescriptor(`${applicationId}.${action}`)
    : undefined;
  if (descriptor) {
    const { service, method } = descriptor;
    return {
      error: {
        code: HOST_ERRORS.NOT_AVAILABLE,
        message: `${service}.${descriptor.action} is a service function, not an intent: use valu.${service}.${method}()`,
      },
    };
  }
  return notAvailable(`${label(applicationId)}.${label(action)}`);
}

const isCommerceAction = (host, action) => typeof action === 'string'
  && (action === SUBSCRIBE || action === UNSUBSCRIBE || Object.hasOwn(host.commerce.COMMERCE_INTENTS, action));

/** A Commerce intent: the scope first, then the subscription or the Guru op, stamped with the binding's slug. */
async function commerceIntent(host, action, params, track) {
  const verdict = await permit(host, host.permissions.scopeOfIntent('Commerce', action));
  if (!verdict.ok) return intentRefusal(verdict);
  if (track?.abandoned) return INTENT_REPLIES.timeout;
  let guru;
  try {
    guru = host.guru();
  } catch (error) {
    host.log('warn', `the Valu Guru client could not be made (${error?.name ?? 'error'})`);
    return intentRefusal({ code: HOST_ERRORS.UNAVAILABLE });
  }
  if (action === SUBSCRIBE || action === UNSUBSCRIBE) return subscribe(host, action, params.events);
  return host.commerce.runCommerceIntent(action, params, {
    guru, appId: host.app().slug, user: host.user(), networkId: host.networkId(),
  });
}

/**
 * `subscribe-events {events}` replaces the app's set; `unsubscribe-events
 * {events?}` takes some of it away, or all of it. Either way the answer is the
 * set now, in the catalogue's order. A name that is not an event refuses the
 * whole request and changes nothing.
 */
function subscribe(host, action, events) {
  if (action === UNSUBSCRIBE && (events === undefined || events === null)) {
    host.setSubscribed(new Set());
    return { success: true, events: [] };
  }
  const known = host.commerce.COMMERCE_APP_EVENTS;
  const read = readEventNames(events, known);
  if (read.error) return intentError(HOST_ERRORS.VALIDATION_FAILED, read.error);
  const next = action === SUBSCRIBE
    ? new Set(read.names)
    : new Set([...host.subscribed()].filter((name) => !read.names.includes(name)));
  host.setSubscribed(next);
  return { success: true, events: known.filter((name) => next.has(name)) };
}

/**
 * `Application.get-identity-token`: the master issues a short-lived token for
 * THIS app (the slug is the binding's, never the app's). The answer is the ack's
 * `data`, and its `token` is the one value the leak guard lets out: the reply is
 * marked with {@link markIdentityReply}, which only this function calls.
 */
async function identityToken(host, track) {
  const verdict = await permit(host, host.permissions.scopeOfIntent('Application', 'get-identity-token'));
  if (!verdict.ok) return intentRefusal(verdict);
  if (track?.abandoned) return INTENT_REPLIES.timeout;
  const ack = await host.emit('appManifest:getIdentityToken', { applicationId: host.app().slug });
  if (ack?.error) {
    const message = typeof ack.error.message === 'string' && ack.error.message !== ''
      ? ack.error.message.slice(0, 200)
      : 'the identity token could not be issued';
    return intentError(ack.error.code === ERROR_CODES.DISCONNECTED ? HOST_ERRORS.DISCONNECTED : 'error', message);
  }
  if (!isPlainObject(ack?.data)) return intentError('error', 'the master issued no identity token');
  return markIdentityReply({ ...ack.data });
}
