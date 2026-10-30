// ===========================================================================
// The scopes an app declares, as Valu recorded them, and the misses it reports
// (the owner's decision, 2026-10-29: an app may call only what its
// valu-permissions.json declares).
//
// Valu Guru answers `valuguru.apps.permissions.declared` for the signed-in
// user: the app's own workspace members get the newest publish's list (they
// test what they build), everyone else the released version's (a permission
// is reviewed before anyone else meets it). The client never names a commit
// or a version; the server picks the list. Both the host (an app at its own
// address) and Valu Social (an app it frames) read it through this class.
//
// - `get()` answers `{mode, scopes}` (`Permissions.readDeclaration`), kept for
//   `ttlMs` (a minute, as the grants): a change lands within that minute. A
//   lookup already under way is shared. A failure is not cached and rejects,
//   so the caller refuses the call as `unavailable`; a server that does not
//   know the op yet (`unknown_op`) is the rule switched off, not a failure.
// - `reportMiss(scope, mode, detail?)` tells Valu Guru that the app called a
//   scope it does not declare — or, with `detail.reason = 'not_served'` and
//   `detail.call`, an intent the host does not serve at the app's own address
//   (a parity gap, counted whatever the mode). Fire and forget, at most once
//   per scope (or call) per `ttlMs`, and it never throws: counting a miss
//   never decides a call.
//
// `guru` is anything with `request(op, params) → Promise<data>`.
// ===========================================================================
import { PERMISSION_MODES, readDeclaration } from './Permissions.js';

/** How long a declaration is trusted, and how often one scope's miss is reported. */
export const DECLARATION_TTL_MS = 60_000;

export const OP_DECLARED = 'valuguru.apps.permissions.declared';
export const OP_MISS = 'valuguru.apps.permissions.miss';

/** The Guru code of an op the server does not know: one deployed before the rule. */
const UNKNOWN_OP = 'unknown_op';

export class DeclarationStore {
  #guru;
  #app;
  #path;
  #now;
  #ttlMs;
  /** @type {{mode: string, scopes: string[]|null}|null} */
  #value = null;
  #loadedAt = 0;
  #epoch = 0;
  /** @type {Promise<{mode: string, scopes: string[]|null}>|null} */
  #inflight = null;
  /** @type {Map<string, number>} scope → when its miss was last reported */
  #reported = new Map();

  /**
   * @param {object} options
   * @param {{request: (op: string, params?: object) => Promise<any>}} options.guru
   * @param {{appId?: string|null, devAppId?: string|null}} options.app Which app: its Workspaces
   *   address (`<workspace>/<slug>`), its Developer Portal id, or both.
   * @param {'host'|'embedded'} [options.path] Where the calls are checked, for the miss counts.
   * @param {() => number} [options.now]
   * @param {number} [options.ttlMs]
   */
  constructor({ guru, app, path = 'host', now = Date.now, ttlMs = DECLARATION_TTL_MS }) {
    if (typeof guru?.request !== 'function') throw new TypeError('DeclarationStore needs a guru with request().');
    const appId = typeof app?.appId === 'string' && app.appId ? app.appId : null;
    const devAppId = typeof app?.devAppId === 'string' && app.devAppId ? app.devAppId : null;
    if (!appId && !devAppId) throw new TypeError('DeclarationStore needs an appId or a devAppId.');
    this.#guru = guru;
    this.#app = { ...(appId ? { appId } : {}), ...(devAppId ? { devAppId } : {}) };
    this.#path = path;
    this.#now = now;
    this.#ttlMs = ttlMs;
  }

  /**
   * The app's declaration for this user.
   * @returns {Promise<{mode: 'off'|'report'|'enforce', scopes: string[]|null}>}
   */
  get() {
    if (this.#value && this.#now() - this.#loadedAt < this.#ttlMs) return Promise.resolve(this.#value);
    this.#inflight ??= this.#load().finally(() => { this.#inflight = null; });
    return this.#inflight;
  }

  async #load() {
    const epoch = this.#epoch;
    const startedAt = this.#now();
    let value;
    try {
      value = readDeclaration(await this.#guru.request(OP_DECLARED, this.#app));
    } catch (error) {
      if (error?.code !== UNKNOWN_OP) throw error;
      value = { mode: PERMISSION_MODES.OFF, scopes: null };
    }
    if (epoch === this.#epoch) {
      this.#value = value;
      this.#loadedAt = startedAt;
    }
    return value;
  }

  /**
   * Count a call to a scope the app does not declare, or (`reason: 'not_served'`)
   * an intent not served where the app runs. Never throws, never waits.
   * @param {string} scope
   * @param {string} mode the mode it was checked under
   * @param {{reason?: 'undeclared'|'not_served', call?: string}} [detail] `call` names the intent
   *   (`Commerce.open-cart`) for a `not_served` miss.
   */
  reportMiss(scope, mode, { reason = 'undeclared', call } = {}) {
    if (typeof scope !== 'string' || !scope) return;
    const key = reason === 'not_served' ? `not_served:${call ?? scope}` : scope;
    const at = this.#now();
    const last = this.#reported.get(key);
    if (last !== undefined && at - last < this.#ttlMs) return;
    this.#reported.set(key, at);
    const report = { ...this.#app, scope, mode, path: this.#path, ...(reason !== 'undeclared' ? { reason } : {}), ...(call ? { call } : {}) };
    try {
      Promise.resolve(this.#guru.request(OP_MISS, report)).catch(() => {});
    } catch { /* a guru that throws at once is the same as one that fails later */ }
  }

  /** Forget the declaration (a reconnect): the next `get` asks again. */
  invalidate() {
    this.#epoch += 1;
    this.#value = null;
  }
}
