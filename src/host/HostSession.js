// ===========================================================================
// The host's session: the master connection of one signed-in user, and what the
// host knows of them while it stands (spec §4.4, §4.11).
//
// `HostBridge` owns what the app sees (the handshake, the dispatch, the
// pushes); this owns what it takes to be signed in:
//
//   - OPEN. `open(sessionId)` makes a master connection, connects it and adopts
//     who `user_info` says the user is. It does not throw: it answers `null`
//     when the user is signed in, else why not (`session_expired`, a refused
//     session; `unavailable`, anything else) or {@link SUPERSEDED} when the
//     session was dropped while it connected, so a caller that has moved on is
//     not told a thing.
//   - DROP. `drop()` forgets the user and closes the connection, at once. A
//     connection that is let go of is never listened to again: whatever it
//     says after `drop()`, or after another `open()` replaced it, is ignored.
//   - WATCH. Once a connection is up, its state is mapped onto the five words
//     an app can act on (`connectionStateOf`) and handed to `onState` when it
//     changes; `onReconnected` says a drop came back (and whether `user_info`
//     now says someone else, or another network); `onExpired` says the master
//     refused the session. Nothing is said while the first connection is being
//     made: the caller has that answer in hand, and the page starts out
//     `connecting` on the app's side.
//
// How a refused session surfaces after the first connect: `MasterConnection`
// replaces a lost connection on the next call that needs one, and if the master
// refuses the session then, the attempt fails and the state is `failed` with a
// `lastError` whose `code` is `session_expired`. That is what `onExpired`
// listens for. A `failed` for any other reason is a connection that will be
// replaced on the next call: to the app, reconnecting.
//
// `lastError` is `{code, message}` with a fixed message per code, never the
// text of the error that caused it: nothing here carries a session id.
//
// No DOM, no I/O of its own; the connection factory and the clock are the
// caller's.
// ===========================================================================
import { displayNameOf } from '../socket/user-info.js';
import { CONNECTION_STATE, HOST_ERRORS } from './protocol.js';

/** What `open()` answers when the session was dropped (or replaced) while it was connecting. */
export const SUPERSEDED = Symbol('superseded');

const FAILURE_MESSAGES = Object.freeze({
  [HOST_ERRORS.SESSION_EXPIRED]: 'the session is no longer valid',
  [HOST_ERRORS.UNAVAILABLE]: 'the connection to Valu is unavailable',
});

/**
 * The failure a caller may show: a refused session, or "unavailable" for
 * anything else, with the fixed message of that code.
 * @param {unknown} code
 * @returns {Readonly<{code: string, message: string}>}
 */
export function failureOf(code) {
  const known = code === HOST_ERRORS.SESSION_EXPIRED ? code : HOST_ERRORS.UNAVAILABLE;
  return Object.freeze({ code: known, message: FAILURE_MESSAGES[known] });
}

/**
 * What an app is told of a master connection's state: `ready` is `ready`;
 * `connecting` (a replacement after a loss), `reconnecting` and `failed` (a
 * lost connection the next call replaces) are `reconnecting`, or `offline`
 * when the browser says it has no network; `idle` has nothing to say. (`closed`
 * only follows `drop()`, which is `signed_out` and detaches first.)
 * @param {string} masterState A `MasterConnection` state.
 * @param {boolean} [online]
 * @returns {string|null} A {@link CONNECTION_STATE}, or null.
 */
export function connectionStateOf(masterState, online = true) {
  switch (masterState) {
    case 'ready': return CONNECTION_STATE.READY;
    case 'connecting':
    case 'reconnecting':
    case 'failed': return online ? CONNECTION_STATE.RECONNECTING : CONNECTION_STATE.OFFLINE;
    default: return null;
  }
}

const text = (value) => (typeof value === 'string' && value !== '' ? value : null);
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export class HostSession {
  #makeConnection;
  #log;
  #online;
  #onState;
  #onReconnected;
  #onExpired;

  /** The connection being opened or open; null when signed out. */
  #connection = null;
  #signedIn = false;
  /** The master session id, for the Guru mint; never posted, never logged. Null when signed out. */
  #sessionId = null;
  /** `user_info.user`, whole: what the Commerce intents answer with. */
  #masterUser = null;
  #user = null;
  #network = null;
  /** @type {string} */
  #state = CONNECTION_STATE.SIGNED_OUT;
  #lastError = null;

  /**
   * @param {object} options
   * @param {(sessionId: string) => object} options.makeConnection A `MasterConnection` for a session id.
   * @param {(level: 'warn'|'error', message: string) => void} options.log
   * @param {() => boolean} [options.online] Whether the browser has a network (`navigator.onLine`).
   * @param {(state: string) => void} [options.onState] The mapped state changed, while signed in.
   * @param {(change: {changed: boolean}) => void} [options.onReconnected] The master came back; `changed`
   *   says `user_info` now names another user or network.
   * @param {() => void} [options.onExpired] The master refused the session.
   */
  constructor({
    makeConnection, log, online = () => true, onState, onReconnected, onExpired,
  }) {
    this.#makeConnection = makeConnection;
    this.#log = log;
    this.#online = online;
    this.#onState = onState;
    this.#onReconnected = onReconnected;
    this.#onExpired = onExpired;
  }

  /** The master connection, or null when signed out. Services and RPCs run over it. */
  get connection() { return this.#connection; }

  get signedIn() { return this.#signedIn; }

  /** The master session id this session was opened with; null when signed out. Never leaves the host. */
  get sessionId() { return this.#sessionId; }

  /** `user_info.user`, whole. */
  get masterUser() { return this.#masterUser; }

  /** The `connection` an app is told: a {@link CONNECTION_STATE}. */
  get state() { return this.#state; }

  /** Why the link is down, or why the session ended; null while it is up and after a plain sign-out. */
  get lastError() { return this.#lastError; }

  /** The network the master is in now (the facade's, which follows `user_info`), else the one it connected to. */
  networkId() {
    return this.#connection?.socket?.networkId ?? this.#network?.id ?? null;
  }

  /** Who the user is, as the app is told: copies. */
  identity() {
    return {
      user: this.#user && { ...this.#user },
      network: this.#network && { ...this.#network },
    };
  }

  /**
   * Connect the master for a session.
   * @param {string} sessionId
   * @returns {Promise<null|'session_expired'|'unavailable'|typeof SUPERSEDED>} `null`: the user is signed in.
   */
  async open(sessionId) {
    let connection = null;
    try {
      connection = this.#makeConnection(sessionId);
      this.#connection = connection;
      const info = await connection.connect();
      if (this.#connection !== connection) return SUPERSEDED;
      this.#sessionId = sessionId;
      this.#signedIn = true;
      this.#adopt(info);
      this.#lastError = null;
      this.#state = CONNECTION_STATE.READY;
      connection.onStateChange?.((state) => this.#onMasterState(connection, state));
      connection.onReconnected?.((fresh) => this.#onMasterReconnected(connection, fresh));
      return null;
    } catch (error) {
      const current = this.#connection === connection;
      if (current) this.#connection = null;
      if (connection) this.#closeQuietly(connection);
      if (!current) return SUPERSEDED;
      this.#log('warn', `the master did not accept the session (${error?.code ?? error?.name ?? 'error'})`);
      const failure = failureOf(error?.code);
      this.#lastError = failure;
      return failure.code;
    }
  }

  /**
   * Forget the user and close the connection. The connection is let go of
   * first, so nothing it says afterwards is heard.
   * @param {string|null} [why] `session_expired` keeps that as the `lastError`; anything else, none.
   * @returns {Promise<void>} The close, which never rejects.
   */
  drop(why = null) {
    const connection = this.#connection;
    this.#connection = null;
    this.#signedIn = false;
    this.#sessionId = null;
    this.#masterUser = null;
    this.#user = null;
    this.#network = null;
    this.#state = CONNECTION_STATE.SIGNED_OUT;
    this.#lastError = why === HOST_ERRORS.SESSION_EXPIRED ? failureOf(why) : null;
    return connection ? this.#closeQuietly(connection) : Promise.resolve();
  }

  /** Take who `user_info` says the user is. */
  #adopt(info) {
    this.#masterUser = isPlainObject(info?.user) ? info.user : null;
    this.#user = text(info?.userId) ? { id: info.userId, name: displayNameOf(info.user) } : null;
    this.#network = text(info?.networkId)
      ? { id: info.networkId, name: text(info.network?.fullName) ?? text(info.network?.name) }
      : null;
  }

  #onMasterState(connection, masterState) {
    if (connection !== this.#connection) return;
    const failed = masterState === 'failed';
    if (failed && connection.lastError?.code === HOST_ERRORS.SESSION_EXPIRED) {
      this.#lastError = failureOf(HOST_ERRORS.SESSION_EXPIRED);
      this.#onExpired?.();
      return;
    }
    const next = connectionStateOf(masterState, this.#online());
    if (!next) return;
    if (failed) this.#lastError = failureOf(connection.lastError?.code);
    else if (next === CONNECTION_STATE.READY) this.#lastError = null;
    if (next === this.#state) return;
    this.#state = next;
    this.#onState?.(next);
  }

  #onMasterReconnected(connection, fresh) {
    if (connection !== this.#connection) return;
    const before = JSON.stringify(this.identity());
    if (isPlainObject(fresh)) this.#adopt(fresh);
    this.#lastError = null;
    this.#state = CONNECTION_STATE.READY;
    this.#onReconnected?.({ changed: before !== JSON.stringify(this.identity()) });
  }

  async #closeQuietly(connection) {
    try {
      await connection.close?.();
    } catch (error) {
      this.#log('warn', `a connection did not close cleanly (${error?.name ?? 'error'})`);
    }
  }
}
