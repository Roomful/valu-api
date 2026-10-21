// ===========================================================================
// The composition root of the host page (spec §4.1, §4.3): `createHost` builds
// every part of the bridge from what the page has, and returns the started
// `HostBridge`. The page (valu-guru-server's `host/src/index.ts`) calls it once.
//
//   createHost({ io, config: { hostOrigin, ... } })
//
// What it connects, and nothing more:
//
//   AppResolver     asks `config.resolveBaseUrl` which app an origin is
//   SessionStore    the user's sessions, in `storage`; another tab's change
//                   arrives from the window's `storage` event
//   HostAuth        redeems a one-time token and restores a stored session,
//                   at `config.master`
//   MasterConnection  one per session id, over `io`, at `config.master`
//   GuruClient      grants and Commerce, at `config.guruUrl`, over the
//                   WebSocket the page has; its one-time token is minted by
//                   the bridge, which is the only holder of the session id
//   GrantsStore     this app's grants over that client
//
// `fetch` is bound here, once: a browser's `fetch` called as a method of
// anything but the window throws "Illegal invocation", and the resolver, the
// auth and the master connection all keep it in a field and call it from there.
//
// `config.dev` is the one switch that lets a localhost page name its own app, so
// it is a boolean the page bakes in at build time; it is never read from the
// URL, the hash or storage, and only the boolean `true` turns it on.
//
// No DOM access at import, and none beyond the window it is handed: the page
// passes `window` (the default) and its `io`.
// ===========================================================================
import { MasterConnection } from './MasterConnection.js';
import { AppResolver } from './AppResolver.js';
import { HostAuth } from './HostAuth.js';
import { GuruClient } from './GuruClient.js';
import { HostBridge, defaultMakeGrants, defaultMakeServices } from './HostBridge.js';
import { SESSION_KEY, SessionStore } from './SessionStore.js';
import { isOrigin } from './origins.js';

/** The Valu origins a sign-in popup may report from. */
export const DEFAULT_SIGN_IN_ORIGINS = Object.freeze([
  'https://live.valuverse.io',
  'https://valu-social.com',
  'https://chabaduniverse.com',
  'https://texpo.io',
]);

/** What a config key left out becomes. `hostOrigin` has none: a host must know where it is served. */
export const DEFAULT_CONFIG = Object.freeze({
  master: 'api.roomful.net',
  guruUrl: 'wss://valuguru.texpo.io/',
  resolveBaseUrl: 'https://valuguru.texpo.io',
  signInOrigins: DEFAULT_SIGN_IN_ORIGINS,
  dev: false,
});

const isText = (value) => typeof value === 'string' && value !== '';

/**
 * The settings `createHost` itself needs, from the page's config: a key left out
 * takes its default, a key given the wrong kind of value is an error (a page
 * that is misconfigured must fail where it is built, not half-work). The other
 * keys are the bridge's own and pass through to it. `signInOrigins` is the one
 * exception to "wrong kind is an error": the bridge makes a mistyped list empty,
 * which allows nobody, and that is the right way for it to fail.
 * @param {object} config
 */
function settingsOf(config) {
  if (!config || typeof config !== 'object') throw new TypeError('createHost needs a config.');
  if (!isOrigin(config.hostOrigin)) throw new TypeError('createHost needs config.hostOrigin, the origin the host page is served from.');
  const given = (key, valid) => {
    const value = config[key];
    if (value === undefined) return DEFAULT_CONFIG[key];
    if (!valid(value)) throw new TypeError(`createHost: config.${key} is not usable.`);
    return value;
  };
  return {
    hostOrigin: config.hostOrigin,
    master: given('master', isText),
    guruUrl: given('guruUrl', isText),
    // '' is allowed: it asks the page's own origin.
    resolveBaseUrl: given('resolveBaseUrl', (value) => typeof value === 'string'),
    signInOrigins: config.signInOrigins === undefined ? DEFAULT_SIGN_IN_ORIGINS : config.signInOrigins,
    // Only the boolean `true`, and only as the page passed it.
    dev: config.dev === true,
  };
}

/** `window.localStorage`, or `null` where reading the property throws (blocked site data) or it is not there. */
function localStorageOf(win) {
  try {
    return win.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the host and start it.
 *
 * @param {object} options
 * @param {Window} [options.win] The host page's window (default: the global).
 * @param {Function} options.io The socket.io-client factory; valu-api has no
 *   socket.io dependency, so the page's bundle brings the one copy.
 * @param {Function} [options.fetchImpl] `fetch` (default: the global one, bound).
 * @param {typeof WebSocket} [options.WebSocketImpl] For Valu Guru (default: the global).
 * @param {Storage} [options.storage] Where the user's sessions are kept (default:
 *   the window's `localStorage`; where that cannot be read, the sessions live in memory).
 * @param {object} options.config
 * @param {string} options.config.hostOrigin Where the host page is served from.
 * @param {string} [options.config.master] The master API host. Default `api.roomful.net`.
 * @param {string} [options.config.guruUrl] Default `wss://valuguru.texpo.io/`.
 * @param {string} [options.config.resolveBaseUrl] Where `…/api/host/v1/resolve` is asked. Default `https://valuguru.texpo.io`.
 * @param {string[]} [options.config.signInOrigins] Default: the four Valu origins.
 * @param {boolean} [options.config.dev] A build-time constant. Default `false`.
 *   Every other `HostBridge` config key passes through.
 * @param {(level: 'warn'|'error', message: string) => void} [options.log]
 * @returns {HostBridge} started
 */
export function createHost({
  win = globalThis,
  io,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  storage,
  config,
  log,
} = {}) {
  if (!win || typeof win.addEventListener !== 'function') throw new TypeError('createHost needs a window.');
  const settings = settingsOf(config);
  if (typeof io !== 'function') throw new TypeError('createHost needs io, the socket.io-client factory.');
  if (typeof fetchImpl !== 'function') throw new TypeError('createHost needs a fetch.');
  if (typeof WebSocketImpl !== 'function') throw new TypeError('createHost needs a WebSocket.');

  // The global fetch must be called on the global; anything else the page passes is used as given.
  const boundFetch = fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;

  const sessionStore = new SessionStore({
    storage: storage === undefined ? localStorageOf(win) : storage,
    // Another tab's change. `key === null` is its `localStorage.clear()`.
    subscribe: (handler) => {
      win.addEventListener('storage', (event) => {
        if (event.key === null || event.key === SESSION_KEY) handler();
      });
    },
  });

  const makeConnection = (sessionId) => new MasterConnection({
    sessionId, io, fetchImpl: boundFetch, host: settings.master,
  });

  const bridge = new HostBridge({
    win,
    resolver: new AppResolver({ fetchImpl: boundFetch, baseUrl: settings.resolveBaseUrl }),
    auth: new HostAuth({ sessionStore, fetchImpl: boundFetch, master: settings.master, makeConnection }),
    sessionStore,
    makeConnection,
    makeServices: defaultMakeServices(boundFetch),
    makeGuru: (session) => new GuruClient({
      mintToken: session.mintToken,
      getNetworkId: session.getNetworkId,
      url: settings.guruUrl,
      WebSocketImpl,
      onlineSource: win.navigator,
      addEventListener: win.addEventListener.bind(win),
    }),
    makeGrants: defaultMakeGrants,
    config: { ...config, ...settings },
    log,
    fetchImpl: boundFetch,
  });
  return bridge.start();
}
