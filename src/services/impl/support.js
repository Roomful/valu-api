// ===========================================================================
// What every Phase 2 handler is written against.
//
// A handler takes `(params, ctx)` and RESOLVES an ack — it never throws, never
// retries, and never reaches past `ctx` (docs/callbacks-policy.md). These are
// the six things all 77 of them need, in one place, so a handler is the RPC it
// performs and nothing else.
// ===========================================================================
import { ERROR_CODES, errorAck } from '../../Errors.js';
import { isAckError, ackErrorMessage } from '../../socket/ValuSocket.js';
import { guruAck } from '../../socket/ValuGuruSocket.js';
import { hostCapability } from '../../host/HostState.js';

/** A successful ack. `dataAck` with a name that reads at a call site. */
export const ok = (data = {}) => ({ data });

/** A failed ack, in the one envelope every layer uses. */
export const fail = (code, message, description) => errorAck(code, message, description);

/** The caller got the params past validation but the VALUE is unusable. */
export const invalid = (message) => fail(ERROR_CODES.INVALID_PARAMS, message);

export { isAckError, ackErrorMessage };

/**
 * One Roomful RPC, mapped into the ack envelope.
 *
 * The payload is the RPC's OWN object — `ValuSocket.emit` adds the `{data}`
 * envelope. Passing `{data: {...}}` here double-wraps it and the platform
 * answers "Resource not found" for something that exists, which is the single
 * most expensive mistake in this layer.
 *
 * @param {object} ctx
 * @param {string} ns
 * @param {object} [payload]
 * @param {(data: any) => any} [pick] Shape the ack data. Default: pass through.
 */
export async function rpc(ctx, ns, payload = {}, pick) {
  const ack = await ctx.socket.emit(ns, payload, ctx.timeoutMs);
  if (isAckError(ack)) return ack;
  return ok(pick ? pick(ack.data ?? {}) : (ack.data ?? {}));
}

/**
 * A Roomful RPC whose data the caller wants raw, errors included — for the
 * handlers that compose several calls and decide for themselves.
 */
export const raw = (ctx, ns, payload = {}, timeoutMs) =>
  ctx.socket.emit(ns, payload, timeoutMs ?? ctx.timeoutMs);

/** One Valu Guru op, mapped into the ack envelope. */
export function guru(ctx, op, params = {}, pick) {
  return guruAck(async () => {
    const data = await ctx.guru.request(op, params, { timeoutMs: ctx.timeoutMs });
    return pick ? pick(data ?? {}) : (data ?? {});
  }, ctx.descriptor.key);
}

/** One typed Valu Guru catalogue message (`{type: 'rag_search', …}`). */
export function guruSend(ctx, message, pick) {
  if (typeof ctx.guru?.send !== 'function') {
    return Promise.resolve(fail(
      ERROR_CODES.UNSUPPORTED,
      `${ctx.descriptor.key} needs a Valu Guru socket that can send catalogue messages`,
    ));
  }
  return guruAck(async () => {
    const reply = await ctx.guru.send(message, { timeoutMs: ctx.timeoutMs });
    return pick ? pick(reply ?? {}) : (reply ?? {});
  }, ctx.descriptor.key);
}

/**
 * A host-state capability, or the ack that says which one was missing.
 * @returns {{fn: Function}|{ack: object}}
 */
export const host = (ctx, capability) => hostCapability(ctx.host, capability, ctx.descriptor);

/** Run a host-state read, turning a throw into an ack. */
export async function fromHost(ctx, capability, run) {
  const got = host(ctx, capability);
  if (got.ack) return got.ack;
  try {
    return ok(await run(got.fn));
  } catch (error) {
    return fail(ERROR_CODES.UNSUPPORTED, `${ctx.descriptor.key}: ${error?.message ?? error}`);
  }
}

// --- coercion --------------------------------------------------------------
// Validation already refused the wrong TYPE (src/services/validate.js); these
// apply the DEFAULTS the app applies, so a call with no `limit` behaves the
// same through the SDK as it does through the bridge.

export const str = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
export const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
export const list = (value) => (Array.isArray(value) ? value : []);
export const ids = (value) => list(value).map((id) => String(id)).filter(Boolean);

/** A page size, defaulted and capped the way the app caps it. */
export const limit = (value, fallback, max = 100) => {
  const n = num(value, fallback);
  return Math.min(Math.max(Math.trunc(n), 1), max);
};

/** The caller's own user id, however the socket knows it. */
export const selfId = (ctx) => ctx.socket.selfUserId || ctx.socket.userId || '';

/** The network the call is scoped to: the caller's, else the socket's. */
export const networkOf = (ctx, given) => str(given) || ctx.socket.networkId || '';
