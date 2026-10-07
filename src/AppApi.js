// ===========================================================================
// Calling another application's REST API from a page on a Valu host.
//
// Every Valuverse application that declares an `api` block is reachable at ONE
// address through the Valu Guru gateway:
//
//   https://<valu-guru-host>/api/apps/v1/{address}/{path}
//
// where `{address}` is the target's application id, or `{workspace}/{id}` for
// an app Valu Guru built for a workspace — the string the Developer Portal's
// REST API tab prints under "Token audience".
//
// A BACKEND calls that address with a token it minted from its client
// credentials (see valu-guru-server/docs/application-rest-api.md §2). A PAGE
// cannot hold a secret, so for pages the gateway has a second door, the
// TRUSTED-HOST door: a request whose `Origin` is one of the hosts the platform
// owns — the Valu Social origins, and the site host every workspace app is
// framed at — is admitted with no credentials at all. The gateway mints the
// token the target verifies on the page's behalf, after the target's own
// allow-list, scope and user-context checks. The target sees `sub =
// host:<hostname>`, never an application id the page claimed.
//
// Two headers carry what a page has to say:
//
//   x-valu-network   REQUIRED. The network the call is scoped to — an
//                    application works in several, and a call is scoped to
//                    one. In an iframe app, `network.getNetworkId()`.
//   x-valu-scope     optional. Space-separated scopes to ask for; absent means
//                    every scope the target declares.
//
// and the signed-in user rides as the platform IDENTITY token — the one the
// bridge's `Application.get-identity-token` intent answers — sent as the
// bearer. The gateway verifies it against the master's keys, puts the user in
// the forwarded token's `act.sub`, and never passes it on. An API that
// declares `userContext: "required"` refuses a call without it.
//
// WHAT THIS DOES NOT DO. It does not make a page's call unforgeable — a script
// can send any `Origin` it likes, and CORS stops only browsers. The platform
// chose that trade to let its own pages call its own APIs; an API that needs
// the caller PROVEN should require the user context, which is signed by the
// platform, or admit backends only (narrow `callers` to application ids).
// ===========================================================================

const GATEWAY_PATH = '/api/apps/v1';
export const NETWORK_HEADER = 'x-valu-network';
export const SCOPE_HEADER = 'x-valu-scope';

/** Identity tokens last five minutes; refresh a little before that. */
const IDENTITY_TTL_MS = 4 * 60_000;

/** A refusal from the gateway or from the target, as `{ error: { code, message } }` says it. */
export class AppApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {unknown} [body]
   */
  constructor(status, code, message, body) {
    super(message);
    this.name = 'AppApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

const trimSlashes = (value) => String(value ?? '').trim().replace(/\/+$/, '');

/**
 * An address a caller wrote, kept as the gateway reads it: one or two segments,
 * nothing else. The gateway refuses more than two rather than truncating, and
 * so does this — a token minted for the first two segments of a three-segment
 * address would be a token for a target nobody named.
 * @param {string} address
 */
export function normalizeAddress(address) {
  const parts = String(address ?? '').split('/').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 2) {
    throw new TypeError(`"${address}" is not an application address — use "{application}" or "{workspace}/{application}"`);
  }
  return parts.join('/');
}

/**
 * @typedef {object} AppApiClientOptions
 * @property {string} gatewayBase The Valu Guru server's origin, e.g.
 *   `https://valuguru.texpo.io`. The Portal's REST API tab prints the full
 *   gateway URL for an app; this is that URL up to `/api/apps/v1`.
 * @property {string | (() => string | Promise<string>)} network The network id
 *   every call is scoped to, or a function that answers it.
 * @property {(() => Promise<string | { token: string } | null | undefined>)} [identityToken]
 *   Supplies the signed-in user's platform identity token. In an iframe app:
 *   `() => valuApi.callService(new Intent('Application', 'get-identity-token')).then(r => r?.token)`.
 *   Omit for a call with no user behind it.
 * @property {string | string[]} [scope] Scopes to ask for on every call. Absent = all declared.
 * @property {typeof fetch} [fetch] The fetch to use. Defaults to the global one.
 * @property {() => number} [now]
 */

/**
 * A client for the trusted-host door.
 *
 * @param {AppApiClientOptions} options
 */
export function createAppApiClient(options = {}) {
  const gatewayBase = trimSlashes(options.gatewayBase);
  if (!gatewayBase) throw new TypeError('createAppApiClient needs gatewayBase — the Valu Guru server origin');
  const network = options.network;
  if (!network) throw new TypeError('createAppApiClient needs network — the network id a call is scoped to');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('createAppApiClient needs a fetch');
  const now = options.now ?? Date.now;
  const defaultScope = Array.isArray(options.scope) ? options.scope.join(' ') : String(options.scope ?? '').trim();

  let cached = null; // { token, at }

  const resolveNetwork = async () => {
    const value = typeof network === 'function' ? await network() : network;
    const id = String(value ?? '').trim();
    if (!id) throw new TypeError('the network id resolved to nothing');
    return id;
  };

  const resolveIdentity = async ({ force = false } = {}) => {
    if (typeof options.identityToken !== 'function') return '';
    if (!force && cached && now() - cached.at < IDENTITY_TTL_MS) return cached.token;
    const answer = await options.identityToken();
    const token = typeof answer === 'string' ? answer : answer?.token;
    const value = String(token ?? '').trim();
    if (!value) {
      cached = null;
      return '';
    }
    cached = { token: value, at: now() };
    return value;
  };

  /**
   * The gateway URL for an address and a path.
   * @param {string} address
   * @param {string} [path]
   */
  const urlFor = (address, path = '') => {
    const p = String(path ?? '');
    const rest = p && !p.startsWith('/') && !p.startsWith('?') ? `/${p}` : p;
    return `${gatewayBase}${GATEWAY_PATH}/${normalizeAddress(address)}${rest}`;
  };

  /**
   * One call through the gateway. Answers the Response as the target sent it
   * (plus the gateway's own refusals, in the same envelope).
   *
   * @param {string} address `{application}` or `{workspace}/{application}`
   * @param {string} path the path AFTER the address, e.g. `/canvases?limit=10`
   * @param {RequestInit & { scope?: string | string[] }} [init]
   */
  const call = async (address, path, init = {}) => {
    const { scope, ...rest } = init;
    const headers = new Headers(rest.headers ?? {});
    headers.set(NETWORK_HEADER, await resolveNetwork());
    const wanted = Array.isArray(scope) ? scope.join(' ') : String(scope ?? defaultScope).trim();
    if (wanted) headers.set(SCOPE_HEADER, wanted);
    const identity = await resolveIdentity();
    if (identity) headers.set('authorization', `Bearer ${identity}`);
    if (rest.body != null && !headers.has('content-type') && typeof rest.body === 'string') {
      headers.set('content-type', 'application/json');
    }
    let response = await fetchImpl(urlFor(address, path), { ...rest, headers });
    // An identity token the gateway refused as stale is re-acquired ONCE: the
    // cache above is a guess at the master's expiry, and a 401 is the truth.
    if (response.status === 401 && identity && cached) {
      const fresh = await resolveIdentity({ force: true });
      if (fresh && fresh !== identity) {
        headers.set('authorization', `Bearer ${fresh}`);
        response = await fetchImpl(urlFor(address, path), { ...rest, headers });
      }
    }
    return response;
  };

  /**
   * `call`, with the body read as JSON and a refusal raised as `AppApiError`.
   *
   * @template T
   * @param {string} address
   * @param {string} path
   * @param {RequestInit & { scope?: string | string[], body?: any }} [init]
   * @returns {Promise<T>}
   */
  const json = async (address, path, init = {}) => {
    const prepared = { ...init };
    if (prepared.body != null && typeof prepared.body !== 'string' && !(prepared.body instanceof Uint8Array)) {
      prepared.body = JSON.stringify(prepared.body);
    }
    const response = await call(address, path, prepared);
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      const error = parsed && typeof parsed === 'object' ? parsed.error : null;
      throw new AppApiError(
        response.status,
        String(error?.code ?? 'http_error'),
        String(error?.message ?? `The call answered ${response.status}`),
        parsed,
      );
    }
    return parsed;
  };

  /**
   * The target's OpenAPI document, read through the gateway. Public — no
   * network, no user, no token.
   * @param {string} address
   */
  const openapi = async (address) => {
    const response = await fetchImpl(`${urlFor(address)}/openapi.json`);
    const parsed = await response.json().catch(() => null);
    if (!response.ok) {
      const error = parsed && typeof parsed === 'object' ? parsed.error : null;
      throw new AppApiError(
        response.status,
        String(error?.code ?? 'http_error'),
        String(error?.message ?? `The document answered ${response.status}`),
        parsed,
      );
    }
    return parsed;
  };

  return {
    gatewayBase,
    urlFor,
    call,
    json,
    openapi,
    get: (address, path, init) => json(address, path, { ...init, method: 'GET' }),
    post: (address, path, body, init) => json(address, path, { ...init, method: 'POST', body }),
    put: (address, path, body, init) => json(address, path, { ...init, method: 'PUT', body }),
    patch: (address, path, body, init) => json(address, path, { ...init, method: 'PATCH', body }),
    delete: (address, path, init) => json(address, path, { ...init, method: 'DELETE' }),
    /** Forget the cached identity token (sign-out). */
    forgetIdentity: () => { cached = null; },
  };
}
