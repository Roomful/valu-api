// ===========================================================================
// The implementation registry.
//
// A descriptor says WHAT a function is; a registration says how to run it.
// Phase 1 ships the registry empty on purpose — Phase 2a ports the 32
// functions the server already has, 2c writes the other 45, and each one
// registers here. Until then an unregistered function answers 501 naming
// itself, which is a better answer than a plausible-looking failure from the
// remote.
//
// A handler takes `(params, ctx)` and RESOLVES an ack envelope — it does not
// throw and it does not retry (see docs/callbacks-policy.md).
// ===========================================================================
import { ERROR_CODES, errorAck } from '../Errors.js';
import { findDescriptor } from './descriptors.js';

/**
 * @typedef {object} ServiceCallContext
 * @property {import('../socket/ValuSocket.js').ValuSocket} socket
 * @property {import('./descriptors.js').ServiceDescriptor} descriptor
 * @property {number} timeoutMs
 * @property {number} attempt 1 for the first try.
 */

/** @typedef {(params: object, ctx: ServiceCallContext) => Promise<import('../socket/ValuSocket.js').ValuAck>} ServiceHandler */

export class ServiceRegistry {
  #handlers = new Map();

  /**
   * Register the implementation of a declared function.
   * @param {string} name Any name form `findDescriptor` accepts.
   * @param {ServiceHandler} handler
   */
  define(name, handler) {
    const descriptor = findDescriptor(name);
    if (!descriptor) {
      throw new Error(`Cannot implement "${name}": it is not a declared service function`);
    }
    if (descriptor.binding === 'postmessage') {
      throw new Error(
        `Cannot implement "${descriptor.key}": it is postMessage-bound and stays on the postMessage bridge`,
      );
    }
    if (typeof handler !== 'function') {
      throw new TypeError(`Handler for "${descriptor.key}" must be a function`);
    }
    this.#handlers.set(descriptor.key, handler);
    return this;
  }

  /** @returns {ServiceHandler|undefined} */
  get(name) {
    const descriptor = findDescriptor(name);
    return descriptor ? this.#handlers.get(descriptor.key) : undefined;
  }

  has(name) { return this.get(name) !== undefined; }

  /** Keys of every implemented function — the parity counter's input. */
  implemented() { return [...this.#handlers.keys()].sort(); }

  /** Drop a registration. Used by tests; there is no runtime need to unregister. */
  delete(name) {
    const descriptor = findDescriptor(name);
    return descriptor ? this.#handlers.delete(descriptor.key) : false;
  }
}

/** The registry the SDK uses unless a client is given its own. */
export const serviceRegistry = new ServiceRegistry();

/** The ack an unimplemented function answers with. */
export const notImplementedAck = (descriptor) => errorAck(
  ERROR_CODES.UNSUPPORTED,
  `${descriptor.key} has no implementation registered`,
  `${descriptor.key} is declared (binding: ${descriptor.binding}) but not yet implemented — see the Phase 2 parity list.`,
);
