// ===========================================================================
// The host's session storage.
//
// One record in the host origin's own (partitioned) `localStorage`:
//
//   localStorage['valu-host:session'] =
//     { v: 1, userId, sessions: { <networkId>: { sessionId, createdAt } } }
//
// A Roomful session belongs to one network, so the record keeps one per
// network, for one user: signing in as somebody else replaces the record
// (spec §4.4, "Network").
//
// Storage is allowed to be broken: Safari private windows and a full quota
// throw on write, blocked site data throws on any access. The first call that
// throws moves the store to an in-memory record for the rest of its life, and
// the operation that hit it still succeeds — the user signs in for this page
// view instead of not at all. `storageMode` says which one it is.
//
// One exception to "for the rest of its life": `clear()` always tries to
// remove the persisted record. A store that went to memory because a write
// failed may still be able to remove, and a sign-out that left the old session
// in storage would sign the user back in on the next page load.
//
// Nothing here touches `localStorage` or `window` itself: the page passes the
// storage in, and the cross-tab `storage` event as `subscribe`
// (`(h) => globalThis.addEventListener('storage', (e) => (e.key === key || e.key === null) && h())`:
// an event whose `key` is `null` is another tab's `localStorage.clear()`, which
// removes the record too), so the module imports anywhere. No error or log line contains a session id.
// ===========================================================================

/** Where the record lives. */
export const SESSION_KEY = 'valu-host:session';

const SCHEMA_VERSION = 1;

/** @typedef {{sessionId: string, createdAt: number}} StoredSession */
/** @typedef {{v: 1, userId: string, sessions: Record<string, StoredSession>}} SessionRecord */

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value !== '';

/**
 * The record `raw` holds, or null when it is not one this version wrote:
 * corrupt JSON, another version, the wrong shape. An entry without a session
 * id is dropped. Built with `Object.fromEntries` so a network id like
 * `__proto__` becomes a key, not a prototype.
 * @returns {SessionRecord|null}
 */
function parseRecord(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isObject(value) || value.v !== SCHEMA_VERSION || !isText(value.userId) || !isObject(value.sessions)) {
    return null;
  }
  const sessions = Object.fromEntries(
    Object.entries(value.sessions)
      .filter(([, entry]) => isObject(entry) && isText(entry.sessionId))
      .map(([networkId, entry]) => [networkId, {
        sessionId: entry.sessionId,
        createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
      }]),
  );
  return { v: SCHEMA_VERSION, userId: value.userId, sessions };
}

export class SessionStore {
  #storage;
  #key;
  /** @type {'storage'|'memory'} */
  #mode;
  /** @type {SessionRecord|null} The record while in memory mode. */
  #memory = null;
  #handlers = new Set();

  /**
   * @param {object} options
   * @param {Storage|null} [options.storage] A `Storage`; none is a memory store.
   * @param {string} [options.key]
   * @param {(handler: () => void) => void} [options.subscribe] Wires the
   *   cross-tab `storage` event: called once, with the function to run when
   *   the record changes in another tab.
   */
  constructor({ storage, key = SESSION_KEY, subscribe } = {}) {
    this.#storage = storage ?? null;
    this.#key = key;
    this.#mode = this.#storage ? 'storage' : 'memory';
    subscribe?.(() => this.#notify());
  }

  /** @returns {'storage'|'memory'} */
  get storageMode() { return this.#mode; }

  /**
   * A copy of the record, or null when there is none.
   * @returns {SessionRecord|null}
   */
  load() {
    if (this.#mode === 'memory') return this.#memory && structuredClone(this.#memory);
    let raw;
    try {
      raw = this.#storage.getItem(this.#key);
    } catch {
      this.#mode = 'memory';
      return null;
    }
    return raw === null ? null : parseRecord(raw);
  }

  /**
   * @param {string} networkId
   * @returns {StoredSession|null}
   */
  get(networkId) {
    const record = this.load();
    return record && Object.hasOwn(record.sessions, networkId) ? { ...record.sessions[networkId] } : null;
  }

  /**
   * Keep `sessionId` as the session for `networkId`. The other networks of the
   * same user stay; a different user replaces the record.
   * @param {{userId: string, networkId: string, sessionId: string}} session
   */
  set({ userId, networkId, sessionId } = {}) {
    if (!isText(userId) || !isText(networkId) || !isText(sessionId)) {
      throw new TypeError('SessionStore.set needs a userId, a networkId and a sessionId.');
    }
    const stored = this.load();
    const kept = stored?.userId === userId ? stored.sessions : {};
    /** @type {SessionRecord} */
    const record = {
      v: SCHEMA_VERSION,
      userId,
      sessions: { ...kept, [networkId]: { sessionId, createdAt: Date.now() } },
    };

    if (this.#mode === 'storage') {
      try {
        this.#storage.setItem(this.#key, JSON.stringify(record));
        return;
      } catch {
        this.#mode = 'memory';
      }
    }
    this.#memory = record;
  }

  /** Forget every session. */
  clear() {
    this.#memory = null;
    try {
      this.#storage?.removeItem(this.#key);
    } catch {
      this.#mode = 'memory';
    }
  }

  /**
   * `handler` runs when the record changes in another tab. This store's own
   * writes do not call it.
   * @param {() => void} handler
   * @returns {() => void} unsubscribe
   */
  onChange(handler) {
    this.#handlers.add(handler);
    return () => { this.#handlers.delete(handler); };
  }

  #notify() {
    for (const handler of [...this.#handlers]) {
      try { handler(); } catch (error) { console.error('session change handler threw:', error); }
    }
  }
}
