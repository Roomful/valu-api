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
//   - RESUME. `resume(sessionId, {userId, networkId})` is how a STORED session
//     comes back: the user counts as signed in at once, as storage knows them
//     (ids, no names; `state` is `connecting`), while the master connects. It
//     answers the first attempt as `open()` does, but a master that cannot be
//     reached does not end it: the session stays signed in (`reconnecting`, or
//     `offline`) and is tried again with the backoff below, and at once when the
//     network comes back, until the master accepts it (`onOpened`, with
//     `user_info` adopted) or refuses it (`onExpired`). A first attempt that is
//     refused answers `session_expired`, and the drop is the caller's.
//   - DROP. `drop()` forgets the user and closes the connection, at once. A
//     connection that is let go of is never listened to again: whatever it
//     says after `drop()`, or after another `open()` replaced it, is ignored.
//   - WATCH. Once a connection is up, its state is mapped onto the five words
//     an app can act on (`connectionStateOf`) and handed to `onState` when it
//     changes; `onReconnected` says a drop came back (and whether `user_info`
//     now says someone else, or another network); `onExpired` says the master
//     refused the session. Nothing is said while the first connection is being
//     made, or while a resume's first attempt runs: the caller has that answer
//     in hand, and the page starts out `connecting` on the app's side.
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
  #onOpened;
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
  /** Retries since the link was last up (or this session began): the backoff exponent. */
  #attempts = 0;
  /** The master has accepted this session (`open()` did, or a resume was confirmed); false while a resume waits. */
  #confirmed = false;
  /** The owner has been told this session was refused: once is enough. */
  #expired = false;

  /**
   * @param {object} options
   * @param {(sessionId: string) => object} options.makeConnection A `MasterConnection` for a session id.
   * @param {(level: 'warn'|'error', message: string) => void} options.log
   * @param {() => boolean} [options.online] Whether the browser has a network (`navigator.onLine`).
   * @param {() => number} [options.random] In [0, 1): the jitter of the retry delay.
   * @param {(state: string) => void} [options.onState] The mapped state changed, while signed in.
   * @param {() => void} [options.onOpened] A resumed session that was waiting for the master is open: the
   *   state is `ready` and `identity()` is what `user_info` says (the owner tells the app both).
   * @param {(change: {changed: boolean}) => void} [options.onReconnected] The master came back; `changed`
   *   says `user_info` now names another user or network.
   * @param {() => void} [options.onExpired] The master refused the session.
   */
  constructor({
    makeConnection, log, online = () => true, random = Math.random, onState, onOpened, onReconnected, onExpired,
  }) {
    this.#makeConnection = makeConnection;
    this.#log = log;
    this.#online = online;
    this.#random = random;
    this.#onState = onState;
    this.#onOpened = onOpened;
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
      this.#expired = false;
      const info = await connection.connect();
      if (this.#connection !== connection) return SUPERSEDED;
      this.#sessionId = sessionId;
      this.#signedIn = true;
      this.#confirmed = true;
      this.#adopt(info);
      this.#lastError = null;
      this.#state = CONNECTION_STATE.READY;
      this.#masterState = 'ready';
      this.#listen(connection);
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
   * Resume a stored session: signed in at once, as `stored` says (what storage
   * knows: the user's and the network's ids, no names), while the master
   * connects. Answers the first attempt as {@link open} does, and says nothing
   * about it through the callbacks: `null` (the master accepted it; `user_info`
   * is adopted), `session_expired` (refused: the session stays as it is until
   * the caller drops it), `unavailable` or {@link SUPERSEDED}. `unavailable` is
   * not the end of it: the session stays signed in, `reconnecting` (or
   * `offline`), and the master is tried again on the backoff, and at once when
   * the network comes back, until it opens (`onOpened`) or refuses the session
   * (`onExpired`). Only a connection that cannot even be made leaves the user
   * signed out.
   * @param {string} sessionId
   * @param {{userId?: string|null, networkId?: string|null}} [stored]
   * @returns {Promise<null|'session_expired'|'unavailable'|typeof SUPERSEDED>}
   */
  async resume(sessionId, { userId = null, networkId = null } = {}) {
    let connection;
    try {
      connection = this.#makeConnection(sessionId);
    } catch (error) {
      const failure = failureOf(error?.code);
      this.#log('warn', `the master did not accept the session (${failure.code})`);
      this.#lastError = failure;
      return failure.code;
    }
    this.#stopRetry();
    this.#connection = connection;
    this.#sessionId = sessionId;
    this.#signedIn = true;
    this.#confirmed = false;
    this.#expired = false;
    this.#masterUser = null;
    this.#user = text(userId) ? { id: userId, name: null } : null;
    this.#network = text(networkId) ? { id: networkId, name: null } : null;
    this.#lastError = null;
    this.#state = CONNECTION_STATE.CONNECTING;
    this.#masterState = 'idle';

    const first = await this.#attemptResume(connection, { quiet: true });
    if (first === SUPERSEDED) return first;
    if (first === HOST_ERRORS.SESSION_EXPIRED) {
      this.#expired = true;
      this.#lastError = failureOf(first);
      return first;
    }
    // Open or waiting: from here on, what the master says is heard (a call can bring it up too).
    this.#listen(connection);
    if (first === HOST_ERRORS.UNAVAILABLE) {
      this.#state = this.#online() ? CONNECTION_STATE.RECONNECTING : CONNECTION_STATE.OFFLINE;
      this.#scheduleRetry(connection);
    }
    return first;
  }

  /**
   * One attempt at the master for a resumed session. Answers `null` when it is
   * open (confirmed here, quietly or with `onOpened`), `session_expired`,
   * `unavailable` (with `lastError` set and a retry due), or SUPERSEDED.
   */
  async #attemptResume(connection, { quiet = false } = {}) {
    this.#retrying = true;
    let info = null;
    let failure = null;
    try {
      info = await connection.connect();
    } catch (error) {
      failure = failureOf(error?.code);
    } finally {
      this.#retrying = false;
    }
    if (connection !== this.#connection) return SUPERSEDED;
    if (this.#confirmed) return null;   // brought up meanwhile, by an attempt a call made
    if (!failure) {
      this.#confirm(connection, info, quiet);
      return null;
    }
    if (failure.code === HOST_ERRORS.SESSION_EXPIRED) return failure.code;
    if (quiet) this.#log('warn', 'the master could not be reached for the stored session (unavailable); it is tried again');
    this.#lastError = failure;
    this.#failed = true;
    return failure.code;
  }

  /** A resumed session's retry, from the timer or the network coming back. */
  async #retryResume(connection) {
    if (this.#retrying || connection !== this.#connection || !this.#signedIn || this.#confirmed) return;
    if (!this.#online()) return;   // `networkChanged()` retries when the network is back
    const outcome = await this.#attemptResume(connection);
    if (outcome === HOST_ERRORS.SESSION_EXPIRED) {
      this.#expire(connection);
    } else if (outcome === HOST_ERRORS.UNAVAILABLE) {
      this.#announce(this.#online() ? CONNECTION_STATE.RECONNECTING : CONNECTION_STATE.OFFLINE);
      this.#scheduleRetry(connection);
    }
  }

  /** A resumed session is open: take what `user_info` says, and (unless the caller is told directly) say so. */
  #confirm(connection, info, quiet) {
    if (this.#confirmed || connection !== this.#connection || !this.#signedIn) return;
    this.#confirmed = true;
    this.#adopt(info);
    this.#lastError = null;
    this.#masterState = 'ready';
    this.#stopRetry();
    this.#state = CONNECTION_STATE.READY;
    if (!quiet) this.#onOpened?.();
  }

  /** The master came up for a resumed session through an attempt that was not the resume's own (a call's). */
  async #confirmFromMaster(connection) {
    let info;
    try {
      info = await connection.connect();   // `ready`: what `user_info` said, at once
    } catch {
      return;
    }
    this.#confirm(connection, info, false);
  }

  /** The master refused the session: tell the owner, once, and try nothing more. */
  #expire(connection) {
    if (connection !== this.#connection || this.#expired) return;
    this.#expired = true;
    this.#stopRetry();
    this.#lastError = failureOf(HOST_ERRORS.SESSION_EXPIRED);
    this.#onExpired?.();
  }

  #listen(connection) {
    connection.onStateChange?.((state) => this.#onMasterState(connection, state));
    connection.onReconnected?.((fresh) => this.#onMasterReconnected(connection, fresh));
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
    this.#confirmed = false;
    this.#expired = false;
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
    if (!this.#confirmed) {
      // A resumed session the master has not accepted yet: still connecting, or waiting to retry.
      this.#announce(this.#failed ? CONNECTION_STATE.RECONNECTING : CONNECTION_STATE.CONNECTING);
      if (this.#failed) {
        this.#clearRetryTimer();
        void this.#retryResume(connection);
      }
      return;
    }
    this.#announce(connectionStateOf(this.#masterState, true) ?? CONNECTION_STATE.READY);
    if (this.#failed) {
      this.#clearRetryTimer();
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
      this.#expire(connection);
      return;
    }
    if (!this.#confirmed) {
      // A resumed session's own attempts say how they end. One a call started that brings the
      // master up confirms it; anything else waits for the resume's next attempt.
      if (masterState === 'ready' && !this.#retrying) void this.#confirmFromMaster(connection);
      return;
    }
    const next = connectionStateOf(masterState, this.#online());
    if (!next) return;
    if (failed) this.#lastError = failureOf(connection.lastError?.code);
    else if (next === CONNECTION_STATE.READY) {
      this.#lastError = null;
      this.#stopRetry();
    }
    this.#announce(next);
    if (failed) {
      this.#failed = true;
      this.#scheduleRetry(connection);
    }
  }

  #onMasterReconnected(connection, fresh) {
    if (connection !== this.#connection) return;
    if (!this.#confirmed) {
      if (!this.#retrying) this.#confirm(connection, fresh, false);
      return;
    }
    const before = JSON.stringify(this.identity());
    if (isPlainObject(fresh)) this.#adopt(fresh);
    this.#lastError = null;
    this.#state = CONNECTION_STATE.READY;
    this.#masterState = 'ready';
    this.#stopRetry();
    this.#onReconnected?.({ changed: before !== JSON.stringify(this.identity()) });
  }

  /** Ask for a retry after the backoff, unless one is due, running, or waiting for the network. */
  #scheduleRetry(connection) {
    if (this.#retryTimer !== null || this.#retrying) return;
    // No network: no timer. `networkChanged()` retries when it comes back.
    if (!this.#online()) return;
    const delay = Math.min(backoffDelayMs(this.#attempts, DEFAULT_BACKOFF, this.#random), MAX_TIMER_MS);
    this.#attempts += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void (this.#confirmed ? this.#retry(connection) : this.#retryResume(connection));
    }, delay);
  }

  /**
   * Connect the master again. Success is the master's own `ready` and
   * `onReconnected`; a refused session is its `failed` with `session_expired`.
   * Any other failure leaves the master `failed`, and the next retry is booked.
   */
  async #retry(connection) {
    if (this.#retrying || connection !== this.#connection || !this.#signedIn || !this.#failed) return;
    if (!this.#online()) return;   // `networkChanged()` retries when the network is back
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

  /**
   * The link is up again, the session is over, or the host stopped: no retry is
   * due, and the next loss starts the backoff over at the first step (a new
   * session must not inherit the last one's 30 s).
   */
  #stopRetry() {
    this.#clearRetryTimer();
    this.#failed = false;
    this.#attempts = 0;
  }

  async #closeQuietly(connection) {
    try {
      await connection.close?.();
    } catch (error) {
      this.#log('warn', `a connection did not close cleanly (${error?.name ?? 'error'})`);
    }
  }
}
