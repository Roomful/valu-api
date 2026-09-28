// ===========================================================================
// The callbacks policy — FROZEN before Phase 2 (see docs/callbacks-policy.md).
//
// 84 functions get written against what is in this file, so the shape of an
// answer, the timeout, the retry rule, the ordering guarantee and the
// behaviour of an in-flight call across a reconnect are decided HERE and
// nowhere else. A function that wants different numbers overrides them in its
// descriptor; it does not invent a different contract.
// ===========================================================================
import { ERROR_CODES } from './Errors.js';
import { isAckError } from './socket/ValuSocket.js';

/**
 * 30s. The same number on both sides today: the app's `emitAsync` default
 * (Services/WebSocket/WebSocket.js) and the server's `EMIT_TIMEOUT_MS`
 * (server-agents/roomful-connection.ts).
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Failures that are worth trying again — the call may never have been served. */
export const RETRIABLE_CODES = new Set([ERROR_CODES.TIMEOUT, ERROR_CODES.DISCONNECTED]);

/** @typedef {{timeoutMs: number, retries: number, backoffMs: number, backoffFactor: number, maxBackoffMs: number, jitter: number}} ResolvedPolicy */

export const DEFAULT_POLICY = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  /** Retries AFTER the first attempt. Reads only — see `forDescriptor`. */
  retries: 2,
  backoffMs: 250,
  backoffFactor: 2,
  maxBackoffMs: 4_000,
  /** ±20% so a reconnect does not stampede every pending call at once. */
  jitter: 0.2,
};

/**
 * The policy for one function.
 *
 * A mutation is never retried: the SDK cannot tell a lost answer from a lost
 * request, and re-sending "create-meeting" because an ack went missing books
 * the room twice. Idempotency keys would change that; until a function
 * declares one, writes get one attempt.
 *
 * @param {{mutates?: boolean, timeoutMs?: number, retries?: number}} [descriptor]
 * @param {Partial<ResolvedPolicy>} [overrides] Per-call overrides.
 * @returns {ResolvedPolicy}
 */
export function forDescriptor(descriptor = {}, overrides = {}) {
  return {
    ...DEFAULT_POLICY,
    retries: descriptor.mutates ? 0 : DEFAULT_POLICY.retries,
    ...(descriptor.timeoutMs ? { timeoutMs: descriptor.timeoutMs } : {}),
    ...(typeof descriptor.retries === 'number' ? { retries: descriptor.retries } : {}),
    ...overrides,
  };
}

/** True when this ack failed in a way another attempt could fix. */
export function isRetriable(ack) {
  return isAckError(ack) && RETRIABLE_CODES.has(ack.error?.code);
}

/**
 * Backoff before attempt `n` (1 = the first retry), with jitter.
 * @param {number} attempt
 * @param {ResolvedPolicy} policy
 * @param {() => number} [random]
 */
export function backoffFor(attempt, policy, random = Math.random) {
  const raw = policy.backoffMs * policy.backoffFactor ** (attempt - 1);
  const capped = Math.min(raw, policy.maxBackoffMs);
  const spread = capped * policy.jitter;
  return Math.round(capped - spread + random() * spread * 2);
}

/**
 * Run one call under its policy. `attempt` resolves an ack envelope and never
 * rejects; so does this.
 *
 * @param {(attempt: number) => Promise<import('./socket/ValuSocket.js').ValuAck>} attempt
 * @param {ResolvedPolicy} policy
 * @param {{sleep?: (ms: number) => Promise<void>, random?: () => number}} [hooks]
 *   Injected by the conformance suite so retry timing is deterministic.
 */
export async function runWithPolicy(attempt, policy, hooks = {}) {
  const sleep = hooks.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = hooks.random ?? Math.random;

  let ack;
  for (let tries = 0; tries <= policy.retries; tries++) {
    ack = await attempt(tries + 1);
    if (!isRetriable(ack) || tries === policy.retries) return ack;
    await sleep(backoffFor(tries + 1, policy, random));
  }
  return ack;
}
