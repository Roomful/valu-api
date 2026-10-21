// ===========================================================================
// The host's auth logic: redeem a sign-in token, restore a stored session,
// sign out (spec §4.4).
//
// The sign-in popup hands the host a one-time token. `redeem` trades it at the
// master for a Roomful session, moves that session into the app's home network
// when it arrived in another one, and keeps it in the `SessionStore`, one
// session per network. `restore` asks the master whether the stored session
// still stands. `signOut` forgets it.
//
// Facts about the master that shape this, measured against production
// (`2026-10-20-m0-prototype-results.md`):
//
//   - It answers HTTP 200 for every verdict and puts the verdict in the JSON
//     body. A token is good only when the status is 2xx AND `error.status` is
//     false AND `data.user_id` is non-empty. A session is refused only when
//     the body says `error.code === 401`.
//   - The `session_token` a valid token returns is the MINTING session itself,
//     the one the user's Valu Social page is signed in with. So `signOut` only
//     clears storage. Revoking it would sign the user out of Valu Social.
//
// `fetchImpl` is used exactly as given, so the caller binds it
// (`fetch.bind(globalThis)`). It is called detached, not as a method of this
// class, so even a bare one would not see the wrong `this`.
//
// Nothing here puts the token or a session id in an error, a log line or a
// returned value other than the session `redeem` and `restore` exist to hand
// back. Errors carry a `code` for the caller to act on: `invalid_token` (the
// master did not accept the token), `unavailable` (it could not be asked, or
// answered without something to keep), `timeout` (the redeem as a whole took
// longer than `redeemTimeoutMs`: the host's sign-ins wait in one line, so a
// hung one must not hold up the next) and, passed on from the connection,
// `not_a_member` and `session_expired`. A redeem that ran out of time stores
// nothing, even when the master answers it afterwards.
// ===========================================================================
import { MASTER_UNAVAILABLE } from './MasterConnection.js';
import { HOST_ERRORS } from './protocol.js';

/** The master did not accept the one-time token. */
export const INVALID_TOKEN = 'invalid_token';

/** The master API host a host build talks to unless told otherwise. */
export const DEFAULT_MASTER = 'api.roomful.net';

/** The longest a whole redeem (the token check, the temporary connection, the network switch) may take. */
export const REDEEM_TIMEOUT_MS = 15_000;

/** An `Error` whose `code` says what the host should do about it. */
const codedError = (code, message) => Object.assign(new Error(message), { code });

const invalidToken = () => codedError(INVALID_TOKEN, 'the master did not accept the one-time token');

const isText = (value) => typeof value === 'string' && value !== '';

export class HostAuth {
  #sessionStore;
  #fetch;
  #master;
  #makeConnection;
  #redeemTimeoutMs;

  /**
   * @param {object} options
   * @param {import('./SessionStore.js').SessionStore} options.sessionStore
   * @param {Function} options.fetchImpl A bound `fetch`.
   * @param {string} [options.master] The master's API host.
   * @param {(sessionId: string) => {
   *   connect: () => Promise<{networkId: string|null}>,
   *   switchNetwork: (networkId: string) => Promise<{sessionId: string}>,
   *   close: () => unknown,
   * }} options.makeConnection A `MasterConnection` for a session.
   * @param {number} [options.redeemTimeoutMs] Default {@link REDEEM_TIMEOUT_MS}.
   */
  constructor({
    sessionStore, fetchImpl, master = DEFAULT_MASTER, makeConnection, redeemTimeoutMs = REDEEM_TIMEOUT_MS,
  } = {}) {
    if (!sessionStore || typeof fetchImpl !== 'function' || typeof makeConnection !== 'function') {
      throw new TypeError('HostAuth needs a sessionStore, a fetchImpl and a makeConnection.');
    }
    this.#sessionStore = sessionStore;
    this.#fetch = fetchImpl;
    this.#master = master;
    this.#makeConnection = makeConnection;
    this.#redeemTimeoutMs = typeof redeemTimeoutMs === 'number' && redeemTimeoutMs > 0 ? redeemTimeoutMs : REDEEM_TIMEOUT_MS;
  }

  /**
   * Trade a one-time token for a session in the app's home network, and keep it.
   *
   * @param {string} token
   * @param {{homeNetworkId?: string}} [options] The network the app lives in.
   *   Without it the session is kept under whatever network the master puts it in.
   * @returns {Promise<{userId: string, sessionId: string, networkId: string}>}
   * @throws {Error} `code`: `invalid_token`; `unavailable`; `not_a_member` when
   *   the user may not join the home network; `session_expired`; `timeout` when
   *   it took longer than `redeemTimeoutMs` (nothing is stored then).
   */
  async redeem(token, { homeNetworkId } = {}) {
    let timer;
    let late = false;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        late = true;
        reject(codedError(HOST_ERRORS.TIMEOUT, `the sign-in took longer than ${this.#redeemTimeoutMs} ms`));
      }, this.#redeemTimeoutMs);
    });
    try {
      return await Promise.race([this.#redeem(token, homeNetworkId, () => late), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The redeem itself; `late()` says the caller has been answered `timeout`, and nothing may be stored. */
  async #redeem(token, homeNetworkId, late) {
    const { userId, sessionToken } = await this.#checkToken(token);

    // A temporary connection with the redeemed session: `user_info` says which
    // network it is in, and `network:switch` is a call on a connection.
    const connection = this.#makeConnection(sessionToken);
    let sessionId = sessionToken;
    let networkId;
    try {
      const info = await connection.connect();
      networkId = info?.networkId ?? null;
      if (homeNetworkId && homeNetworkId !== networkId) {
        const switched = await connection.switchNetwork(homeNetworkId);
        sessionId = switched?.sessionId;
        networkId = homeNetworkId;
      }
    } finally {
      // Whatever happened, the temporary connection is done. A failing close
      // must not hide the outcome it is closing after.
      try { await connection.close(); } catch { /* nothing to do about it */ }
    }

    if (!isText(networkId) || !isText(sessionId)) {
      throw codedError(MASTER_UNAVAILABLE, 'the master did not give a network and a session to keep');
    }
    if (late()) throw codedError(HOST_ERRORS.TIMEOUT, 'the sign-in finished after it had timed out');
    this.#sessionStore.set({ userId, networkId, sessionId });
    return { userId, sessionId, networkId };
  }

  /**
   * The stored session for `homeNetworkId`, when the master still accepts it.
   * Without a home network: the only stored one, and none when there are
   * several. A refused session is cleared; one that could not be checked is
   * kept, since it may be fine and the caller retries.
   *
   * @param {{homeNetworkId?: string}} [options]
   * @returns {Promise<{userId: string, sessionId: string}|null>}
   */
  async restore({ homeNetworkId } = {}) {
    const record = this.#sessionStore.load();
    if (!record) return null;
    const networkId = homeNetworkId ?? this.#onlyNetwork(record);
    if (networkId === null || !Object.hasOwn(record.sessions, networkId)) return null;
    const { sessionId } = record.sessions[networkId];

    const fetchImpl = this.#fetch;
    let response;
    let body;
    try {
      response = await fetchImpl(`https://${this.#master}/api/v1/auth/check`, {
        method: 'GET',
        headers: { 'X-Session-Id': sessionId },
      });
      body = await response.json();
    } catch {
      // The check could not be made, or what answered is not the master.
      return null;
    }

    // The refusal is in the body; the HTTP status of it is 200.
    if (body?.error?.code === 401) {
      // Another tab may have signed in while this asked: the 401 is about the
      // session that was asked about, not about its replacement.
      if (this.#sessionStore.get(networkId)?.sessionId === sessionId) this.#sessionStore.clear();
      return null;
    }
    if (!response.ok) return null;
    return { userId: record.userId, sessionId };
  }

  /** Forget the session. It is not revoked: it is the one Valu Social itself is signed in with. */
  signOut() {
    this.#sessionStore.clear();
  }

  /** The network of the record when it has exactly one, else null. */
  #onlyNetwork(record) {
    const networks = Object.keys(record.sessions);
    return networks.length === 1 ? networks[0] : null;
  }

  /**
   * Ask the master about a one-time token.
   * @returns {Promise<{userId: string, sessionToken: string}>}
   */
  async #checkToken(token) {
    if (!isText(token)) throw invalidToken();

    const fetchImpl = this.#fetch;
    let response;
    try {
      response = await fetchImpl(
        `https://${this.#master}/api/v1/auth/checkOneTimeAuthToken/${encodeURIComponent(token)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
    } catch {
      // Not the fetch error itself: its message can carry the URL, and the token is in it.
      throw codedError(MASTER_UNAVAILABLE, 'the master could not be reached to check the one-time token');
    }
    if (!response.ok) throw invalidToken();

    let body;
    try { body = await response.json(); } catch { throw invalidToken(); }
    const data = body?.data;
    if (body?.error?.status !== false || !isText(data?.user_id) || !isText(data?.session_token)) {
      throw invalidToken();
    }
    return { userId: data.user_id, sessionToken: data.session_token };
  }
}
