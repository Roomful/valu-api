// ===========================================================================
// The host's master socket.
//
// `ValuSocketConnection` (src/socket/ValuSocketConnection.js) is the
// `{sessionId}` door: it opens the Roomful socket, authorizes it on `user_info`
// and says so when it drops and comes back. It was written for a script that
// owns one connection for the life of a process, and it has four edges that a
// host which must outlive every network blip cannot live with:
//
//   - once `failed` it never recovers, and it never closes its socket;
//   - a `connect()` that rejected stays rejected;
//   - the 120 s watchdog is cleared by a bare transport reconnect, so a socket
//     that comes back but is never re-authorized stays `reconnecting` forever;
//   - `emit` answers 503 at once while the socket is down, and the read policy
//     retries for under a second — shorter than one reconnect.
//
// This class owns ONE instance at a time and adds the rules (spec §4.2, §4.11):
//
//   - HOLD. A call made while the socket is reconnecting (or while a
//     replacement is connecting) waits for it, up to min(reconnectGraceMs,
//     the call's own timeout), and only then answers 503 `disconnected`. The
//     time spent waiting comes off the ack timeout, so the call as a whole
//     never outlasts the budget it was given.
//   - REPLACE. A lost connection is closed when it is declared lost, and the
//     next call that needs a socket builds a fresh one with the same session.
//     A connection that fails to come up is closed and dropped the same way,
//     so a rejected `connect()` is never sticky.
//   - CLASSIFY. When a connection cannot be had, `GET /api/v1/auth/check` says
//     why: a JSON body with `error.code === 401` means the master refused the
//     session (`code: 'session_expired'`); anything else is `'unavailable'`.
//     A refused session is reported, not retried: calls answer 503 until
//     somebody calls `connect()` again with a session worth trying.
//   - SWITCH. `switchNetwork` runs the `network:switch` RPC Valu Social runs
//     and hands back the new session id. It never reconnects this connection.
//
// Like everything that leaves `ValuSocketConnection`, nothing built here
// contains the session id: errors carry the instance's already-redacted
// message and no `cause`, and `lastError` is one of them.
//
// `socket` is the live `ValuSocketConnection`. Its `transport` is the raw
// socket.io socket, whose URL contains the session: never serialize or post it.
// ===========================================================================
import { ERROR_CODES, errorAck } from '../Errors.js';
import { DEFAULT_TIMEOUT_MS } from '../CallPolicy.js';
import {
  DEFAULT_API_HOST, RECOVERY_TIMEOUT_MS, ValuSocketConnection,
} from '../socket/ValuSocketConnection.js';
import { HOST_ERRORS } from './protocol.js';

/** How long a call waits for a reconnect before it answers 503 (spec §4.11). */
export const RECONNECT_GRACE_MS = 20_000;

/** How long `auth/check` may take before the failure it was asked about is reported without it. */
export const AUTH_CHECK_TIMEOUT_MS = 10_000;

/** The error code of a connection that could not be had for a reason other than a refused session. */
export const MASTER_UNAVAILABLE = 'unavailable';

/** The RPC Valu Social uses to move a user into another network. */
export const NETWORK_SWITCH = 'network:switch';

/**
 * @typedef {'idle'|'connecting'|'ready'|'reconnecting'|'failed'|'closed'} MasterState
 *
 * `idle` before the first `connect()`; `connecting` while an instance
 * handshakes (the first, or a replacement); `ready`; `reconnecting` while the
 * instance's transport is down and retrying; `failed` once an instance was
 * declared lost or could not connect (it is already closed; the next call
 * replaces it); `closed` after `close()`.
 */

/**
 * @typedef {object} MasterInfo What `user_info` said, which is authoritative.
 * @property {string|null} userId
 * @property {string|null} networkId
 * @property {Record<string, unknown>|null} user
 * @property {Record<string, unknown>|null} network
 */

/** An `Error` whose `code` says what the host should do about it. */
const codedError = (code, message) => Object.assign(new Error(message), { code });

const closedError = () => codedError(MASTER_UNAVAILABLE, 'the master connection was closed');

/** The call could not be made on any connection. */
const disconnected = (ns, why) => errorAck(ERROR_CODES.DISCONNECTED, `emit ${ns}: disconnected (${why})`);

const HOLD_TIMED_OUT = Symbol('hold timed out');

export class MasterConnection {
  #sessionId;
  #io;
  #host;
  #fetchImpl;
  #fetchForCheck;
  #graceMs;
  #recoveryMs;
  #checkTimeoutMs;
  #createConnection;

  /** @type {ValuSocketConnection|null} */
  #connection = null;
  /** @type {MasterState} */
  #state = 'idle';
  /** @type {Error|null} */
  #lastError = null;
  /** The master refused the session; only an explicit `connect()` tries it again. */
  #refused = false;
  /** @type {Promise<MasterInfo>|null} The handshake in progress, shared by every caller. */
  #attempt = null;
  /** Fails the handshake in progress: `close()` and a loss mid-handshake both need it to stop waiting. */
  #abortAttempt = null;
  /**
   * What a held call waits on. It exists exactly while the state is
   * `connecting` or `reconnecting`, and resolves when that ends, one way or
   * the other: the call then reads the state to see which.
   * @type {{promise: Promise<void>, resolve: Function}|null}
   */
  #gate = null;
  #recoveryTimer = null;
  #dropReason = 'disconnect';

  #stateHandlers = new Set();
  #reconnectedHandlers = new Set();
  /** @type {Map<string, Set<Function>>} */
  #pushHandlers = new Map();

  /**
   * @param {object} options
   * @param {string} options.sessionId The user's Roomful session for this network.
   * @param {Function} options.io The socket.io-client factory. Pass it: valu-api
   *   has no socket.io dependency, and the host bundle must not gain a second copy.
   * @param {Function} [options.fetchImpl] `fetch`, for the instance's bootstrap
   *   and for `auth/check`. Used exactly as given, so the CALLER binds it
   *   (`fetch.bind(globalThis)`): a bare `fetch` fails with "Illegal invocation"
   *   in a browser. When omitted the instance falls back to the global one.
   * @param {string} [options.host] The master's API host.
   * @param {number} [options.reconnectGraceMs] The longest a call waits for a
   *   reconnect, capped by the call's own timeout.
   * @param {number} [options.recoveryTimeoutMs] How long a connection may stay
   *   down before it is declared lost. The instance has the same watchdog, but
   *   clears it on a bare transport reconnect; this one is cleared only by
   *   `user_info`.
   * @param {number} [options.authCheckTimeoutMs]
   * @param {(options: object) => ValuSocketConnection} [options.createConnection]
   *   How an instance is built. Called with `{ sessionId, io, fetchImpl, host,
   *   recoveryTimeoutMs, onConnectionLost }`.
   */
  constructor({
    sessionId,
    io,
    fetchImpl,
    host = DEFAULT_API_HOST,
    reconnectGraceMs = RECONNECT_GRACE_MS,
    recoveryTimeoutMs = RECOVERY_TIMEOUT_MS,
    authCheckTimeoutMs = AUTH_CHECK_TIMEOUT_MS,
    createConnection = (options) => new ValuSocketConnection(options),
  } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new TypeError('MasterConnection needs a sessionId.');
    }
    this.#sessionId = sessionId;
    this.#io = io;
    this.#host = host;
    this.#fetchImpl = fetchImpl;
    this.#fetchForCheck = fetchImpl ?? globalThis.fetch?.bind(globalThis) ?? null;
    this.#graceMs = reconnectGraceMs;
    this.#recoveryMs = recoveryTimeoutMs;
    this.#checkTimeoutMs = authCheckTimeoutMs;
    this.#createConnection = createConnection;
  }

  // --- what the host reads -------------------------------------------------

  /** @returns {MasterState} */
  get state() { return this.#state; }

  /**
   * The live instance — a `ValuSocket` — or `null` when there is none (before
   * the first connect, between a loss and the next call, after `close()`). It
   * changes when the instance is replaced: services built over it must be
   * rebuilt then (spec §4.7).
   * @returns {ValuSocketConnection|null}
   */
  get socket() { return this.#connection; }

  /**
   * Why the last attempt failed, or the connection was lost: an `Error` whose
   * `code` is `'session_expired'` or `'unavailable'`. `null` while connected.
   * @returns {Error|null}
   */
  get lastError() { return this.#lastError; }

  /**
   * @param {(state: MasterState, previous: MasterState) => void} handler
   * @returns {() => void} unsubscribe
   */
  onStateChange(handler) {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  /**
   * Fired after a dropped connection comes back AND re-authorizes: with the
   * `user_info` it re-read, which is where a changed network or user shows up.
   * @param {(info: MasterInfo) => void} handler
   * @returns {() => void} unsubscribe
   */
  onReconnected(handler) {
    this.#reconnectedHandlers.add(handler);
    return () => this.#reconnectedHandlers.delete(handler);
  }

  /**
   * Subscribe to a platform push (`request:created`, `channel:onMessageCreated`,
   * …). Delivered exactly as it arrived, and it follows the connection across a
   * replacement: subscribe once.
   * @param {string} event
   * @param {(payload: any) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(event, handler) {
    let handlers = this.#pushHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.#pushHandlers.set(event, handlers);
      if (this.#connection) this.#bindPush(this.#connection, event);
    }
    handlers.add(handler);
    return () => this.#pushHandlers.get(event)?.delete(handler);
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Open the connection and authorize it. Idempotent: concurrent callers share
   * one handshake, and a call on an established connection resolves at once.
   *
   * Rejects (the one call here that does) with an `Error` whose `code` is
   * `'session_expired'` — `auth/check` answered a JSON 401 — or
   * `'unavailable'`. A rejection is not sticky: the failed instance is closed,
   * and calling again builds a fresh one.
   * @returns {Promise<MasterInfo>}
   */
  async connect() {
    if (this.#state === 'closed') throw closedError();
    if (this.#state === 'ready' || this.#state === 'reconnecting') return this.#info(this.#connection);
    return this.#attemptOpen();
  }

  /**
   * One RPC, answered as an ack. **Never rejects.**
   *
   * While the connection is down or a replacement is connecting, the call is
   * held (see the header) and sent when it is usable. A lost connection is
   * replaced here, on the call that needs one — unless the master refused the
   * session, which answers 503 until `connect()` is called again.
   * @param {string} ns
   * @param {object} [data] The RPC's own payload; the `{data}` envelope is added below.
   * @param {number} [timeoutMs] The whole call: hold plus ack.
   * @returns {Promise<import('../socket/ValuSocket.js').ValuAck>}
   */
  async emit(ns, data = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    try {
      const startedAt = Date.now();
      const { connection, reason } = await this.#acquire(Math.min(this.#graceMs, timeoutMs));
      if (!connection) return disconnected(ns, reason);
      return await connection.emit(ns, data, Math.max(1, timeoutMs - (Date.now() - startedAt)));
    } catch (error) {
      return disconnected(ns, error?.message ?? String(error));
    }
  }

  /**
   * Ask the master for a session in another network — the call Valu Social
   * makes (`ApplicationStore.js` `#processNetworkSwitch`). Resolves the NEW
   * session id; this connection stays in its own network and session, and
   * nothing reconnects. (`checkOneTimeAuthToken` hands back the minting
   * session itself, which is why a switch must request a new one.)
   *
   * Rejects with `code: 'not_a_member'` when the master answers without one —
   * Valu Social treats an answer with no `data` as a refusal too — and with
   * `code: 'unavailable'` when the call could not be made or timed out, which
   * says nothing about membership.
   * @param {string} networkId
   * @returns {Promise<{sessionId: string}>}
   */
  async switchNetwork(networkId) {
    if (typeof networkId !== 'string' || !networkId) {
      throw new TypeError('switchNetwork needs a network id.');
    }
    const ack = await this.emit(NETWORK_SWITCH, { networkId, requestNewSessionId: true });
    const sessionId = ack?.data?.sessionId;
    if (typeof sessionId === 'string' && sessionId) return { sessionId };

    const code = ack?.error?.code;
    const transport = code === ERROR_CODES.DISCONNECTED || code === ERROR_CODES.TIMEOUT;
    const detail = ack?.error?.message || ack?.error?.description || 'the master answered without a session';
    throw codedError(
      transport ? MASTER_UNAVAILABLE : HOST_ERRORS.NOT_A_MEMBER,
      `network:switch to ${networkId} failed: ${detail}`,
    );
  }

  /** Close the instance, answer every held call, and let go of every subscriber. Idempotent; never throws. */
  async close() {
    if (this.#state === 'closed') return;
    const connection = this.#connection;
    this.#connection = null;
    this.#clearRecovery();
    this.#abortAttempt?.(closedError());
    this.#release();
    this.#setState('closed');
    this.#stateHandlers.clear();
    this.#reconnectedHandlers.clear();
    this.#pushHandlers.clear();
    await this.#discard(connection);
  }

  // --- the handshake -------------------------------------------------------

  #attemptOpen() {
    this.#attempt ??= this.#open();
    return this.#attempt;
  }

  /** Build an instance, connect it, and make it the one this wrapper owns. */
  async #open() {
    this.#arm();
    this.#setState('connecting');
    let connection = null;
    let abort = null;
    try {
      const aborted = new Promise((_, reject) => { abort = reject; });
      this.#abortAttempt = abort;
      aborted.catch(() => {});   // an abort that arrives when nothing is racing it is not an unhandled rejection
      connection = this.#create(() => connection);
      this.#connection = connection;
      this.#wire(connection);
      await Promise.race([connection.connect(), aborted]);
    } catch (cause) {
      throw await this.#fail(connection, cause);
    } finally {
      // Only ours: a state handler may already have started the next attempt.
      if (this.#abortAttempt === abort) this.#abortAttempt = null;
    }
    if (this.#state === 'closed') throw closedError();   // closed in the gap before this resumed

    // The attempt is over BEFORE anyone is told: a state handler that calls
    // `connect()` must start a new one, not be handed this one back.
    this.#attempt = null;
    this.#refused = false;
    this.#lastError = null;
    this.#release();
    this.#setState('ready');
    return this.#info(connection);
  }

  #create(self) {
    return this.#createConnection({
      sessionId: this.#sessionId,
      io: this.#io,
      fetchImpl: this.#fetchImpl,
      host: this.#host,
      recoveryTimeoutMs: this.#recoveryMs,
      onConnectionLost: (reason) => this.#onLost(self(), reason),
    });
  }

  /** Listen to the instance: its drops and recoveries, and every push somebody subscribed to. */
  #wire(connection) {
    connection.onReconnected(() => this.#onReconnected(connection));
    connection.on('disconnect', (reason) => this.#onDisconnect(connection, reason));
    for (const event of this.#pushHandlers.keys()) this.#bindPush(connection, event);
  }

  #bindPush(connection, event) {
    connection.on(event, (payload) => {
      if (connection !== this.#connection) return;
      for (const handler of [...(this.#pushHandlers.get(event) ?? [])]) {
        try { handler(payload); } catch (error) { console.error(`${event} handler threw:`, error); }
      }
    });
  }

  /**
   * The handshake failed: drop the instance and say why. Returns the error to
   * throw rather than throwing, so the caller reads as one `throw`.
   */
  async #fail(connection, cause) {
    if (this.#state === 'closed') return closedError();
    if (this.#connection === connection) this.#connection = null;
    const discarded = this.#discard(connection);
    const error = await this.#classify(cause);
    await discarded;
    if (this.#state === 'closed') return closedError();

    this.#attempt = null;
    this.#refused = error.code === HOST_ERRORS.SESSION_EXPIRED;
    this.#lastError = error;
    this.#release();
    this.#setState('failed');
    return error;
  }

  /** A connection failed; was it the session? */
  async #classify(cause) {
    const reason = cause?.message ?? String(cause);
    return await this.#sessionRefused()
      ? codedError(HOST_ERRORS.SESSION_EXPIRED, `the master refused the session (auth/check answered 401): ${reason}`)
      : codedError(MASTER_UNAVAILABLE, `master unavailable: ${reason}`);
  }

  /**
   * `GET /api/v1/auth/check` with the session. The master signals a refusal in
   * the JSON body (`error.code === 401`) and answers HTTP 200 for it, so the
   * body is the only thing read. A check that cannot be made, does not answer
   * in time, or does not answer JSON is not a refusal.
   */
  async #sessionRefused() {
    if (!this.#fetchForCheck) return false;
    let timer;
    try {
      const check = (async () => {
        const response = await this.#fetchForCheck(`https://${this.#host}/api/v1/auth/check`, {
          method: 'GET',
          headers: { 'X-Session-Id': this.#sessionId },
        });
        return (await response.json())?.error?.code === 401;
      })();
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(reject, this.#checkTimeoutMs, new Error('auth/check timed out'));
      });
      return await Promise.race([check, timeout]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // --- what the instance tells us ------------------------------------------

  #onDisconnect(connection, reason) {
    if (connection !== this.#connection || this.#state !== 'ready') return;
    this.#dropReason = String(reason ?? 'disconnect');
    this.#arm();
    this.#setState('reconnecting');
    this.#armRecovery(connection);
  }

  #onReconnected(connection) {
    if (connection !== this.#connection || this.#state !== 'reconnecting') return;
    this.#clearRecovery();
    this.#release();
    this.#setState('ready');
    const info = this.#info(connection);
    for (const handler of [...this.#reconnectedHandlers]) {
      try { handler(info); } catch (error) { console.error('reconnected handler threw:', error); }
    }
  }

  /** The instance's watchdog fired, or ours did. */
  #onLost(connection, reason) {
    if (!connection || connection !== this.#connection) return;
    if (this.#state === 'connecting') {
      // The handshake's own failure path takes it from here.
      this.#abortAttempt?.(codedError(MASTER_UNAVAILABLE, reason));
      return;
    }
    this.#clearRecovery();
    this.#connection = null;
    this.#lastError = codedError(MASTER_UNAVAILABLE, reason);
    this.#discard(connection);
    this.#release();
    this.#setState('failed');
  }

  /** Down, and the clock is running: only `user_info` stops it. */
  #armRecovery(connection) {
    this.#clearRecovery();
    this.#recoveryTimer = setTimeout(() => {
      this.#recoveryTimer = null;
      this.#onLost(connection, `connection lost: ${this.#dropReason}`);
    }, this.#recoveryMs);
    // Unref'd, like the instance's: nobody awaits it, and it must not be what
    // keeps a process alive. A held call has its own timer, which is not.
    this.#recoveryTimer.unref?.();
  }

  #clearRecovery() {
    if (this.#recoveryTimer) clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = null;
  }

  // --- holding a call ------------------------------------------------------

  /**
   * A usable instance for a call, waiting up to `holdMs` for one. A call that
   * finds the connection lost (now, or while it waits) starts ONE replacement
   * and waits for that; a replacement that fails answers it, so a network that
   * is down does not become a retry loop.
   * @returns {Promise<{connection?: ValuSocketConnection, reason?: string}>}
   */
  async #acquire(holdMs) {
    const deadline = Date.now() + holdMs;
    let replaced = false;
    for (;;) {
      switch (this.#state) {
        case 'closed': return { reason: 'connection closed' };
        case 'idle': return { reason: 'not connected' };
        case 'ready': return { connection: this.#connection };
        case 'failed':
          if (this.#refused) return { reason: 'session expired' };
          if (replaced) return { reason: 'connection lost' };
          replaced = true;
          // The failure is `lastError`; this call only needs to know when the attempt is over.
          this.#attemptOpen().catch(() => {});
          break;
        default: break;   // connecting | reconnecting: wait below
      }

      let timer;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), HOLD_TIMED_OUT);
      });
      const outcome = await Promise.race([this.#gate.promise, timedOut]);
      clearTimeout(timer);
      if (outcome === HOLD_TIMED_OUT) return { reason: `still ${this.#state} after ${holdMs}ms` };
      // The state changed: look at what it is now.
    }
  }

  #arm() {
    if (this.#gate) return;
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    this.#gate = { promise, resolve };
  }

  /** The state a held call waits on is about to change (or already has): let it look. */
  #release() {
    const gate = this.#gate;
    this.#gate = null;
    gate?.resolve();
  }

  // --- small things --------------------------------------------------------

  #setState(next) {
    const previous = this.#state;
    if (previous === next) return;
    this.#state = next;
    for (const handler of [...this.#stateHandlers]) {
      try { handler(next, previous); } catch (error) { console.error('state handler threw:', error); }
    }
  }

  /** @returns {MasterInfo} */
  #info(connection) {
    return {
      userId: connection.selfUserId ?? connection.userId ?? null,
      networkId: connection.networkId ?? null,
      user: connection.user ?? null,
      network: connection.network ?? null,
    };
  }

  /** Close an instance. Never throws, and `null` is fine. */
  async #discard(connection) {
    try { await connection?.close(); } catch { /* a dead socket is still closed */ }
  }
}
