// ===========================================================================
// Node adapter: RoomfulConnectionManager, as a ValuSocket.
//
// The headless connection already satisfies the contract — it wraps payloads
// in `{data}`, resolves an error ack on timeout, and exposes
// `onResourceUpdated`. This adapter is thin on purpose: it normalizes a
// missing ack to `{}`, forwards the optional push hook only when the
// connection actually has one, and republishes the raw connection as
// `underlying` so wrappers (the server's recordingSocket) and this adapter
// key the same per-connection state.
// ===========================================================================
import { ERROR_CODES, errorAck } from '../Errors.js';
import { DEFAULT_TIMEOUT_MS } from '../CallPolicy.js';
import { normalizeAck } from './ValuSocket.js';

/** @implements {import('./ValuSocket.js').ValuSocket} */
export class NodeSocketAdapter {
  #connection;
  #networkId;

  /**
   * @param {object} options
   * @param {{emit: Function, userId?: string, selfUserId?: string|null, onResourceUpdated?: Function}} options.connection
   *   A RoomfulConnectionManager, or anything with the same emit contract.
   * @param {string} [options.networkId]
   */
  constructor({ connection, networkId } = {}) {
    if (!connection || typeof connection.emit !== 'function') {
      throw new TypeError('NodeSocketAdapter needs a connection with emit()');
    }
    this.#connection = connection;
    this.#networkId = networkId ?? connection.networkId ?? 'roomful';

    if (typeof connection.onResourceUpdated === 'function') {
      this.onResourceUpdated = (handler) => connection.onResourceUpdated(handler);
    }
  }

  get userId() { return this.#connection.userId; }
  get networkId() { return this.#networkId; }
  get selfUserId() { return this.#connection.selfUserId ?? null; }

  /** The raw connection — key per-connection state on `underlying ?? socket`. */
  get underlying() { return this.#connection.underlying ?? this.#connection; }

  /**
   * @param {string} ns
   * @param {object} [data]
   * @param {number} [timeoutMs]
   * @returns {Promise<import('./ValuSocket.js').ValuAck>}
   */
  async emit(ns, data = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    try {
      return normalizeAck(await this.#connection.emit(ns, data, timeoutMs));
    } catch (error) {
      // The pooled connection resolves rather than rejects, but a wrapper or a
      // half-torn-down connection can still throw. One shape out of here.
      return errorAck(ERROR_CODES.DISCONNECTED, `emit ${ns} failed: ${error?.message ?? error}`);
    }
  }
}
