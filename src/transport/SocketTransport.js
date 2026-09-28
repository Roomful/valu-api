// ===========================================================================
// The socket transport.
//
// Serves declared functions over a `ValuSocket` — the browser adapter or the
// node adapter, the same contract either way. It does NOT speak the host
// bridge: `api:run-command` and the 15 host-bound intents are frame
// operations, and asking a socket for one answers 501 rather than pretending.
//
// One attempt per call. Timeout, retry and backoff belong to the client's
// policy so both transports behave identically (docs/callbacks-policy.md).
// ===========================================================================
import { Transport } from './Transport.js';
import { ERROR_CODES, errorAck } from '../Errors.js';
import { DEFAULT_TIMEOUT_MS } from '../CallPolicy.js';
import { serviceRegistry, notImplementedAck } from '../services/registry.js';

export class SocketTransport extends Transport {
  #socket;
  #registry;
  #unsubscribePush = null;

  /**
   * @param {object} options
   * @param {import('../socket/ValuSocket.js').ValuSocket} options.socket
   * @param {import('../services/registry.js').ServiceRegistry} [options.registry]
   */
  constructor({ socket, registry = serviceRegistry } = {}) {
    super();
    if (!socket || typeof socket.emit !== 'function') {
      throw new TypeError('SocketTransport needs a ValuSocket');
    }
    this.#socket = socket;
    this.#registry = registry;
    this.#attachPush();
  }

  get connected() { return Boolean(this.#socket); }
  get socket() { return this.#socket; }
  /** True when the socket can push `resource:updated`; false means poll. */
  get supportsPush() { return typeof this.#socket?.onResourceUpdated === 'function'; }

  async callService(descriptor, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, attempt = 1 } = {}) {
    if (descriptor.binding === 'host') {
      return errorAck(
        ERROR_CODES.UNSUPPORTED,
        `${descriptor.key} is host-bound — call it through the frame bridge, not the socket`,
      );
    }
    if (!this.#socket) {
      return errorAck(ERROR_CODES.DISCONNECTED, `${descriptor.key}: no socket`);
    }

    const handler = this.#registry.get(descriptor.key);
    if (!handler) return notImplementedAck(descriptor);

    try {
      const ack = await handler(params, {
        socket: this.#socket,
        descriptor,
        timeoutMs,
        attempt,
      });
      return ack ?? {};
    } catch (error) {
      // A handler is contracted to resolve an envelope. One that throws anyway
      // must not take the caller down with it.
      return errorAck(
        ERROR_CODES.DISCONNECTED,
        `${descriptor.key} threw: ${error?.message ?? error}`,
      );
    }
  }

  /**
   * Swap in a re-opened socket. Push is re-attached and `reconnected` is
   * emitted so the client can drop the caches it can no longer trust.
   * @param {import('../socket/ValuSocket.js').ValuSocket} [socket]
   */
  handleReconnect(socket = this.#socket) {
    this.#detachPush();
    this.#socket = socket;
    this.#attachPush();
    this.events.emit(Transport.RECONNECTED, { supportsPush: this.supportsPush });
  }

  async close() {
    this.#detachPush();
    this.#socket = null;
  }

  #attachPush() {
    if (!this.supportsPush) return;
    this.#unsubscribePush = this.#socket.onResourceUpdated((data) => {
      this.events.emit(Transport.RESOURCE_UPDATED, data);
    });
  }

  #detachPush() {
    try { this.#unsubscribePush?.(); } catch { /* a dead socket is still detached */ }
    this.#unsubscribePush = null;
  }
}
