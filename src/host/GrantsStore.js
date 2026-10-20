// ===========================================================================
// The host's per-app view of the user's grants (spec §4.6).
//
// Grants live in Valu Guru: one row per (user, app, scope) with `granted_at`
// and a nullable `revoked_at`. The host reads them over its Guru socket on
// first need, keeps the unrevoked scopes for a minute — so a revocation made
// elsewhere lands within that minute — and writes through when the user
// consents. `app` is the canonical address `<workspace>/<slug>`.
//
// Reads and writes run one at a time. That is what makes two callers asking at
// once share a single list, and what keeps a list that was already in flight
// from overwriting a grant written meanwhile (it would drop the scope for up to
// a minute, and the user would be asked again).
//
// `guru` is anything with `request(op, params) → Promise<data>`; its refusals
// (GuruError) propagate untouched, and a failed read is never cached.
// ===========================================================================

/** How long a list is trusted. */
export const GRANTS_TTL_MS = 60_000;

const OP_LIST = 'valuguru.apps.grants.list';
const OP_GRANT = 'valuguru.apps.grants.grant';

/**
 * The scopes of the unrevoked rows that belong to this app. The request already
 * names the app, but a server that ignored the filter must not hand this app
 * another app's scopes.
 */
function unrevokedScopes(data, appAddress) {
  const rows = Array.isArray(data?.grants) ? data.grants : [];
  const scopes = new Set();
  for (const row of rows) {
    if (!row || typeof row.scope !== 'string') continue;
    if (row.revokedAt != null) continue;
    if (row.appId !== undefined && row.appId !== appAddress) continue;
    scopes.add(row.scope);
  }
  return scopes;
}

export class GrantsStore {
  #guru;
  #appAddress;
  #now;
  #ttlMs;
  /** @type {Set<string>|null} */
  #scopes = null;
  #loadedAt = 0;
  /** Bumped by `invalidate()`, so a list that began before it is not kept. */
  #epoch = 0;
  #tail = Promise.resolve();

  /**
   * @param {object} options
   * @param {{request: (op: string, params?: object) => Promise<any>}} options.guru
   * @param {string} options.appAddress the app's canonical address, `<workspace>/<slug>`.
   * @param {() => number} [options.now] the clock, injected by tests.
   * @param {number} [options.ttlMs]
   */
  constructor({ guru, appAddress, now = Date.now, ttlMs = GRANTS_TTL_MS }) {
    this.#guru = guru;
    this.#appAddress = appAddress;
    this.#now = now;
    this.#ttlMs = ttlMs;
  }

  /** Run `task` after everything queued before it, whether that settled or failed. */
  #serial(task) {
    const run = this.#tail.then(task);
    this.#tail = run.catch(() => {});
    return run;
  }

  #isFresh() {
    return this.#scopes !== null && this.#now() - this.#loadedAt < this.#ttlMs;
  }

  async #list() {
    const epoch = this.#epoch;
    const startedAt = this.#now();
    const scopes = unrevokedScopes(
      await this.#guru.request(OP_LIST, { appId: this.#appAddress }),
      this.#appAddress,
    );
    if (epoch === this.#epoch) {
      this.#scopes = scopes;
      this.#loadedAt = startedAt;
    }
    return scopes;
  }

  /**
   * Does the user hold an unrevoked grant of `scope` for this app? The first
   * call (and the first after the cache expires) lists them from Valu Guru.
   * @param {string} scope
   * @returns {Promise<boolean>}
   */
  has(scope) {
    return this.#serial(async () => {
      const scopes = this.#isFresh() ? this.#scopes : await this.#list();
      return scopes.has(scope);
    });
  }

  /**
   * Record a consent: write the grants to Valu Guru, then add them to the
   * cache. A refusal rejects and leaves the cache as it was.
   * @param {string[]} scopes
   * @returns {Promise<void>}
   */
  grant(scopes) {
    const wanted = [...new Set(scopes)];
    if (wanted.length === 0) return Promise.resolve();
    return this.#serial(async () => {
      await this.#guru.request(OP_GRANT, { appId: this.#appAddress, scopes: wanted });
      // Before the first list there is no cache to add to: that list will
      // carry the grant.
      if (this.#scopes) for (const scope of wanted) this.#scopes.add(scope);
    });
  }

  /** Forget what was read (a reconnect, a consent made elsewhere): the next `has` lists again. */
  invalidate() {
    this.#epoch += 1;
    this.#scopes = null;
  }
}
