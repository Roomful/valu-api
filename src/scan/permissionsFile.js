// ===========================================================================
// `valu-permissions.json` — the scopes an app says it needs, each with the
// reason a reviewer reads.
//
//   { "permissions": [ { "scope": "rooms:read", "why": "Lists your rooms." } ] }
//
// A Workspaces app keeps it at its repository root (the AI worker writes it);
// an app Valu does not build serves it at `/.well-known/valu-permissions.json`.
// The server that checks it at publish and the Developer Portal that shows it
// both read it with `parsePermissionsFile`, so a file means one thing.
//
// Reading never throws. A broken file is read as far as it parses and the rest
// is said in `error`: a publish is never refused over this file (the owner's
// decision, 2026-10-28), so the useful answer is what CAN be read, plus why the
// rest could not.
// ===========================================================================
import { TIER_OF } from '../host/Permissions.js';

/** A scope as valu-api names them: `<service>:<access>`, lower case. No wildcards. */
export const SCOPE_PATTERN = /^[a-z]+:[a-z]+$/;

/** The longest reason kept. One plain sentence fits; an essay is cut. */
export const WHY_MAX = 200;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * @typedef {{scope: string, why: string}} DeclaredPermission
 * @typedef {{present: boolean, error: string|null, permissions: DeclaredPermission[]}} PermissionsFile
 */

/**
 * Read the file's text.
 * @param {string|null|undefined} text the file, or null when there is none
 * @returns {PermissionsFile}
 */
export function parsePermissionsFile(text) {
  if (text === null || text === undefined) return { present: false, error: null, permissions: [] };

  let data;
  try {
    data = JSON.parse(String(text));
  } catch (err) {
    return { present: true, error: `not valid JSON: ${err.message}`, permissions: [] };
  }
  if (!isObject(data) || !Array.isArray(data.permissions)) {
    return { present: true, error: '"permissions" must be an array of {scope, why}', permissions: [] };
  }

  const problems = [];
  const seen = new Set();
  const permissions = [];
  data.permissions.forEach((entry, index) => {
    const scope = isObject(entry) && typeof entry.scope === 'string' ? entry.scope.trim() : '';
    if (!SCOPE_PATTERN.test(scope)) {
      problems.push(`entry ${index} has no valid "scope" (like "rooms:read")`);
      return;
    }
    if (seen.has(scope)) return;
    seen.add(scope);
    const why = typeof entry.why === 'string' ? entry.why.replace(/\s+/g, ' ').trim().slice(0, WHY_MAX) : '';
    permissions.push({ scope, why });
  });

  return { present: true, error: problems.length ? problems.join('; ') : null, permissions };
}

const sorted = (values) => [...new Set(values)].sort();

/**
 * The file against what the code was seen to call.
 *
 * `required` is BOTH: a scope the code calls is needed whether or not the file
 * lists it, and a listed scope stays on the list because the scanner cannot see
 * every call (a name built at run time). The other lists are what a reviewer and
 * the AI worker are told to look at.
 *
 * @param {{permissions?: DeclaredPermission[]}|null} file
 * @param {string[]} detectedScopes
 * @param {Iterable<string>} [knownScopes] defaults to every scope this valu-api knows
 * @returns {{required: string[], missingFromFile: string[], unusedInFile: string[], unknown: string[], noReason: string[]}}
 */
export function comparePermissions(file, detectedScopes, knownScopes = Object.keys(TIER_OF)) {
  const declared = Array.isArray(file?.permissions) ? file.permissions : [];
  const listed = new Set(declared.map((p) => p.scope));
  const used = new Set(detectedScopes ?? []);
  const known = new Set(knownScopes);
  const required = sorted([...listed, ...used]);
  return {
    required,
    missingFromFile: sorted([...used].filter((scope) => !listed.has(scope))),
    unusedInFile: sorted([...listed].filter((scope) => !used.has(scope))),
    unknown: required.filter((scope) => !known.has(scope)),
    noReason: sorted(declared.filter((p) => !p.why).map((p) => p.scope)),
  };
}
