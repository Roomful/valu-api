// ===========================================================================
// A Roomful platform socket this package opens itself.
//
// Until now the rule was "this package never opens the connection" — the Valu
// Social application handed in its WebSocket service, the Valu Guru server
// handed in its connection manager, and a runtime with no connection of its own
// had no way in at all. That excluded every caller who has a session and
// nothing else: a script, a CLI, a test harness, a mobile shell, and
// eventually a framed application allowed to open its own socket.
//
// So there are two doors now, and `openValuSocket` (src/socket/open.js) is
// where they meet:
//
//   openValuSocket({ sessionId })   ← this file: open it and authorize it
//   openValuSocket({ socket })      ← adapt a socket that is already authorized
//
// Both end at the same `ValuSocket`, and nothing above this file can tell which
// door a socket came through.
//
// The handshake is the one the two existing clients already perform, in the
// same order, against the same endpoints (valusocial-web
// src/Services/WebSocket/WebSocket.js, valu-guru-server
// src/server-agents/roomful-connection.ts):
//
//   init.client (resolve the network, maybe a redirect)
//     → socket.io handshake with the session id
//     → resolve on the server's `user_info` push
//
// ## The session id
//
// The credential here is the user's Roomful `sessionId` — the same one the web
// client holds. It is NOT an application token: it carries everything the user
// can do, it does not expire on a timer anyone here controls, and it cannot be
// scoped. Three consequences, all enforced below:
//
//   1. It is never read back. There is no getter, `describe()` omits it, and
//      no error message or trace built here contains it (`#redact`).
//   2. It never reaches a service call. `assertNoCredentialLeak`
//      (src/auth/TokenStore.js) already refuses a params object carrying one,
//      and that check is unchanged by this file.
//   3. This door is for FIRST-PARTY runtimes — the ones that already hold the
//      session, which is the application itself and a process the user runs.
//      A third-party framed app gets a socket when it can be handed a scoped,
//      revocable token and the dispatch side enforces it (Phase 3.3,
//      docs/authorization.md), and not before. Having this constructor does not
//      make that day arrive early.
// ===========================================================================
import { ERROR_CODES, errorAck } from '../Errors.js';
import { DEFAULT_TIMEOUT_MS } from '../CallPolicy.js';
import { VALU_SOCKET } from './ValuSocket.js';
import { emitOverSocketIo, loadSocketIo, SOCKET_IO_OPTIONS } from './socketio.js';
import { readUserInfo, displayNameOf } from './user-info.js';

/** Where the platform lives unless told otherwise. Mirrors `ROOMFUL_API_HOST`. */
export const DEFAULT_API_HOST = 'api.roomful.net';

/** How long to wait for `user_info` before calling the handshake failed. */
export const READY_TIMEOUT_MS = 20_000;

/**
 * How long an ESTABLISHED connection may stay down — socket.io retrying
 * underneath — before it is declared lost. Long enough to ride out a platform
 * redeploy, short enough that a revoked session does not leave a zombie.
 */
export const RECOVERY_TIMEOUT_MS = 120_000;

/** @typedef {'idle'|'connecting'|'ready'|'reconnecting'|'failed'|'closed'} ValuConnectionState */

/**
 * One authorized Roomful socket, owned by this package.
 *
 * @implements {import('./ValuSocket.js').ValuSocket}
 */
export class ValuSocketConnection {
  /** @see VALU_SOCKET */
  [VALU_SOCKET] = true;

  #sessionId;
  #host;
  #gate;
  #io;
  #fetchImpl;
  #bootstrap;
  #socketOptions;
  #timeoutMs;
  #readyTimeoutMs;
  #recoveryTimeoutMs;

  #socket = null;
  #userId;
  #networkId;
  #selfUserId = null;
  #user = null;
  #network = null;
  #displayName = null;

  /** @type {Promise<ValuSocketConnection>|null} */
  #ready = null;
  #resolveReady = null;
  #rejectReady = null;
  /** @type {ValuConnectionState} */
  #state = 'idle';
  #connectedAt = null;
  #lastError = null;
  #connectErrors = 0;
  #readyTimer = null;
  #recoveryTimer = null;

  #resourceHandlers = new Set();
  #reconnectedHandlers = new Set();
  #lostHandlers = new Set();
  /** @type {Map<string, Set<Function>>} */
  #eventHandlers = new Map();

  /**
   * @param {object} options
   * @param {string} options.sessionId The user's Roomful session id. Required —
   *   the other door takes a socket instead (`openValuSocket({ socket })`).
   * @param {string} [options.host] API host. Defaults to `ROOMFUL_API_HOST` or
   *   `api.roomful.net`; `init.client` may redirect it.
   * @param {Function} [options.io] The `socket.io-client` factory. Pass it:
   *   this package has no socket.io dependency (src/socket/socketio.js).
   * @param {Function} [options.fetchImpl] `fetch`, for the bootstrap call.
   * @param {boolean} [options.bootstrap] Perform the `init.client` /
   *   `init.plugin` bootstrap. Default true when a `fetch` exists. Turn it off
   *   in a runtime that has already done it (the Valu Social application has)
   *   and pass `networkId` instead.
   * @param {string} [options.userId] Who you expect to be. Resolved from
   *   `user_info` either way; passing it only names the connection sooner.
   * @param {string} [options.networkId] Starting network id. `init.client` and
   *   then `user_info` override it.
   * @param {object} [options.socketOptions] Merged over
   *   {@link SOCKET_IO_OPTIONS}. For a runtime whose client needs something
   *   different — not for changing `path` or `transports`, which the platform
   *   fixes.
   * @param {number} [options.timeoutMs] Default per-call ack timeout.
   * @param {number} [options.readyTimeoutMs]
   * @param {number} [options.recoveryTimeoutMs]
   * @param {(reason: string) => void} [options.onConnectionLost]
   */
  constructor({
    sessionId,
    host,
    io,
    fetchImpl,
    bootstrap,
    userId,
    networkId,
    socketOptions,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    readyTimeoutMs = READY_TIMEOUT_MS,
    recoveryTimeoutMs = RECOVERY_TIMEOUT_MS,
    onConnectionLost,
  } = {}) {
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new TypeError(
        'ValuSocketConnection needs a sessionId. To use a socket that is already '
        + 'open and authorized, pass it instead: openValuSocket({ socket }).',
      );
    }
    this.#sessionId = sessionId;
    this.#host = host || globalThis.process?.env?.ROOMFUL_API_HOST || DEFAULT_API_HOST;
    this.#gate = `https://${this.#host}`;
    this.#io = io;
    this.#fetchImpl = fetchImpl ?? globalThis.fetch?.bind(globalThis) ?? null;
    this.#bootstrap = bootstrap ?? Boolean(this.#fetchImpl);
    this.#socketOptions = socketOptions ?? {};
    this.#timeoutMs = timeoutMs;
    this.#readyTimeoutMs = readyTimeoutMs;
    this.#recoveryTimeoutMs = recoveryTimeoutMs;
    this.#userId = userId ?? null;
    this.#networkId = networkId ?? 'roomful';
    if (onConnectionLost) this.#lostHandlers.add(onConnectionLost);
  }

  // --- the ValuSocket contract ---------------------------------------------

  get userId() { return this.#userId ?? this.#selfUserId; }
  get networkId() { return this.#networkId; }
  get selfUserId() { return this.#selfUserId; }

  /** @returns {ValuConnectionState} */
  get state() { return this.#state; }
  get connected() { return this.#state === 'ready' && Boolean(this.#socket?.connected); }
  /** Wall-clock ms when the socket first became ready; null before that. */
  get connectedAt() { return this.#connectedAt; }
  /** The API host in use — after `init.client`, which may have redirected it. */
  get host() { return this.#host; }
  /** The signed-in user's profile from `user_info`; null until ready. */
  get user() { return this.#user; }
  /** The active network object from `user_info`; null until ready. */
  get network() { return this.#network; }
  get displayName() { return this.#displayName; }
  /** The socket.io socket, for consumers that key per-connection state. */
  get transport() { return this.#socket; }

  /**
   * @param {string} ns
   * @param {object} [data] The RPC's own payload; the `{data}` envelope is added
   *   by `emitOverSocketIo`.
   * @param {number} [timeoutMs]
   * @returns {Promise<import('./ValuSocket.js').ValuAck>}
   */
  emit(ns, data = {}, timeoutMs = this.#timeoutMs) {
    if (this.#state === 'closed') {
      return Promise.resolve(errorAck(ERROR_CODES.DISCONNECTED, `emit ${ns}: connection closed`));
    }
    return emitOverSocketIo(this.#socket, ns, data, timeoutMs);
  }

  /**
   * `resource:updated` pushes. Present always — a socket.io socket can always
   * subscribe — so `SocketTransport.supportsPush` is true over this connection.
   * @param {(data: any) => void} handler
   * @returns {() => void} unsubscribe
   */
  onResourceUpdated(handler) {
    this.#resourceHandlers.add(handler);
    return () => this.#resourceHandlers.delete(handler);
  }

  // --- lifecycle ------------------------------------------------------------

  /**
   * Open the socket and authorize it. Idempotent: concurrent callers share one
   * handshake, and a second call after it succeeded resolves immediately.
   *
   * This is the one call in this package that REJECTS rather than resolving an
   * error envelope, because there is no ack to put the failure in — the
   * connection every ack would have travelled over is what failed.
   * @returns {Promise<ValuSocketConnection>}
   */
  async connect() {
    if (this.#ready) return this.#ready;
    if (this.#state === 'closed') throw new Error('this connection was closed; open a new one');

    this.#state = 'connecting';
    this.#ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });

    try {
      if (this.#bootstrap) await this.#runBootstrap();
      await this.#openSocket();
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(this.#redact(String(error))));
    }
    return this.#ready;
  }

  /** Fired after a dropped connection comes back and re-authorizes. */
  onReconnected(handler) {
    this.#reconnectedHandlers.add(handler);
    return () => this.#reconnectedHandlers.delete(handler);
  }

  /** Fired once when an established connection is lost for good. */
  onConnectionLost(handler) {
    this.#lostHandlers.add(handler);
    return () => this.#lostHandlers.delete(handler);
  }

  /**
   * Subscribe to any platform push on this socket — `channel:onMessageCreated`,
   * `request:created`, whatever the platform sends. The payload is forwarded
   * exactly as it arrived, envelope and all: this package does not know the
   * shape of an event it does not declare.
   * @param {string} event
   * @param {(payload: any) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(event, handler) {
    if (!this.#eventHandlers.has(event)) {
      this.#eventHandlers.set(event, new Set());
      // Bind lazily, and once per event name: a consumer adding a second
      // handler must not make the platform's push arrive twice.
      this.#socket?.on(event, (payload) => this.#fanOut(event, payload));
    }
    this.#eventHandlers.get(event).add(handler);
    return () => this.#eventHandlers.get(event)?.delete(handler);
  }

  /** Close the socket. Idempotent, and never throws. */
  async close() {
    this.#state = 'closed';
    this.#clearTimer('ready');
    this.#clearTimer('recovery');
    const socket = this.#socket;
    this.#socket = null;
    try {
      socket?.removeAllListeners?.();
      socket?.close?.();
      socket?.disconnect?.();
    } catch { /* a dead socket is still closed */ }
    this.#resourceHandlers.clear();
    this.#reconnectedHandlers.clear();
    this.#eventHandlers.clear();
  }

  /**
   * What goes in a log line: the host, the ids, the state — and **never** the
   * session id. The whole object is safe to print.
   */
  describe() {
    return {
      host: this.#host,
      state: this.#state,
      networkId: this.#networkId,
      userId: this.userId,
      selfUserId: this.#selfUserId,
      connectedAt: this.#connectedAt,
      connectErrors: this.#connectErrors,
      lastError: this.#lastError,
      /** Stated, not shown — so a reader can tell "no session" from "redacted". */
      session: 'present (redacted)',
    };
  }

  // --- the handshake --------------------------------------------------------

  /**
   * `init.client` resolves the network the session belongs to, and may redirect
   * to another deployment's host; `init.plugin` is the front-end menu config
   * and is wanted by nothing here. Both are BEST-EFFORT: the socket handshake
   * carries the credential, so a failure here costs the resolved network id
   * (which `user_info` supplies again anyway) and nothing else.
   *
   * It is still worth doing, and worth logging when it fails: a 401 here is the
   * clearest "this session is dead" signal there is, arriving seconds before a
   * socket that simply never says `user_info`.
   */
  async #runBootstrap() {
    if (!this.#fetchImpl) return;
    try {
      const response = await this.#fetchImpl(`${this.#gate}/api/v0/publicRpc/init.client`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Id': this.#sessionId },
        body: JSON.stringify({ domainName: this.#host, origin: this.#gate, referer: '' }),
      });
      if (!response?.ok) {
        this.#lastError = `init.client HTTP ${response?.status ?? '?'}`;
        return;
      }
      const json = await response.json();
      const data = json?.data ?? {};
      const networkId = data.networkId ?? data.sessionNetworkId;
      if (networkId) this.#networkId = String(networkId);
      if (typeof data.endpoint === 'string' && data.endpoint && data.endpoint !== this.#gate) {
        try {
          const { host } = new URL(data.endpoint);
          this.#host = host;
          this.#gate = `https://${host}`;
        } catch { /* an unparseable redirect leaves the default host */ }
      }
    } catch (error) {
      this.#lastError = `init.client failed: ${this.#redact(error?.message ?? String(error))}`;
    }
  }

  async #openSocket() {
    const io = await loadSocketIo(this.#io);
    // The credential rides the handshake query, exactly as both existing
    // clients send it. This URL is the one string in the package that contains
    // the session id: it is built here, used on the next line, and never
    // stored, returned or logged.
    const url = `wss://${this.#host}?sessionId=${encodeURIComponent(this.#sessionId)}`;
    const socket = io(url, { ...SOCKET_IO_OPTIONS, ...this.#socketOptions });
    this.#socket = socket;

    socket.on('user_info', (payload) => this.#onUserInfo(payload));
    socket.on('resource:updated', (payload) => {
      for (const handler of this.#resourceHandlers) {
        try { handler(payload); } catch (error) { console.error('resource:updated handler threw:', error); }
      }
    });
    socket.on('connect', () => {
      this.#connectErrors = 0;
      this.#clearTimer('recovery');
    });
    socket.on('disconnect', (reason) => {
      if (this.#state === 'ready') this.#state = 'reconnecting';
      this.#armRecovery(String(reason ?? 'disconnect'));
    });
    const onConnectError = (kind) => (error) => {
      this.#connectErrors++;
      this.#lastError = `${kind}: ${this.#redact(error?.message ?? String(error))}`;
    };
    socket.on('connect_error', onConnectError('connect_error'));
    socket.on('reconnect_error', onConnectError('reconnect_error'));
    // Event names a consumer subscribed to before the socket existed.
    for (const event of this.#eventHandlers.keys()) {
      socket.on(event, (payload) => this.#fanOut(event, payload));
    }

    socket.connect?.();

    this.#readyTimer = setTimeout(() => {
      if (this.#state !== 'connecting') return;
      this.#fail(new Error(
        `Roomful user_info timeout after ${this.#readyTimeoutMs}ms (host=${this.#host}, `
        + `networkId=${this.#networkId}, ${this.#connectErrors} transport error(s), last error: `
        + `${this.#lastError ?? 'none — the socket connected but user_info never arrived, '
          + 'which is what a rejected session looks like'})`,
      ));
    }, this.#readyTimeoutMs);
    // Not unref'd: this timer is what rejects an awaited connect(), and a
    // drained event loop would turn that rejection into a hang.
  }

  /**
   * The handshake's end, and the only authority on who this connection is.
   * Also arrives again after every reconnect, which is what makes it the place
   * to announce recovery.
   */
  #onUserInfo(payload) {
    const info = readUserInfo(payload);
    if (info.selfUserId) {
      this.#selfUserId = info.selfUserId;
      this.#userId ??= info.selfUserId;
    }
    if (info.networkId) this.#networkId = info.networkId;
    if (info.user) {
      this.#user = info.user;
      this.#displayName = displayNameOf(info.user) ?? this.#displayName;
    }
    if (info.network) this.#network = info.network;

    if (this.#state === 'connecting') {
      this.#state = 'ready';
      this.#connectedAt = Date.now();
      this.#clearTimer('ready');
      this.#resolveReady?.(this);
      return;
    }
    if (this.#state === 'reconnecting') {
      this.#state = 'ready';
      this.#clearTimer('recovery');
      for (const handler of this.#reconnectedHandlers) {
        try { handler({ selfUserId: this.#selfUserId, networkId: this.#networkId }); } catch (error) {
          console.error('reconnected handler threw:', error);
        }
      }
    }
  }

  #fanOut(event, payload) {
    for (const handler of this.#eventHandlers.get(event) ?? []) {
      try { handler(payload); } catch (error) { console.error(`${event} handler threw:`, error); }
    }
  }

  #fail(error) {
    this.#clearTimer('ready');
    this.#clearTimer('recovery');
    this.#state = 'failed';
    const message = this.#redact(error?.message ?? String(error));
    this.#lastError = message;
    const reject = this.#rejectReady;
    this.#rejectReady = null;
    this.#resolveReady = null;
    // Rejected WITH the redacted message: the rejection is the one value from
    // this object most likely to be logged verbatim by somebody else.
    const failure = message === error?.message ? error : new Error(message, { cause: error });
    // Leave `#ready` rejected rather than null: a caller retrying connect()
    // after a dead session would re-run the same failing handshake.
    reject?.(failure);
  }

  /**
   * An established connection dropped. socket.io is retrying; give it a window,
   * and if it does not come back, say the connection is lost once — so the
   * owner can rebuild it (and re-verify the session) rather than hold a socket
   * that will never answer again.
   */
  #armRecovery(reason) {
    if (this.#recoveryTimer || this.#state === 'closed') return;
    this.#recoveryTimer = setTimeout(() => {
      this.#recoveryTimer = null;
      if (this.#state === 'closed' || this.connected) return;
      this.#state = 'failed';
      this.#lastError = `connection lost: ${reason}`;
      for (const handler of this.#lostHandlers) {
        try { handler(this.#lastError); } catch (error) { console.error('onConnectionLost threw:', error); }
      }
    }, this.#recoveryTimeoutMs);
    // Unref'd, unlike the two above: nobody awaits this watchdog, and a
    // two-minute timer must not be the reason a script refuses to exit.
    this.#recoveryTimer?.unref?.();
  }

  #clearTimer(which) {
    const timer = which === 'ready' ? this.#readyTimer : this.#recoveryTimer;
    if (timer) clearTimeout(timer);
    if (which === 'ready') this.#readyTimer = null; else this.#recoveryTimer = null;
  }

  /**
   * Last line of defence for rule 1 above. Nothing in this file deliberately
   * puts the session id in a message, but the strings here come from a
   * transport that was handed the handshake URL, and one of them quoting it
   * back would put the user's credential in a log — so every message that
   * leaves this object passes through here.
   */
  #redact(text) {
    let value = String(text ?? '');
    if (!this.#sessionId) return value;
    // Both forms: the raw credential, and the percent-encoded one that is what
    // actually appears in the handshake URL a transport error may quote.
    for (const form of new Set([this.#sessionId, encodeURIComponent(this.#sessionId)])) {
      value = value.split(form).join('<redacted>');
    }
    return value;
  }
}
