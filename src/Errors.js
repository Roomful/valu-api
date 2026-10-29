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
  /** The connection this function needs is not there, or no handler is
   * registered for it. */
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

/**
 * The `message` of an ack the host or Valu Social refuses because the app's
 * valu-permissions.json does not declare the scope (`error.scope` names it).
 * The same string as `HOST_ERRORS.PERMISSION_NOT_DECLARED`.
 */
export const PERMISSION_NOT_DECLARED = 'permission_not_declared';

/**
 * Thrown by the unwrapping call paths for a call the app's
 * valu-permissions.json does not allow: the fix is a line in that file (the
 * scope, and a reason), not a retry and not a question to the user.
 */
export class PermissionNotDeclaredError extends ValuServiceError {
  /**
   * @param {string} message
   * @param {{code?: number, description?: string, service?: string, fn?: string, ack?: object, scope?: string}} [detail]
   */
  constructor(message, detail = {}) {
    super(message, detail);
    this.name = 'PermissionNotDeclaredError';
    this.scope = detail.scope ?? null;
  }
}

/**
 * Is this ack (or a thrown error carrying one) a refusal for a scope the app
 * does not declare?
 * @param {unknown} ackOrError
 */
export function isPermissionNotDeclared(ackOrError) {
  const ack = ackOrError instanceof ValuServiceError ? ackOrError.ack : ackOrError;
  return ack?.error?.message === PERMISSION_NOT_DECLARED;
}
