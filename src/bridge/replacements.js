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
  if (Object.hasOwn(BRIDGE_REPLACEMENTS, key)) return BRIDGE_REPLACEMENTS[key];
  // `sendIntent(new Intent('<app>'))` opens any app, declared or not: the
  // counter names it `<app>.open`, and `valu.Apps.open` opens any app by id.
  const opened = kind === 'run-intent' && OPEN_INTENT.exec(String(name));
  return opened ? `valu.Apps.open('${opened[1]}')` : null;
}

/** `<app>.open`, the app id a bare identifier (what the counter reports). */
const OPEN_INTENT = /^([A-Za-z0-9_-]+)\.open$/;
