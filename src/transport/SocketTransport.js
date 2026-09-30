// ===========================================================================
// The socket transport.
//
// Serves declared functions over a `ValuSocket` — the browser adapter or the
// node adapter, the same contract either way. This is the ONLY transport that
// serves service functions, which is the shape of the package: every function
// in the catalogue is one a connection can answer, so a Valu Social build, a
// Valu Guru server agent, a Node script and an iframe application with a
// socket all reach the same list.
//
// It does not speak the postMessage bridge at all. Nothing here needs to: an
// intent only the Valu Social application can serve is not in the catalogue,
// and an iframe application asks for one by name (src/ValuApi.js callService).
//
// One attempt per call. Timeout, retry and backoff belong to the client's
// policy so both transports behave identically (docs/callbacks-policy.md).
// ===========================================================================
import { Transport } from './Transport.js';
import { ERROR_CODES, errorAck } from '../Errors.js';
import { DEFAULT_TIMEOUT_MS } from '../CallPolicy.js';
import { serviceRegistry, notImplementedAck } from '../services/registry.js';
import { isGuruSocket, noGuruAck } from '../socket/ValuGuruSocket.js';
import { resolveConfig } from '../Config.js';

export class SocketTransport extends Transport {
  #socket;
  #guru;
  #appState;
  #fetchImpl;
  #config;
  #now;
  #applicationId;
  #registry;
  #unsubscribePush = null;

  /**
   * @param {object} options
   * @param {import('../socket/ValuSocket.js').ValuSocket} options.socket
   *   The Roomful socket. Required — it is what 54 of the 65 socket functions
   *   use, and what the upload pipeline runs on.
   * @param {import('../socket/ValuGuruSocket.js').ValuGuruSocket} [options.guru]
   *   The Valu Guru socket, for the 11 functions whose channel is `valuguru`.
   *   Absent means those functions answer 503 saying so — never a wrong socket.
   * @param {import('../app-state/AppState.js').AppState} [options.appState]
   *   State no RPC can produce, for the 5 functions whose channel is
   *   `app-state`. The Valu Social application holds it in a browser; a
   *   headless runtime supplies its own.
   * @param {Function} [options.fetchImpl] `fetch`, for the local HTTP
   *   functions and the upload pipeline's bucket PUT. Injected by the
   *   conformance suite so no test opens a connection.
   * @param {Partial<import('../Config.js').ValuConfig>} [options.config]
   *   The two origins the `local` resource-URL builders need (src/Config.js).
   * @param {() => Date} [options.now] The clock, for `Time.get-local-time`.
   * @param {string} [options.applicationId] WHICH application is calling. In
   *   a frame the Valu Social app stamps this — Commerce scopes every catalogue read and write to it,
   *   and it is never taken from a caller's params (a framed app controls
   *   those, and must not be able to sell as another app).
   * @param {import('../services/registry.js').ServiceRegistry} [options.registry]
   */
  constructor({ socket, guru, appState, fetchImpl, config, now, applicationId, registry = serviceRegistry } = {}) {
    super();
    if (!socket || typeof socket.emit !== 'function') {
      throw new TypeError('SocketTransport needs a ValuSocket');
    }
    this.#socket = socket;
    this.#guru = guru ?? null;
    this.#appState = appState ?? null;
    this.#fetchImpl = fetchImpl ?? null;
    this.#config = resolveConfig(config);
    this.#now = now ?? null;
    this.#applicationId = applicationId ?? null;
    this.#registry = registry;
    this.#attachPush();
  }

  get connected() { return Boolean(this.#socket); }
  get servesServiceFunctions() { return true; }
  get socket() { return this.#socket; }
  get guru() { return this.#guru; }
  get appState() { return this.#appState; }
  get config() { return this.#config; }
  get applicationId() { return this.#applicationId; }
  /** Channels this transport can actually serve — what a 503 here means. */
  get channels() {
    return {
      roomful: Boolean(this.#socket),
      valuguru: isGuruSocket(this.#guru),
      'app-state': Boolean(this.#appState),
      local: true,
    };
  }
  /** True when the socket can push `resource:updated`; false means poll. */
  get supportsPush() { return typeof this.#socket?.onResourceUpdated === 'function'; }

  async callService(descriptor, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, attempt = 1 } = {}) {
    if (!this.#socket) {
      return errorAck(ERROR_CODES.DISCONNECTED, `${descriptor.key}: no socket`);
    }
    // A function is refused for the channel it needs BEFORE its handler runs,
    // so "the Valu Guru socket is missing" never arrives dressed as a Roomful
    // failure. `app-state` is left to the handler: it names the one
    // capability it wanted, which is more useful than "no application state".
    if (descriptor.channel === 'valuguru' && !isGuruSocket(this.#guru)) {
      return noGuruAck(descriptor);
    }

    const handler = this.#registry.get(descriptor.key);
    if (!handler) return notImplementedAck(descriptor);

    try {
      const ack = await handler(params, {
        socket: this.#socket,
        guru: this.#guru,
        appState: this.#appState,
        fetchImpl: this.#fetchImpl,
        config: this.#config,
        applicationId: this.#applicationId,
        ...(this.#now ? { now: this.#now } : {}),
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
