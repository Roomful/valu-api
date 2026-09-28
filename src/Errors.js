/**
 * Error codes carried on the ack envelope's `error.code`.
 *
 * The transports and the remote both answer in the same shape, so a caller
 * that switches on the code does not need to know which layer failed.
 */
export const ERROR_CODES = {
  /** Params did not match the descriptor. Never reaches the wire. */
  INVALID_PARAMS: 400,
  /** The caller's token does not carry the scope the descriptor requires. */
  FORBIDDEN: 403,
  /** No such service or function in the catalogue. */
  UNKNOWN_FUNCTION: 404,
  /** The call did not answer within its timeout. */
  TIMEOUT: 408,
  /** The transport cannot serve this binding (e.g. a host intent on a socket). */
  UNSUPPORTED: 501,
  /** No usable connection — never opened, or lost and not recovered. */
  DISCONNECTED: 503,
};

/**
 * Thrown by the unwrapping call paths (`invoke`, `unwrapAck`). The envelope
 * paths (`call`) never throw this — they resolve the error ack instead.
 */
export class ValuServiceError extends Error {
  /**
   * @param {string} message
   * @param {{code?: number, description?: string, service?: string, fn?: string, ack?: object}} [detail]
   */
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ValuServiceError';
    this.code = detail.code;
    this.description = detail.description;
    this.service = detail.service;
    this.fn = detail.fn;
    this.ack = detail.ack;
  }
}

/** Build the standard error ack. Every layer that fails a call uses this. */
export const errorAck = (code, message, description) => ({
  error: { status: true, code, message, ...(description ? { description } : {}) },
});
