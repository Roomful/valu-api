// ===========================================================================
// The service client — one call path, whichever transport serves it.
//
//   descriptor lookup → param validation → scope check → cache →
//   transport (retried under the policy) → cache write / invalidation
//
// Every step answers in the ack envelope, so a caller handling failure writes
// one branch, not five. `invoke()` is the same path with the envelope
// unwrapped for callers that would rather throw.
// ===========================================================================
import { findDescriptor, catalogSummary, listServices, listDescriptors } from './descriptors.js';
import { validationAck } from './validate.js';
import { ServiceCache } from '../cache/ServiceCache.js';
import { forDescriptor, runWithPolicy } from '../CallPolicy.js';
import { ERROR_CODES, errorAck } from '../Errors.js';
import { unwrapAck } from '../socket/ValuSocket.js';
import { Transport } from '../transport/Transport.js';

export class ServiceClient {
  #transport;
  #cache;
  #auth;
  #hooks;
  #subscribers = new Map();
  #transportSubscriptions = [];

  /**
   * @param {object} options
   * @param {import('../transport/Transport.js').Transport} options.transport
   * @param {ServiceCache|null} [options.cache] Pass null to disable caching.
   * @param {import('../auth/AuthProvider.js').AuthProvider} [options.auth]
   * @param {{sleep?: Function, random?: Function}} [options.hooks] Retry timing,
   *   injected by the conformance suite.
   */
  constructor({ transport, cache, auth, hooks = {} } = {}) {
    if (!transport) throw new TypeError('ServiceClient needs a transport');
    this.#transport = transport;
    this.#cache = cache === null ? null : (cache ?? new ServiceCache());
    this.#auth = auth;
    this.#hooks = hooks;
    this.#wireTransportEvents();
  }

  get transport() { return this.#transport; }
  get cache() { return this.#cache; }

  /** The parity numbers, counted from the catalogue. */
  static summary = catalogSummary;
  /** @type {typeof listServices} */
  static services = listServices;
  /** @type {typeof listDescriptors} */
  static functions = listDescriptors;

  /**
   * Call a declared function. Resolves the ack envelope — never rejects.
   *
   * @param {string} name `Users.search-users`, `Users.searchUsers`,
   *   `Users.search_users` or `service__Users__search_users`.
   * @param {object} [params]
   * @param {{timeoutMs?: number, retries?: number, bypassCache?: boolean}} [options]
   * @returns {Promise<import('../socket/ValuSocket.js').ValuAck>}
   */
  async call(name, params = {}, options = {}) {
    const descriptor = findDescriptor(name);
    if (!descriptor) {
      return errorAck(ERROR_CODES.UNKNOWN_FUNCTION, `unknown service function: ${name}`);
    }

    const invalid = validationAck(descriptor, params);
    if (invalid) return invalid;

    const forbidden = this.#auth?.scopeAck(descriptor.scopes);
    if (forbidden) return forbidden;

    const cached = this.#readCache(descriptor, params, options);
    if (cached) return cached;

    const policy = forDescriptor(descriptor, {
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(typeof options.retries === 'number' ? { retries: options.retries } : {}),
    });

    const ack = await runWithPolicy(
      (attempt) => this.#transport.callService(descriptor, params, {
        timeoutMs: policy.timeoutMs,
        attempt,
      }),
      policy,
      this.#hooks,
    );

    this.#writeCache(descriptor, params, ack);
    return ack;
  }

  /**
   * `call()` with the envelope unwrapped: returns `ack.data`, throws
   * `ValuServiceError` for anything else.
   */
  async invoke(name, params, options) {
    const descriptor = findDescriptor(name);
    const ack = await this.call(name, params, options);
    return unwrapAck(ack, { service: descriptor?.service, fn: descriptor?.fn, fallback: `${name} failed` });
  }

  /**
   * Subscribe to a platform event. Registration lives on the client, not the
   * socket, so it survives a reconnect.
   * @param {string} event `resource:updated` or `reconnected`.
   * @param {(data: any) => void} handler
   * @returns {() => void} unsubscribe
   */
  subscribe(event, handler) {
    if (typeof handler !== 'function') throw new TypeError('subscribe needs a handler');
    if (!this.#subscribers.has(event)) this.#subscribers.set(event, new Set());
    this.#subscribers.get(event).add(handler);
    return () => { this.#subscribers.get(event)?.delete(handler); };
  }

  /** Seed a cache entry from state the caller already holds. */
  seed(name, params, data, options) {
    const descriptor = findDescriptor(name);
    if (!descriptor) throw new Error(`unknown service function: ${name}`);
    this.#cache?.seed(descriptor, params ?? {}, data, options);
    return this;
  }

  async close() {
    for (const off of this.#transportSubscriptions) off();
    this.#transportSubscriptions = [];
    this.#subscribers.clear();
    this.#cache?.clear();
  }

  #readCache(descriptor, params, options) {
    if (!this.#cache || options.bypassCache || descriptor.mutates) return undefined;
    if (descriptor.cache?.mode === 'none') return undefined;
    return this.#cache.get(descriptor, params);
  }

  #writeCache(descriptor, params, ack) {
    if (!this.#cache) return;
    if (descriptor.mutates) {
      // A write is the one event the SDK can see without a push: the service
      // it wrote to can no longer be trusted from cache. This runs even when
      // the write FAILED — a timeout is a lost answer, not a lost request, and
      // serving the pre-write value for the rest of its TTL is the one outcome
      // worse than admitting we do not know.
      this.#cache.invalidateService(descriptor.service);
      return;
    }
    if (ack?.error) return;
    if (descriptor.cache?.mode !== 'none') this.#cache.set(descriptor, params, ack);
  }

  #wireTransportEvents() {
    const onResource = (data) => {
      this.#cache?.onResourceUpdated(data);
      this.#emit(Transport.RESOURCE_UPDATED, data);
    };
    const onReconnected = (data) => {
      // Anything cached predates the gap, and nothing says what changed during
      // it. Drop it all and say so.
      this.#cache?.clear();
      this.#emit(Transport.RECONNECTED, data);
    };
    this.#transportSubscriptions.push(
      this.#transport.subscribe(Transport.RESOURCE_UPDATED, onResource),
      this.#transport.subscribe(Transport.RECONNECTED, onReconnected),
    );
  }

  #emit(event, data) {
    for (const handler of this.#subscribers.get(event) ?? []) {
      // One subscriber's bad day is not the others', and never the caller's.
      try { handler(data); } catch (error) { console.error(`subscriber for "${event}" threw:`, error); }
    }
  }
}
