// ===========================================================================
// Where a token lives while it is valid.
//
// The one hard rule: a third-party application never receives the user's
// `sessionId`. The app token is scoped, expiring, revocable and bound to the
// application; the session credential is none of those things, and anything
// holding it can do everything the user can do, forever.
// ===========================================================================

/** Key names that are the user's own credential and must never leave the host. */
export const FORBIDDEN_CREDENTIAL_KEYS = [
  'sessionid', 'session_id', 'session', 'cookie', 'cookies', 'authorization',
  'password', 'refreshtoken', 'refresh_token',
];

/**
 * Throw if a payload carries a user credential.
 *
 * Applied to everything the SDK puts on the wire on an application's behalf:
 * a leak here is not a bug that shows up as a wrong answer, it is one that
 * never shows up at all.
 * @param {any} payload
 * @param {string} [where] Named in the error, so the throw says which call.
 */
export function assertNoCredentialLeak(payload, where = 'payload') {
  const seen = new Set();
  const walk = (value, path) => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_CREDENTIAL_KEYS.includes(key.toLowerCase())) {
        throw new Error(
          `${where} would send the user credential "${path}${key}" — applications get an app token, never the session`,
        );
      }
      walk(child, `${path}${key}.`);
    }
  };
  walk(payload, '');
  return payload;
}

/** @typedef {{token: string, expiresAt: number, scopes: string[], applicationId?: string}} AppToken */

export class TokenStore {
  #token = null;
  #now;

  constructor({ now = Date.now } = {}) { this.#now = now; }

  /** @param {AppToken} token */
  set(token) {
    if (!token?.token) throw new TypeError('TokenStore.set needs {token}');
    assertNoCredentialLeak(token, 'token');
    this.#token = {
      token: token.token,
      expiresAt: token.expiresAt ?? Number.POSITIVE_INFINITY,
      scopes: [...(token.scopes ?? [])],
      applicationId: token.applicationId,
    };
    return this.#token;
  }

  /** @returns {AppToken|null} */
  get() { return this.#token; }

  /** True when there is no token, or it expires within `skewMs`. */
  isStale(skewMs = 60_000) {
    if (!this.#token) return true;
    return this.#token.expiresAt <= this.#now() + skewMs;
  }

  scopes() { return this.#token ? [...this.#token.scopes] : []; }

  clear() { this.#token = null; }

  /** What goes in a log line: never the token itself. */
  describe() {
    if (!this.#token) return { present: false };
    return {
      present: true,
      applicationId: this.#token.applicationId,
      scopes: [...this.#token.scopes],
      expiresAt: this.#token.expiresAt,
      stale: this.isStale(),
    };
  }
}
