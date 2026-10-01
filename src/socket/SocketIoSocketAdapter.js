// ===========================================================================
// A socket.io socket somebody else opened, as a ValuSocket.
//
// This is the second door of the two this package offers (docs/connecting.md):
// the caller already has an AUTHORIZED Roomful socket and hands the instance
// over. `BrowserSocketAdapter` covers the case where what the caller has is the
// Valu Social application's WebSocket *service*, with its own `emitAsync`;
// this one covers the case where what they have is the socket.io socket itself.
//
// It is the adapter a framed application will use the day it may open a socket
// of its own, and the one a mobile shell or a test harness wants today. It owns
// no connection: it does not connect, authenticate, reconnect or close. The
// runtime that opened the socket keeps all of that.
// ===========================================================================
import { DEFAULT_TIMEOUT_MS } from '../CallPolicy.js';
import { VALU_SOCKET } from './ValuSocket.js';
import { emitOverSocketIo, isSocketIoSocket } from './socketio.js';
import { readUserInfo } from './user-info.js';

/** @implements {import('./ValuSocket.js').ValuSocket} */
export class SocketIoSocketAdapter {
  /** @see VALU_SOCKET */
  [VALU_SOCKET] = true;

  #socket;
  #userId;
  #networkId;
  #selfUserId;
  #timeoutMs;

  /**
   * @param {object} options
   * @param {{emit: Function, on: Function, off?: Function, removeListener?: Function, connected?: boolean}} options.socket
   *   A connected, authorized socket.io socket to the Roomful platform.
   * @param {string} [options.userId] Who the socket is credentialed as. Optional
   *   because the platform says so itself on the `user_info` push, which this
   *   adapter listens for; pass it when you know it, so the first call made
   *   before that push still has an identity.
   * @param {string} [options.networkId] Defaults to `'roomful'`, then to
   *   whatever `user_info` names.
   * @param {string|null} [options.selfUserId]
   * @param {number} [options.timeoutMs] Default per-call ack timeout.
   */
  constructor({ socket, userId, networkId = 'roomful', selfUserId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!isSocketIoSocket(socket)) {
      throw new TypeError(
        'SocketIoSocketAdapter needs a socket.io socket (one with emit() and on()). '
        + "For the Valu Social application's WebSocket service, use BrowserSocketAdapter.",
      );
    }
    this.#socket = socket;
    this.#userId = userId ?? null;
    this.#networkId = networkId;
    this.#selfUserId = selfUserId ?? userId ?? null;
    this.#timeoutMs = timeoutMs;

    // The platform re-announces who you are on every (re)connect. Treat it as
    // authoritative over what the caller guessed: a socket that reconnected
    // into a different network must not keep answering with the old id.
    socket.on('user_info', (payload) => {
      const { selfUserId: id, networkId: network } = readUserInfo(payload);
      if (id) {
        this.#selfUserId = id;
        this.#userId ??= id;
      }
      if (network) this.#networkId = network;
    });
  }

  get userId() { return this.#userId ?? this.#selfUserId; }
  get networkId() { return this.#networkId; }
  get selfUserId() { return this.#selfUserId; }

  /** The socket.io socket, for consumers that key per-connection state. */
  get transport() { return this.#socket; }

  /**
   * @param {string} ns
   * @param {object} [data] The RPC's own payload — the `{data}` envelope is
   *   added by `emitOverSocketIo`.
   * @param {number} [timeoutMs]
   * @returns {Promise<import('./ValuSocket.js').ValuAck>}
   */
  emit(ns, data = {}, timeoutMs = this.#timeoutMs) {
    return emitOverSocketIo(this.#socket, ns, data, timeoutMs);
  }

  /**
   * `resource:updated`, straight off the socket.
   *
   * Present unconditionally here, unlike on `BrowserSocketAdapter`: a socket.io
   * socket can always subscribe, so there is no case where the hook would be a
   * subscription to nothing.
   * @param {(data: any) => void} handler
   * @returns {() => void} unsubscribe
   */
  onResourceUpdated(handler) {
    this.#socket.on('resource:updated', handler);
    return () => {
      const off = this.#socket.off ?? this.#socket.removeListener;
      off?.call(this.#socket, 'resource:updated', handler);
    };
  }
}
