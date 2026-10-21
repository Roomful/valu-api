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
//   - RETRY. `MasterConnection` replaces a lost connection only on the next call
//     that needs one, so an idle app would stay disconnected for good. When the
//     master reaches `failed` for any reason but a refused session, this calls
//     `connect()` again by itself: 1 s, 2 s, 4 s ... capped at 30 s, each +-20 %
//     (the Valu Guru client's `backoffDelayMs`), for as long as the user is
//     signed in. Nothing is tried while the browser has no network
//     (`online() === false`); `networkChanged()` ends the wait at once when it
//     comes back. A retry that succeeds is the master's own `onReconnected`, so
//     the caller's reconnect path runs; one that finds the session refused is
//     `onExpired`; `drop()` stops it all.
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
import { DEFAULT_BACKOFF, backoffDelayMs } from './GuruClient.js';
import { CONNECTION_STATE, HOST_ERRORS } from './protocol.js';

/** The longest a timer can be: `setTimeout` fires a longer one at once. */
const MAX_TIMER_MS = 2_147_483_647;

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
  #random;
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
  /** The master connection's own state as last heard (`ready` once it is open). */
  #masterState = 'idle';
  /** The master is `failed` for a reason other than a refused session: a retry is due. */
  #failed = false;
  #retryTimer = null;
  /** A retry's `connect()` is running. */
  #retrying = false;
  /** The next retry waits for the network to come back. */
  #paused = false;
  /** Retries since the link was last up: the backoff exponent. */
  #attempts = 0;

  /**
   * @param {object} options
   * @param {(sessionId: string) => object} options.makeConnection A `MasterConnection` for a session id.
   * @param {(level: 'warn'|'error', message: string) => void} options.log
   * @param {() => boolean} [options.online] Whether the browser has a network (`navigator.onLine`).
   * @param {() => number} [options.random] In [0, 1): the jitter of the retry delay.
   * @param {(state: string) => void} [options.onState] The mapped state changed, while signed in.
   * @param {(change: {changed: boolean}) => void} [options.onReconnected] The master came back; `changed`
   *   says `user_info` now names another user or network.
   * @param {() => void} [options.onExpired] The master refused the session.
   */
  constructor({
    makeConnection, log, online = () => true, random = Math.random, onState, onReconnected, onExpired,
  }) {
    this.#makeConnection = makeConnection;
    this.#log = log;
    this.#online = online;
    this.#random = random;
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
      this.#masterState = 'ready';
      connection.onStateChange?.((state) => this.#onMasterState(connection, state));
      connection.onReconnected?.((fresh) => this.#onMasterReconnected(connection, fresh));
      return null;
    } catch (error) {
      const current = this.#connection === connection;
      if (current) this.#connection = null;
      if (connection) this.#closeQuietly(connection);
      if (!current) return SUPERSEDED;
      const failure = failureOf(error?.code);
      this.#log('warn', `the master did not accept the session (${failure.code})`);
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
    this.#stopRetry();
    this.#masterState = 'idle';
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

  /**
   * The browser says the network went away or came back (`online` and
   * `offline`). Gone: the app is told `offline`, whatever the socket still
   * believes. Back: the app is told what the master's state makes of it, and a
   * master that is waiting to be retried is retried now.
   */
  networkChanged() {
    const connection = this.#connection;
    if (!this.#signedIn || !connection) return;
    if (!this.#online()) {
      this.#announce(CONNECTION_STATE.OFFLINE);
      return;
    }
    this.#announce(connectionStateOf(this.#masterState, true) ?? CONNECTION_STATE.READY);
    if (this.#failed) {
      this.#clearRetryTimer();
      this.#paused = false;
      void this.#retry(connection);
    }
  }

  /** Tell the owner the state, when it is not what they were told last. */
  #announce(next) {
    if (next === this.#state) return;
    this.#state = next;
    this.#onState?.(next);
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
    this.#masterState = masterState;
    const failed = masterState === 'failed';
    if (failed && connection.lastError?.code === HOST_ERRORS.SESSION_EXPIRED) {
      this.#stopRetry();
      this.#lastError = failureOf(HOST_ERRORS.SESSION_EXPIRED);
      this.#onExpired?.();
      return;
    }
    const next = connectionStateOf(masterState, this.#online());
    if (!next) return;
    if (failed) this.#lastError = failureOf(connection.lastError?.code);
    else if (next === CONNECTION_STATE.READY) {
      this.#lastError = null;
      this.#stopRetry();
      this.#attempts = 0;
    }
    this.#announce(next);
    if (failed) {
      this.#failed = true;
      this.#scheduleRetry(connection);
    }
  }

  #onMasterReconnected(connection, fresh) {
    if (connection !== this.#connection) return;
    const before = JSON.stringify(this.identity());
    if (isPlainObject(fresh)) this.#adopt(fresh);
    this.#lastError = null;
    this.#state = CONNECTION_STATE.READY;
    this.#masterState = 'ready';
    this.#stopRetry();
    this.#attempts = 0;
    this.#onReconnected?.({ changed: before !== JSON.stringify(this.identity()) });
  }

  /** Ask for a retry after the backoff, unless one is due, running, or waiting for the network. */
  #scheduleRetry(connection) {
    if (this.#retryTimer !== null || this.#retrying) return;
    if (!this.#online()) {
      this.#paused = true;
      return;
    }
    const delay = Math.min(backoffDelayMs(this.#attempts, DEFAULT_BACKOFF, this.#random), MAX_TIMER_MS);
    this.#attempts += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void this.#retry(connection);
    }, delay);
  }

  /**
   * Connect the master again. Success is the master's own `ready` and
   * `onReconnected`; a refused session is its `failed` with `session_expired`.
   * Any other failure leaves the master `failed`, and the next retry is booked.
   */
  async #retry(connection) {
    if (this.#retrying || connection !== this.#connection || !this.#signedIn || !this.#failed) return;
    if (!this.#online()) {
      this.#paused = true;
      return;
    }
    this.#retrying = true;
    try {
      await connection.connect();
    } catch {
      // The connection reports why through its state; the booking below is the fallback.
    } finally {
      this.#retrying = false;
    }
    if (connection === this.#connection && this.#failed) this.#scheduleRetry(connection);
  }

  #clearRetryTimer() {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  /** The link is up again, the session is over, or the host stopped: no retry is due. */
  #stopRetry() {
    this.#clearRetryTimer();
    this.#failed = false;
    this.#paused = false;
  }

  async #closeQuietly(connection) {
    try {
      await connection.close?.();
    } catch (error) {
      this.#log('warn', `a connection did not close cleanly (${error?.name ?? 'error'})`);
    }
  }
}
