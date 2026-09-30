// ===========================================================================
// The cache layer.
//
// This is what replaces the store the app's data services read today. Per
// service, keyed by entity id, hydrated on read, invalidated by
// `resource:updated`, bypassed for writes.
//
// The policy is per FUNCTION and lives in its descriptor, because parity is
// not identical behaviour: some app services answer from the store with no
// network at all (VerusWallet.getBalance), and an SDK that quietly turned
// those into socket calls would be "at parity" and still wrong. Those declare
// `mode: 'seeded'` — served from cache when the caller seeded it, otherwise a
// normal read.
// ===========================================================================

/** @typedef {{mode: 'none'|'read-through'|'seeded', ttlMs?: number, key?: string|null}} CachePolicy */

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
};

export class ServiceCache {
  #entries = new Map();
  #now;
  #maxEntries;

  /**
   * @param {{now?: () => number, maxEntries?: number}} [options]
   *   `now` is injected by the conformance suite so TTL is tested without
   *   waiting for wall-clock time.
   */
  constructor({ now = Date.now, maxEntries = 500 } = {}) {
    this.#now = now;
    this.#maxEntries = maxEntries;
  }

  get size() { return this.#entries.size; }

  /**
   * The cache key for one call: service, function, and the entity the call is
   * about. Params beyond the entity key still take part, so
   * `search-users {query:'a'}` and `{query:'b'}` are different entries.
   */
  static keyFor(descriptor, params = {}) {
    const entityKey = descriptor.cache?.key;
    const entity = entityKey ? params[entityKey] : undefined;
    return `${descriptor.service}|${descriptor.fn}|${entity ?? '-'}|${stableStringify(params)}`;
  }

  /** Cached ack, or undefined. Expired entries are dropped on the way past. */
  get(descriptor, params) {
    const key = ServiceCache.keyFor(descriptor, params);
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.ack;
  }

  /**
   * Hydrate from a read. Only successful acks are stored: caching a failure
   * turns one bad moment into a TTL of bad moments.
   */
  set(descriptor, params, ack) {
    const policy = descriptor.cache ?? { mode: 'none' };
    if (policy.mode === 'none' || descriptor.mutates) return ack;
    if (!ack || ack.error) return ack;

    const key = ServiceCache.keyFor(descriptor, params);
    if (this.#entries.size >= this.#maxEntries && !this.#entries.has(key)) {
      // Oldest insertion first — Map preserves it, and a read cache does not
      // earn a proper LRU until something proves it needs one.
      this.#entries.delete(this.#entries.keys().next().value);
    }
    this.#entries.set(key, {
      ack,
      service: descriptor.service,
      entity: policy.key ? params?.[policy.key] : undefined,
      expiresAt: policy.ttlMs ? this.#now() + policy.ttlMs : null,
    });
    return ack;
  }

  /**
   * Seed an entry the SDK did not fetch — the application handing over what its store
   * already knows, which is what makes `mode: 'seeded'` answer without a call.
   */
  seed(descriptor, params, data, { ttlMs } = {}) {
    const policy = descriptor.cache ?? {};
    const key = ServiceCache.keyFor(descriptor, params);
    this.#entries.set(key, {
      ack: { data },
      service: descriptor.service,
      entity: policy.key ? params?.[policy.key] : undefined,
      expiresAt: (ttlMs ?? policy.ttlMs) ? this.#now() + (ttlMs ?? policy.ttlMs) : null,
    });
    return this;
  }

  /** Drop every entry for a service. A write invalidates its own service. */
  invalidateService(service) {
    let dropped = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.service === service) { this.#entries.delete(key); dropped++; }
    }
    return dropped;
  }

  /** Drop every entry keyed by this entity id, whichever service holds it. */
  invalidateEntity(entityId) {
    if (entityId === undefined || entityId === null) return 0;
    let dropped = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.entity === entityId) { this.#entries.delete(key); dropped++; }
    }
    return dropped;
  }

  /**
   * Handle a `resource:updated` push. The payload shape varies by resource, so
   * every id-ish field it carries is treated as an invalidation target.
   */
  onResourceUpdated(payload) {
    const ids = [payload?.id, payload?.resourceId, payload?.resource?.id, payload?.belonging]
      .filter((id) => typeof id === 'string');
    return ids.reduce((n, id) => n + this.invalidateEntity(id), 0);
  }

  clear() { this.#entries.clear(); }
}
