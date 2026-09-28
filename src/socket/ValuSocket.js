// ===========================================================================
// The socket contract.
//
// `ValuSocket` is the minimal surface every Valu function that goes to the
// network depends on. It started life in valu-guru-server
// (src/valu-tools/types.ts) and is canonical HERE: the server imports it from
// this package, and the browser and node adapters below are the only two
// implementations the SDK ships.
//
// Deliberately minimal — an emit, an optional push hook, three identity
// fields. Anything richer would tie the tools to a transport.
// ===========================================================================
import { ERROR_CODES, ValuServiceError, errorAck } from '../Errors.js';

/**
 * @typedef {object} ValuAckError
 * @property {boolean} [status] True when the call failed.
 * @property {number} [code]
 * @property {string} [message]
 * @property {string} [description]
 */

/**
 * Ack envelope returned by every Valu/Roomful socket RPC: `{data} | {error}`.
 * @typedef {{data?: any, error?: ValuAckError}} ValuAck
 */

/**
 * @typedef {object} ValuSocket
 * @property {string} userId Roomful user id of the credentialed account.
 * @property {string} networkId Active network id (defaults to "roomful").
 * @property {string|null} selfUserId Resolved self user id; null until ready.
 * @property {(ns: string, data?: object, timeoutMs?: number) => Promise<ValuAck>} emit
 *   Emit an RPC and resolve its ack. `data` is the RPC's OWN payload — the
 *   transport adds the Roomful `{data}` envelope. Never pass `{data: {...}}`:
 *   it arrives double-wrapped and the ack is a plausible-looking
 *   "Resource not found" for something that exists.
 * @property {(handler: (data: any) => void) => (() => void)} [onResourceUpdated]
 *   Optional `resource:updated` push subscription, returning an unsubscribe.
 *   Transports without push omit it; consumers must fall back to polling.
 * @property {ValuSocket} [underlying]
 *   When this socket is an observing wrapper, the real transport underneath.
 *   Consumers keying per-connection state must key on `underlying ?? socket`.
 */

/**
 * True when an ack reports a failure.
 *
 * Roomful sets `error.status`, but some RPCs answer with a bare `error`
 * object. Treat any `error` as a failure unless it explicitly says
 * `status: false`.
 * @param {ValuAck} [ack]
 */
export function isAckError(ack) {
  return Boolean(ack && ack.error && ack.error.status !== false);
}

/**
 * Human-readable message out of a failed ack.
 * @param {ValuAck} [ack]
 * @param {string} [fallback]
 */
export function ackErrorMessage(ack, fallback = 'call failed') {
  return ack?.error?.message || ack?.error?.description || fallback;
}

/**
 * Return the ack's data, or throw {@link ValuServiceError}.
 * @param {ValuAck} ack
 * @param {{service?: string, fn?: string, fallback?: string}} [context]
 */
export function unwrapAck(ack, context = {}) {
  if (isAckError(ack)) {
    throw new ValuServiceError(ackErrorMessage(ack, context.fallback), {
      code: ack.error.code,
      description: ack.error.description,
      service: context.service,
      fn: context.fn,
      ack,
    });
  }
  return ack?.data;
}

/**
 * Give an ack one shape.
 *
 * The transports underneath do not agree: the headless connection answers a
 * timeout with a bare `{error: {status, message}}` and no code, the browser
 * service rejects instead. A caller switching on `error.code` should not have
 * to know which one served it, so the code is inferred here when the transport
 * did not set one — from the only thing it did give us, the message.
 * @param {ValuAck} [ack]
 * @returns {ValuAck}
 */
export function normalizeAck(ack) {
  if (!ack || typeof ack !== 'object') return {};
  if (!ack.error) return ack;

  const error = { status: true, ...ack.error };
  if (error.code === undefined) {
    const text = `${error.message ?? ''} ${error.description ?? ''}`;
    if (/timed? ?out/i.test(text)) error.code = ERROR_CODES.TIMEOUT;
    else if (/not connected|not ready|disconnect|dropped|no socket/i.test(text)) {
      error.code = ERROR_CODES.DISCONNECTED;
    }
  }
  return { ...ack, error };
}

/** Wrap a value as a successful ack. */
export const dataAck = (data) => ({ data });

export { ERROR_CODES, ValuServiceError, errorAck };
