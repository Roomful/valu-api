// ===========================================================================
// Authorization (Phase 1.6).
//
// Acquisition, the app token on the handshake, refresh and revocation.
//
// The SDK never mints a token and never sees the user's credential: it asks
// the Valu Social application (or, headless, the caller's own supplier) for an
// application token
// and works with what it gets back. Scope enforcement is local and advisory
// until Phase 3.3 puts the check on the dispatch side — an app token today
// grants whatever the user can do, which is exactly why no third-party app
// gets a socket before that lands (see the plan's sequencing note).
// ===========================================================================
import { ERROR_CODES, errorAck } from '../Errors.js';
import { TokenStore, assertNoCredentialLeak } from './TokenStore.js';

export class AuthProvider {
  #acquire;
  #revoke;
  #store;
  #skewMs;
  #inFlight = null;

  /**
   * @param {object} options
   * @param {() => Promise<import('./TokenStore.js').AppToken>} options.acquire
   *   Asks for a token. In the browser this is the bridge's
   *   `Application.get-identity-token`; headless it is whatever the caller
   *   already uses to authenticate.
   * @param {(token: import('./TokenStore.js').AppToken) => Promise<void>} [options.revoke]
   * @param {number} [options.skewMs] Refresh this far before expiry. Default 60s.
   * @param {() => number} [options.now]
   */
  constructor({ acquire, revoke, skewMs = 60_000, now = Date.now } = {}) {
    if (typeof acquire !== 'function') {
      throw new TypeError('AuthProvider needs an acquire() that returns an app token');
    }
    this.#acquire = acquire;
    this.#revoke = revoke;
    this.#skewMs = skewMs;
    this.#store = new TokenStore({ now });
  }

  get store() { return this.#store; }

  /**
   * A valid token, acquiring or refreshing as needed.
   *
   * Concurrent callers share one acquisition: a reconnect that wakes fifty
   * pending calls must not ask for fifty tokens.
   * @param {{force?: boolean}} [options]
   */
  async getToken({ force = false } = {}) {
    if (!force && !this.#store.isStale(this.#skewMs)) return this.#store.get();
    if (!this.#inFlight) {
      this.#inFlight = (async () => {
        try {
          const acquired = await this.#acquire();
          if (!acquired?.token) throw new Error('acquire() returned no token');
          return this.#store.set(acquired);
        } finally {
          this.#inFlight = null;
        }
      })();
    }
    return this.#inFlight;
  }

  /** Force a refresh. Same path as acquisition — the issuer decides the rest. */
  refresh() { return this.getToken({ force: true }); }

  /** Drop the token locally, and tell the issuer if it offered a way to. */
  async revoke() {
    const token = this.#store.get();
    this.#store.clear();
    if (token && this.#revoke) await this.#revoke(token);
  }

  /**
   * The socket handshake payload. The app token and nothing else — checked,
   * not just intended.
   * @param {{applicationId?: string, networkId?: string}} [context]
   */
  async handshake(context = {}) {
    const token = await this.getToken();
    const payload = {
      token: token.token,
      applicationId: context.applicationId ?? token.applicationId,
      networkId: context.networkId,
    };
    assertNoCredentialLeak(context, 'handshake context');
    return payload;
  }

  /** Scopes the current token carries. */
  scopes() { return this.#store.scopes(); }

  /**
   * True when the token carries `scope`. A `service:write` scope implies
   * `service:read`; nothing else implies anything.
   */
  hasScope(scope) {
    const held = this.#store.scopes();
    if (held.includes('*') || held.includes(scope)) return true;
    const [service, access] = scope.split(':');
    return access === 'read' && held.includes(`${service}:write`);
  }

  /**
   * Check a descriptor's scopes before the call goes out.
   * @param {string[]} scopes
   * @returns {import('../socket/ValuSocket.js').ValuAck|null} null when allowed.
   */
  scopeAck(scopes = []) {
    // No token yet means no scope claim to check against — the remote is still
    // the authority. This is the advisory-until-3.3 case, stated plainly.
    if (!this.#store.get()) return null;
    const missing = scopes.filter((scope) => !this.hasScope(scope));
    if (missing.length === 0) return null;
    return errorAck(
      ERROR_CODES.FORBIDDEN,
      `missing scope: ${missing.join(', ')}`,
      `This application's token carries [${this.scopes().join(', ') || 'none'}].`,
    );
  }
}

export { TokenStore, assertNoCredentialLeak };
