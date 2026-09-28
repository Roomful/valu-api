// ===========================================================================
// Runtime param validation, from the descriptor.
//
// This is where the manifest stops being documentation: a call whose params do
// not match the declared schema is refused HERE, before the wire, with the
// same error envelope every other failure uses.
// ===========================================================================
import { ERROR_CODES, errorAck } from '../Errors.js';

const CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  'string[]': (v) => Array.isArray(v) && v.every((i) => typeof i === 'string'),
  'object[]': (v) => Array.isArray(v) && v.every((i) => typeof i === 'object' && i !== null && !Array.isArray(i)),
  // Browser-only; on node anything array-like with a length passes.
  FileList: (v) => (typeof FileList !== 'undefined' && v instanceof FileList)
    || (typeof v === 'object' && v !== null && typeof v.length === 'number'),
};

/**
 * @param {import('./descriptors.js').ServiceDescriptor} descriptor
 * @param {object} [params]
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateParams(descriptor, params = {}) {
  const errors = [];

  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, errors: ['params must be an object'] };
  }

  const declared = [...descriptor.params.required, ...descriptor.params.optional];
  const known = new Set(declared.map((p) => p.name));

  for (const param of descriptor.params.required) {
    if (params[param.name] === undefined || params[param.name] === null) {
      errors.push(`missing required param "${param.name}" (${param.type})`);
    }
  }

  for (const param of declared) {
    const value = params[param.name];
    if (value === undefined || value === null) continue;

    const check = CHECKS[param.type];
    if (check && !check(value)) {
      errors.push(`param "${param.name}" must be ${param.type}`);
      continue;
    }
    if (param.options && !param.options.includes(value)) {
      errors.push(`param "${param.name}" must be one of: ${param.options.join(', ')}`);
    }
  }

  // Unknown params are refused, not dropped: a typo'd param name silently
  // falling through is how a caller ends up debugging the remote.
  for (const name of Object.keys(params)) {
    if (!known.has(name)) {
      errors.push(`unknown param "${name}" — ${descriptor.key} accepts: ${[...known].join(', ') || 'no params'}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate, and return an error ack when it fails.
 * @returns {import('../socket/ValuSocket.js').ValuAck|null} null when valid.
 */
export function validationAck(descriptor, params) {
  const { ok, errors } = validateParams(descriptor, params);
  if (ok) return null;
  return errorAck(
    ERROR_CODES.INVALID_PARAMS,
    `${descriptor.key}: ${errors[0]}`,
    errors.join('; '),
  );
}
