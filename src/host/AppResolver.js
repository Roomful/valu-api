// ===========================================================================
// The host's answer to "which app is this page?".
//
// The page that embeds the host is identified by its origin (`event.origin`,
// bound at the handshake). Nothing on the client can be trusted to say which
// app that is, so the host asks the server: `GET /api/host/v1/resolve?origin=…`
// (spec §4.9 item 1) answers `{ok:true, app}` for an origin it publishes, or
// 404 `{ok:false, error:{code:'unknown_app'}}`. Only that exact 404 is a miss:
// a 404 from anywhere else (a server that has not deployed the endpoint yet, a
// proxy) says nothing about the origin.
//
// This class is that one request and a cache in front of it:
//
//   - a hit is kept for `ttlMs` (default five minutes, which is what the
//     endpoint's `Cache-Control: max-age=300` allows), and so is a miss, as
//     `null`: a stranger's origin asked about repeatedly costs one request;
//   - a lookup that is already under way is shared, so two callers asking at
//     once make one request;
//   - anything that is not a hit or a miss — another status, a 404 that is not
//     `unknown_app`, a network failure, a body that is not the shape — throws
//     `Error{code: 'resolve_unavailable'}` and is NOT cached, so the next call
//     asks again. A cached answer outlives a server that has gone down, until
//     its ttl is up.
//
// No DOM at import; the global `fetch` is read when an instance is built.
// ===========================================================================

/** The `code` of the error `resolve` throws when the server cannot say. */
export const RESOLVE_UNAVAILABLE = 'resolve_unavailable';

/** How long an answer, hit or miss, is kept. */
export const DEFAULT_TTL_MS = 300_000;

/**
 * @typedef {object} ResolvedApp
 * @property {string} address `<workspaceId>/<slug>`, the canonical app id.
 * @property {string} workspaceId
 * @property {string} slug
 * @property {string} devAppId
 * @property {string} name
 * @property {string} homeNetworkId The network the app's workspace lives in.
 */

/** The `ResolvedApp` shape: `devAppId` and `homeNetworkId` may be `null`, the rest are strings. */
const isResolvedApp = (app) => Boolean(app) && typeof app === 'object'
  && typeof app.address === 'string' && app.address !== ''
  && typeof app.workspaceId === 'string'
  && typeof app.slug === 'string'
  && typeof app.name === 'string'
  && (app.devAppId === null || typeof app.devAppId === 'string')
  && (app.homeNetworkId === null || typeof app.homeNetworkId === 'string');

/** The JSON body, or `undefined` when there is none to read. */
async function readBody(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

const unavailable = (message, extra) => Object.assign(new Error(message), { code: RESOLVE_UNAVAILABLE, ...extra });

export class AppResolver {
  #fetch;
  #endpoint;
  #ttlMs;
  #now;
  /** @type {Map<string, {app: ResolvedApp|null, expiresAt: number}>} */
  #cache = new Map();
  /** @type {Map<string, Promise<ResolvedApp|null>>} */
  #inflight = new Map();

  /**
   * @param {object} options
   * @param {Function} [options.fetchImpl] `fetch`. Used exactly as given, so the
   *   CALLER binds it (`fetch.bind(globalThis)`): a bare `fetch` fails with
   *   "Illegal invocation" in a browser. When omitted, the global one, bound.
   * @param {string} options.baseUrl The server's origin, e.g.
   *   `https://valuguru.texpo.io`. `''` asks the page's own origin.
   * @param {number} [options.ttlMs] How long a hit, or a miss, is kept.
   * @param {() => number} [options.now] The clock, in ms.
   */
  constructor({ fetchImpl, baseUrl, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
    if (typeof baseUrl !== 'string') throw new TypeError('AppResolver needs a baseUrl.');
    const resolved = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (typeof resolved !== 'function') throw new TypeError('AppResolver needs a fetch.');
    this.#fetch = resolved;
    this.#endpoint = `${baseUrl.replace(/\/+$/, '')}/api/host/v1/resolve`;
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /**
   * The app that serves `origin`.
   *
   * @param {string} origin An `https` origin, as `event.origin` writes it.
   * @returns {Promise<ResolvedApp|null>} The app (frozen), or `null` when the
   *   server does not know the origin.
   * @throws {Error} `code: 'resolve_unavailable'` when the server could not say.
   */
  async resolve(origin) {
    if (typeof origin !== 'string' || !origin) throw new TypeError('resolve needs an origin.');

    const cached = this.#cache.get(origin);
    if (cached) {
      if (this.#now() < cached.expiresAt) return cached.app;
      this.#cache.delete(origin);
    }

    let pending = this.#inflight.get(origin);
    if (!pending) {
      pending = this.#lookup(origin).finally(() => this.#inflight.delete(origin));
      this.#inflight.set(origin, pending);
    }
    return pending;
  }

  async #lookup(origin) {
    const app = await this.#ask(origin);
    this.#cache.set(origin, { app, expiresAt: this.#now() + this.#ttlMs });
    return app;
  }

  /**
   * One request. `null` for a 404 that says `unknown_app`, the app for a good
   * 2xx, `resolve_unavailable` for everything else.
   */
  async #ask(origin) {
    const url = `${this.#endpoint}?origin=${encodeURIComponent(origin)}`;
    let response;
    try {
      response = await this.#fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    } catch (cause) {
      throw unavailable(`resolve failed: ${cause?.message ?? cause}`);
    }
    const { status } = response;

    if (status === 404) {
      const body = await readBody(response);
      if (body?.ok === false && body.error?.code === 'unknown_app') return null;
      throw unavailable('resolve answered 404 without unknown_app', { status });
    }
    if (!response.ok) throw unavailable(`resolve answered ${status}`, { status });

    const body = await readBody(response);
    if (body?.ok !== true || !isResolvedApp(body.app)) {
      throw unavailable('resolve answered a body that is not {ok:true, app}', { status });
    }
    return Object.freeze({ ...body.app });
  }
}
