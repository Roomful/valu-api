// ===========================================================================
// The postMessage bridge, exactly as it is today.
//
// The other end is the Valu Social application that embedded this app in an
// iframe. This file is the ONLY place that knows that — everything above it
// talks to a `Transport`.
//
// Lifted out of ValuApi without changing a single wire message: the same
// `{name, message}` envelope posted to the same `event.source`/`event.origin`,
// the same `target: 'valuApi'` filter inbound, the same requestId correlation.
// If this file and the old ValuApi disagree on the wire, this file is wrong.
//
// One behavioural difference, deliberate: posting before `api:ready` used to
// fail with a TypeError on `undefined.postMessage`. It now rejects with a
// message that says what happened.
//
// Who may speak. `api:ready` used to be taken from any window, and every one
// after it re-pointed all later traffic at its sender — so any frame or opener
// that could post to this page could take the bridge over. The peer is now
// bound ONCE, on the first `api:ready` that is acceptable, and everything after
// it (replies, triggers, a further `api:ready`) is taken only from that same
// source and origin. Acceptable means:
//   - embedded (the `target` window has a `parent` that is not itself): the
//     sender is that parent. The embedding Valu Social application is the
//     parent; nothing else is the peer.
//   - not embedded (Node, a worker, a top-level page — there is no parent to
//     name): the first `api:ready` from any source, as before. Without a
//     parent there is nothing to tell a host from an impostor, so the origin
//     allow-list below is the only guard there.
//   - and, when `hostOrigins` is given, its origin is one of those. There is no
//     default list: the SDK cannot know where an application is hosted.
// Nothing about what is POSTED changed: same envelope, same `target`.
// ===========================================================================
import { Transport } from './Transport.js';
import { nextId } from '../Utils.js';


/** Replies that carry a `requestId` and settle a pending request. */
const REPLY_MESSAGES = new Set([
  'api:run-completed',
  'api:run-console-completed',
  'api:pointer-created',
]);

export class PostMessageTransport extends Transport {
  #peer = {};
  #pending = new Map();
  #listener;
  #target;
  #hostOrigins;

  /**
   * @param {{target?: EventTarget, hostOrigins?: string[]}} [options]
   * @param {EventTarget} [options.target] The window that receives the
   *   application's messages. Defaults to `globalThis`; the conformance suite passes a fake.
   * @param {string[]} [options.hostOrigins] Origins the first `api:ready` may
   *   come from. Omitted: any origin (the sender is still bound to
   *   `window.parent` when embedded). An empty array admits none.
   */
  constructor({ target = globalThis, hostOrigins } = {}) {
    super();
    if (hostOrigins !== undefined && !Array.isArray(hostOrigins)) {
      throw new TypeError('PostMessageTransport hostOrigins must be an array of origins');
    }
    this.#hostOrigins = hostOrigins ? [...hostOrigins] : null;
    this.#target = target;
    this.#listener = (event) => this.#onMessage(event);
    this.#target.addEventListener('message', this.#listener);
  }

  /** True once `api:ready` has arrived — same test as ValuApi's old `connected`. */
  get connected() { return this.#peer.origin !== undefined; }

  /**
   * The bridge does not serve service functions.
   *
   * It could: the Valu Social application answers `api:service-intent` for
   * everything it declares, and this transport used to forward service calls
   * that way. That is exactly the ambiguity this package dropped — a service
   * function is one a CONNECTION answers, so it behaves the same in an iframe,
   * in a Valu Social build and on the Valu Guru server, and there is one
   * answer to "where does this run". An iframe application that wants the
   * application to do something asks it by name instead
   * (`ValuApi.callService`), and nothing has to be declared for that.
   */
  get servesServiceFunctions() { return false; }

  /** Id the Valu Social application gave this app on `api:ready`. */
  get applicationId() { return this.#peer.id; }

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

  async close() {
    this.#target.removeEventListener('message', this.#listener);
    for (const pending of this.#pending.values()) {
      pending.reject(new Error('transport closed'));
    }
    this.#pending.clear();
    this.#peer = {};
  }

  #post(name, message) {
    if (!this.#peer.source) {
      throw new Error(`Cannot post "${name}": the Valu Social application has not sent api:ready yet`);
    }
    this.#peer.source.postMessage({ name, message }, this.#peer.origin);
  }

  #defer(requestId) {
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
    });
  }

  /** The one window and origin the first acceptable `api:ready` bound. */
  #fromPeer(event) {
    return this.connected && event.source === this.#peer.source && event.origin === this.#peer.origin;
  }

  /** Whether this `api:ready` may bind the peer, or repeat the bound one's. */
  #acceptsReady(event) {
    if (this.connected) return this.#fromPeer(event);
    const parent = this.#target.parent;
    if (parent && parent !== this.#target && event.source !== parent) return false;
    return !this.#hostOrigins || this.#hostOrigins.includes(event.origin);
  }

  #onMessage(event) {
    if (event.data?.target !== 'valuApi') return;

    const { name, message, requestId } = event.data;

    if (name === 'api:ready') {
      if (!this.#acceptsReady(event)) return;
      this.#peer = { id: message.applicationId, source: event.source, origin: event.origin };
      this.events.emit(Transport.READY, message);
      return;
    }

    // Before the handshake there is no peer to check against, and after it
    // only the peer speaks.
    if (!this.#fromPeer(event)) return;

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
