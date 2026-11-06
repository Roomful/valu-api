// ===========================================================================
// Which typed function replaces a call made over the older postMessage bridge.
// The table is generated (scripts/generate.mjs); this is the lookup.
// Pure: no DOM, no I/O.
// ===========================================================================
import { BRIDGE_REPLACEMENTS } from './replacements.generated.js';

export { BRIDGE_REPLACEMENTS };

/**
 * The typed call that replaces an old bridge call, as source text
 * (`valu.Users.current()`), or null when none does.
 * @param {string} kind `pointer-run`, `run-console`, `run-intent`, `service-intent-other`, `run-command` or `direct`
 * @param {string} name the call's name as the scan reports it
 * @returns {string|null}
 */
export function bridgeReplacement(kind, name) {
  const key = `${kind} ${name}`;
  return Object.hasOwn(BRIDGE_REPLACEMENTS, key) ? BRIDGE_REPLACEMENTS[key] : null;
}
