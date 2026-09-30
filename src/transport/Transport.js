// ===========================================================================
// The transport contract.
//
// `ValuApi` used to BE its transport: it bound `globalThis.addEventListener
// ('message')` in its constructor and called `postMessage` directly. Those two
// facts are now behind this interface, so the same API object can speak over
// the postMessage bridge or to a socket without either one leaking into the
// other.
//
// Two implementations ship: PostMessageTransport (today's bridge, unchanged on
// the wire) and SocketTransport (new).
// ===========================================================================
import { EventEmitter } from '../EventEmitter.js';
import { ERROR_CODES, errorAck } from '../Errors.js';

export class Transport {
  /** @protected */
  events = new EventEmitter();

  /** Events a transport may emit; ValuApi and ServiceClient listen for these. */
  static READY = 'ready';
  static TRIGGER = 'trigger';
  static NEW_INTENT = 'new-intent';
  static RECONNECTED = 'reconnected';
  static RESOURCE_UPDATED = 'resource:updated';

  /** @returns {boolean} */
  get connected() { return false; }

  /**
   * Whether this transport speaks the postMessage bridge at all — i.e. whether
   * there is a Valu Social application on the other end of it.
   *
   * `request`/`notify` exist on every transport — they throw where they are
   * not supported — so "has a request method" does not answer the question.
   * FrameCommands asks this one instead: there is no frame behind a socket,
   * and finding that out per call would be fifteen identical surprises.
   */
  get supportsPostMessage() { return false; }

  /** Human name, for error messages that have to say which transport refused. */
  get name() { return this.constructor.name; }

  addEventListener = (...args) => this.events.addEventListener(...args);
  removeEventListener = (...args) => this.events.removeEventListener(...args);

  /** Resolves once the transport can carry traffic. */
  async open() {}

  /**
   * Request/response over the postMessage bridge.
   * @param {string} _name Bridge message name, e.g. `api:run`.
   * @param {object} _message
   * @param {number} [_requestId] Supplied when the caller owns the id.
   * @returns {Promise<any>} The reply message, verbatim.
   */
  async request(_name, _message, _requestId) {
    throw new Error(`${this.name} does not support postMessage requests`);
  }

  /** Fire-and-forget bridge message. */
  notify(_name, _message) {
    throw new Error(`${this.name} does not support postMessage messages`);
  }

  /**
   * Run one declared service function. ONE attempt: retry is the client's job
   * (src/CallPolicy.js), so both transports retry identically.
   * @param {import('../services/descriptors.js').ServiceDescriptor} descriptor
   * @param {object} _params
   * @param {{timeoutMs?: number}} [_options]
   * @returns {Promise<import('../socket/ValuSocket.js').ValuAck>}
   */
  async callService(descriptor, _params, _options) {
    return errorAck(
      ERROR_CODES.UNSUPPORTED,
      `${this.name} cannot serve ${descriptor.key} (binding: ${descriptor.binding})`,
    );
  }

  /**
   * @param {string} event
   * @param {(data: any) => void} handler
   * @returns {() => void} unsubscribe
   */
  subscribe(event, handler) {
    this.events.addEventListener(event, handler);
    return () => this.events.removeEventListener(event, handler);
  }

  async close() {}
}
