// ===========================================================================
// Browser adapter: the app's WebSocket service, as a ValuSocket.
//
// The app's service exposes `emitAsync(endpoint, data, timeout)`, which wraps
// the payload in the Roomful `{data}` envelope itself and REJECTS on timeout
// or while the socket is down. `ValuSocket.emit` never rejects — it resolves
// an error ack — so the rejection is converted here. That difference is the
// whole reason this adapter exists.
// ===========================================================================
import { ERROR_CODES, errorAck } from '../Errors.js';
import { DEFAULT_TIMEOUT_MS } from '../CallPolicy.js';
import { normalizeAck } from './ValuSocket.js';

/** @implements {import('./ValuSocket.js').ValuSocket} */
export class BrowserSocketAdapter {
  #socket;
  #userId;
  #networkId;
  #selfUserId;
  #resourceUpdated;

  /**
   * @param {object} options
   * @param {{emitAsync: Function, addEventListener?: Function, removeEventListener?: Function}} options.socket
   *   The app's WebSocket service.
   * @param {string} options.userId
   * @param {string} [options.networkId]
   * @param {string|null} [options.selfUserId]
   * @param {(handler: (data: any) => void) => (() => void)} [options.onResourceUpdated]
   *   Supply when the caller can push `resource:updated`; omit to leave the
   *   optional hook off the adapter entirely, so consumers fall back to
   *   polling rather than silently subscribing to nothing.
   */
  constructor({ socket, userId, networkId = 'roomful', selfUserId = null, onResourceUpdated } = {}) {
    if (!socket || typeof socket.emitAsync !== 'function') {
      throw new TypeError('BrowserSocketAdapter needs a socket with emitAsync()');
    }
    this.#socket = socket;
    this.#userId = userId;
    this.#networkId = networkId;
    this.#selfUserId = selfUserId ?? userId ?? null;
    this.#resourceUpdated = onResourceUpdated;

    if (onResourceUpdated) {
      this.onResourceUpdated = (handler) => this.#resourceUpdated(handler);
    }
  }

  get userId() { return this.#userId; }
  get networkId() { return this.#networkId; }
  get selfUserId() { return this.#selfUserId; }

  /** The app's WebSocket service, for consumers that key per-connection state. */
  get transport() { return this.#socket; }

  /**
   * @param {string} ns
   * @param {object} [data]
   * @param {number} [timeoutMs]
   * @returns {Promise<import('./ValuSocket.js').ValuAck>}
   */
  async emit(ns, data = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    try {
      const response = await this.#socket.emitAsync(ns, data, timeoutMs);
      return normalizeAck(response);
    } catch (error) {
      const message = error?.message ?? String(error);
      const timedOut = /timed? ?out/i.test(message);
      return errorAck(
        timedOut ? ERROR_CODES.TIMEOUT : ERROR_CODES.DISCONNECTED,
        timedOut ? `emit ${ns} timed out` : `emit ${ns} failed: ${message}`,
      );
    }
  }
}
