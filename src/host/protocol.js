// ===========================================================================
// The bridge protocol between an app and its host iframe — names, envelopes
// and the leak guard. Shared by both sides, so it must not touch the DOM.
//
// The host speaks valu-api's existing wire format (so the client's request
// plumbing is reused) and adds a few `host:` messages. Envelopes:
//
//   app  -> host  { name, message }                          requestId inside `message`
//   host -> app   { target: 'valuApi', name, message, requestId }   requestId at the top
//
// What the host pushes (`api:trigger`, a host -> app message that answers
// nothing; `message` is `{action, data}`):
//
//   auth         `{signedIn, user, network, reason?}` on every change of who the
//                user is, with the `reason` when the change has one (see
//                HOST_ERRORS: `cancelled`, `master_mismatch`, `not_a_member`,
//                `invalid_token`, `unavailable`, `session_expired`,
//                `signed_out_elsewhere`). `signedIn` is the state NOW, so a push
//                is not always a sign-in result: `cancelled` and `master_mismatch`
//                report what the popup did and change nothing, and arrive with
//                the current `signedIn` (true for a user who was signed in).
//                A client waiting for `signIn()` must read `reason` BEFORE it
//                looks at `signedIn`.
//   connection   `{state}` with `state` one of {@link CONNECTION_STATE}, when the
//                host's link to the platform changes; after a drop that came
//                back, `{state:'ready', reconnected:true}`, which a client reads
//                as "forget what you cached". The host itself starts a page as
//                `connecting`, before `api:ready`, and says nothing then.
//   commerce     `{event, ...}` for the Commerce events the app subscribed to.
// ===========================================================================

import { FORBIDDEN_CREDENTIAL_KEYS } from '../auth/TokenStore.js';

/** Bumped only for a change an older client or host cannot ignore. */
export const PROTOCOL_VERSION = 1;

/** Every message name that crosses the iframe boundary. */
export const MSG = Object.freeze({
  // host: — what the host adds to valu-api's wire format
  HELLO: 'host:hello',
  ERROR: 'host:error',
  AUTH: 'host:auth',
  AUTH_COMPLETED: 'host:auth-completed',
  PING: 'host:ping',
  PONG: 'host:pong',
  CONSENT: 'host:consent',
  CONSENT_COMPLETED: 'host:consent-completed',
  // api: — valu-api's existing vocabulary
  CALL: 'api:call',
  CALL_COMPLETED: 'api:call-completed',
  READY: 'api:ready',
  TRIGGER: 'api:trigger',
  SERVICE_INTENT: 'api:service-intent',
  RUN_CONSOLE_COMPLETED: 'api:run-console-completed',
  RUN_INTENT: 'api:run-intent',
  RUN_COMPLETED: 'api:run-completed',
  CREATE_POINTER: 'api:create-pointer',
  POINTER_CREATED: 'api:pointer-created',
  RUN: 'api:run',
  RUN_CONSOLE: 'api:run-console',
  RUN_COMMAND: 'api:run-command',
});

/**
 * The `type` of a message a popup posts to the host iframe (not an app message:
 * it has no `name`). Accepted only from the origin the popup is served from;
 * see HostBridge.
 */
export const POPUP_MSG = Object.freeze({
  /** `{type, nonce, approved, scopes}` from the consent page. */
  CONSENT: 'valu-host:consent',
  /**
   * `{type, token, master}` from the sign-in page, or `{type, cancelled:true}`
   * when the user turned it down. Accepted only from a Valu sign-in origin, and
   * never from the window that frames the host.
   */
  TOKEN: 'valu-host:token',
});

/** What `api:trigger {action:'connection', data:{state}}` says; the `state` of `valu.connection`. */
export const CONNECTION_STATE = Object.freeze({
  CONNECTING: 'connecting',
  READY: 'ready',
  RECONNECTING: 'reconnecting',
  OFFLINE: 'offline',
  SIGNED_OUT: 'signed_out',
});

/**
 * Host-level string codes: what `host:error`, a rejected `open()` or an auth
 * outcome carries. Not the numeric ack codes of `src/Errors.js` — those answer
 * a call; these say why the host itself cannot.
 */
export const HOST_ERRORS = Object.freeze({
  UNKNOWN_APP: 'unknown_app',
  NESTED: 'nested',
  BAD_ORIGIN: 'bad_origin',
  PROTOCOL_UNSUPPORTED: 'protocol_unsupported',
  SIGN_IN_REQUIRED: 'sign_in_required',
  CONSENT_REQUIRED: 'consent_required',
  FORBIDDEN: 'forbidden',
  NOT_AVAILABLE: 'not_available',
  BUSY: 'busy',
  DISCONNECTED: 'disconnected',
  HOST_RESTARTED: 'host_restarted',
  HOST_UNREACHABLE: 'host_unreachable',
  POPUP_BLOCKED: 'popup_blocked',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout',
  MASTER_MISMATCH: 'master_mismatch',
  NOT_A_MEMBER: 'not_a_member',
  SESSION_EXPIRED: 'session_expired',
  UNKNOWN_FUNCTION: 'unknown_function',
  // Why a sign-in token was not taken, or a session ended: the `reason` of an
  // `auth` push.
  INVALID_TOKEN: 'invalid_token',
  SIGNED_OUT_ELSEWHERE: 'signed_out_elsewhere',
  // Why a request the host took could not be served: a dependency it needs
  // (Valu Guru, for grants and Commerce) did not answer; it was malformed.
  UNAVAILABLE: 'unavailable',
  INVALID_REQUEST: 'invalid_request',
  VALIDATION_FAILED: 'validation_failed',
});

/**
 * Wrap a host -> app message. `requestId` goes at the top level — the same
 * number the request carried — and the key is always present, so a push (which
 * answers nothing) has the same shape as a reply.
 * @param {string} name One of {@link MSG}.
 * @param {object} message
 * @param {number} [requestId]
 */
export const toParent = (name, message, requestId) => ({ target: 'valuApi', name, message, requestId });

/**
 * Read an app -> host message off `event.data`, or `null` if it is not one:
 * anything that is not an object with a string `name` and an object `message`
 * (arrays are not). The host receives whatever any window posts, so this is
 * the first thing every handler runs and it never throws.
 *
 * `requestId` is `message.requestId` exactly as sent — not validated here,
 * since what an unnumbered or mistyped request means is the handler's call.
 * @param {unknown} data
 * @returns {{name: string, message: object, requestId: any}|null}
 */
export function parseAppMessage(data) {
  if (!data || typeof data !== 'object') return null;
  const { name, message } = data;
  if (typeof name !== 'string') return null;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  return { name, message, requestId: message.requestId };
}

/** Key names the host must never put on the wire to an app: the user's own
 * credentials ({@link FORBIDDEN_CREDENTIAL_KEYS}) plus the ones the host
 * itself handles — the master session, a one-time token, the session header. */
const HOST_LEAK_KEYS = Object.freeze([
  ...FORBIDDEN_CREDENTIAL_KEYS,
  'session_token', 'token', 'x-session-id', 'onetimetoken',
]);

/**
 * Throw if a payload bound for an app carries a host credential.
 *
 * Applied to every message the host posts to an app: a leak there is a bug
 * that never shows up as a wrong answer. Same walk as `assertNoCredentialLeak`
 * (cycle-safe, arrays included); keys match whole and case-insensitively.
 * @param {any} payload
 * @param {string} [where] Named in the error, so the throw says which message.
 * @returns {any} The payload, so it can wrap a post.
 */
export function assertNoHostLeak(payload, where = 'payload') {
  const seen = new Set();
  const walk = (value, path) => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (HOST_LEAK_KEYS.includes(key.toLowerCase())) {
        throw new Error(
          `${where} would send the host credential "${path}${key}" — an app gets answers, never the session`,
        );
      }
      walk(child, `${path}${key}.`);
    }
  };
  walk(payload, '');
  return payload;
}
