// ===========================================================================
// The host bridge, exactly as it is today.
//
// Lifted out of ValuApi without changing a single wire message: the same
// `{name, message}` envelope posted to the same `event.source`/`event.origin`,
// the same `target: 'valuApi'` filter inbound, the same requestId correlation.
// If this file and the old ValuApi disagree on the wire, this file is wrong.
//
// One behavioural difference, deliberate: posting before `api:ready` used to
// fail with a TypeError on `undefined.postMessage`. It now rejects with a
// message that says what happened.
// ===========================================================================
import { Transport } from './Transport.js';
import { nextId } from '../Utils.js';
import { ERROR_CODES, errorAck } from '../Errors.js';
import { dataAck } from '../socket/ValuSocket.js';

/** Replies that carry a `requestId` and settle a pending request. */
const REPLY_MESSAGES = new Set([
  'api:run-completed',
  'api:run-console-completed',
  'api:pointer-created',
]);

export class PostMessageTransport extends Transport {
  #host = {};
  #pending = new Map();
  #listener;
  #target;

  /**
   * @param {{target?: EventTarget}} [options] The window that receives host
   *   messages. Defaults to `globalThis`; the conformance suite passes a fake.
   */
  constructor({ target = globalThis } = {}) {
    super();
    this.#target = target;
    this.#listener = (event) => this.#onMessage(event);
    this.#target.addEventListener('message', this.#listener);
  }

  /** True once `api:ready` has arrived — same test as ValuApi's old `connected`. */
  get connected() { return this.#host.origin !== undefined; }

  /** Id the host gave this application on `api:ready`. */
  get applicationId() { return this.#host.id; }

  /** @param {string} name @param {object} message @param {number} [requestId] */
  async request(name, message, requestId = nextId()) {
    const deferred = this.#defer(requestId);
    try {
      this.#post(name, { ...message, requestId });
    } catch (error) {
      this.#pending.delete(requestId);
      throw error;
    }
    return deferred;
  }

  notify(name, message) {
    this.#post(name, message);
  }

  /**
   * A service intent over the bridge — what `ValuApi.callService` has always
   * sent. The host answers with the raw result, so it is wrapped into the ack
   * envelope here: every caller of `callService` sees one shape whichever
   * transport served it.
   */
  async callService(descriptor, params = {}) {
    if (!this.connected) {
      return errorAck(ERROR_CODES.DISCONNECTED, 'not connected to the Valu host');
    }
    let result;
    try {
      result = await this.request('api:service-intent', {
        applicationId: descriptor.service,
        action: descriptor.action,
        params,
      });
    } catch (error) {
      return errorAck(ERROR_CODES.DISCONNECTED, error?.message ?? String(error));
    }
    if (result && typeof result === 'object' && result.error) {
      const { error } = result;
      return typeof error === 'string'
        ? errorAck(undefined, error)
        : { error: { status: true, ...error } };
    }
    return dataAck(result);
  }

  async close() {
    this.#target.removeEventListener('message', this.#listener);
    for (const pending of this.#pending.values()) {
      pending.reject(new Error('transport closed'));
    }
    this.#pending.clear();
    this.#host = {};
  }

  #post(name, message) {
    if (!this.#host.source) {
      throw new Error(`Cannot post "${name}": the Valu host has not sent api:ready yet`);
    }
    this.#host.source.postMessage({ name, message }, this.#host.origin);
  }

  #defer(requestId) {
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
    });
  }

  #onMessage(event) {
    if (event.data?.target !== 'valuApi') return;

    const { name, message, requestId } = event.data;

    if (REPLY_MESSAGES.has(name)) {
      const pending = this.#pending.get(requestId);
      if (!pending) {
        console.error(`Failed to locate request with Id: ${requestId} (${name})`);
        return;
      }
      this.#pending.delete(requestId);
      pending.resolve(message);
      return;
    }

    switch (name) {
      case 'api:ready':
        this.#host = { id: message.applicationId, source: event.source, origin: event.origin };
        this.events.emit(Transport.READY, message);
        break;
      case 'api:trigger':
        this.events.emit(Transport.TRIGGER, message);
        break;
      case 'api:new-intent':
        this.events.emit(Transport.NEW_INTENT, message);
        break;
      default:
        break;
    }
  }
}
