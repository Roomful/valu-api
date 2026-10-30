// ===========================================================================
// The typed intents at the transport (the owner's decision, 2026-10-30):
// `valu.Commerce.getCart()` is sent as the intent it always was, and what
// comes back is read into the ack envelope every other function answers in.
//
// What an intent answers is the application's own shape: `{success: true,
// …}`, `{success: false, code, error}`, or the host's `{error: {code,
// message}}`. One reader turns them into a ValuAck, so a caller handles a
// refused intent the way it handles a refused function — and the consent
// retry sees a `consent_required` the same way.
//
// At the app's own address a `window` intent opens Valu Social in a tab
// (`intentWindowUrl`: the intent route, `popup` forced off), and an
// `embedded-only` one is skipped with one warning per page.
// ===========================================================================
import { ERROR_CODES, errorAck } from '../Errors.js';

/** An error ack with what the refusal carried beside its code (`scope`, `retryable`): `errorAck` keeps only the description. */
const refusedAck = (status, code, message, extra = {}) => ({
  error: { status: true, code: status, message: code, ...(message ? { description: message } : {}), ...extra },
});
import { HOST_ERRORS } from '../host/protocol.js';

/** The numeric ack code a host-level refusal maps to. */
const STATUS = {
  [HOST_ERRORS.NOT_AVAILABLE]: ERROR_CODES.UNSUPPORTED,
  [HOST_ERRORS.FORBIDDEN]: ERROR_CODES.FORBIDDEN,
  [HOST_ERRORS.CONSENT_REQUIRED]: ERROR_CODES.FORBIDDEN,
  [HOST_ERRORS.PERMISSION_NOT_DECLARED]: ERROR_CODES.FORBIDDEN,
  [HOST_ERRORS.SIGN_IN_REQUIRED]: 401,
  [HOST_ERRORS.NOT_A_MEMBER]: 401,
  [HOST_ERRORS.UNAVAILABLE]: 503,
  [HOST_ERRORS.BUSY]: 429,
  [HOST_ERRORS.TIMEOUT]: ERROR_CODES.TIMEOUT,
  [HOST_ERRORS.UNKNOWN_FUNCTION]: ERROR_CODES.UNKNOWN_FUNCTION,
  [HOST_ERRORS.VALIDATION_FAILED]: ERROR_CODES.INVALID_PARAMS,
  [HOST_ERRORS.INVALID_REQUEST]: ERROR_CODES.INVALID_PARAMS,
};

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * An intent's reply as a ValuAck.
 * @param {unknown} reply what Valu Social or the host answered
 * @returns {import('../socket/ValuSocket.js').ValuAck}
 */
export function intentAck(reply) {
  if (isObject(reply) && isObject(reply.error)) {
    // The host's refusal: `{error: {code, message}}`.
    const { code, message, status: _status, ...rest } = reply.error;
    return refusedAck(STATUS[code] ?? 500, typeof code === 'string' ? code : 'error', typeof message === 'string' ? message : undefined, rest);
  }
  if (isObject(reply) && reply.success === false) {
    const { code, error, success: _success, ...rest } = reply;
    const name = typeof code === 'string' ? code : 'error';
    return refusedAck(STATUS[name] ?? 500, name, typeof error === 'string' ? error : undefined, rest);
  }
  return { data: reply === undefined || reply === null ? {} : reply };
}

/**
 * What an `embedded-only` intent answers at the app's own address: nothing
 * happened, and the app can tell.
 */
export const skippedIntentAck = () => ({ data: { success: true, skipped: true, reason: 'embedded_only' } });

/** What a `window` intent answers once the Valu Social tab is open. */
export const openedIntentAck = () => ({ data: { success: true, opened: 'tab' } });

/**
 * The Valu Social page a `window` intent opens at the app's own address: the
 * intent route, on the brand origin the app signs in on, with `popup` forced
 * off so the window opens as the tab's main app (valusocial-web `/-i/`).
 *
 * @param {string} origin the sign-in origin (`https://live.valuverse.io`)
 * @param {{service: string, action: string}} descriptor
 * @param {object} [params] strings, numbers and booleans as they are; anything else as JSON
 * @param {{app?: string|null}} [from] the app the window is opened from: its address as the host
 *   named it (`<workspace>/<slug>`) or its slug. Sent as `app`, so Valu Social shows that app's
 *   corner (its cart, its orders); it decides nothing else, since only `ui:open` intents run from a URL.
 */
export function intentWindowUrl(origin, { service, action }, params = {}, { app = null } = {}) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(isObject(params) ? params : {})) {
    if (name === 'popup' || name === 'app' || value === undefined || value === null) continue;
    query.set(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  const slug = typeof app === 'string' ? app.slice(app.lastIndexOf('/') + 1) : '';
  if (slug) query.set('app', slug);
  query.set('popup', 'false');
  return `${origin}/-i/${encodeURIComponent(service)}/${encodeURIComponent(action)}?${query}`;
}

/** The ack for a `window` intent whose popup the browser blocked: call it from a click. */
export const popupBlockedAck = (key) => errorAck(
  ERROR_CODES.UNSUPPORTED,
  HOST_ERRORS.POPUP_BLOCKED,
  `${key} opens a Valu Social window; the browser blocked it — call it from a click, and allow pop-ups.`,
);
