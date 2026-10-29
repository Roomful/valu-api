// ===========================================================================
// Declaring and reading an app's permissions, and reading where its code can
// send things (the privacy audit) — one entry point for the server that checks
// them at publish, the Developer Portal that shows them, and
// `bin/valu-privacy-scan.js` that lets anyone repeat the check.
// Pure: no DOM, no I/O, no side effects at import (unlike the package root,
// which registers the service functions).
// ===========================================================================
export { detectScopes, stripComments, FINDINGS_PER_CALL, FINDINGS_MAX } from './detectScopes.js';
export { parsePermissionsFile, comparePermissions, SCOPE_PATTERN, WHY_MAX } from './permissionsFile.js';
export { SCOPE_DESCRIPTIONS, SCOPE_WORDING, describeScope } from '../host/scopeWording.js';
export { TIER_OF, tierOf } from '../host/Permissions.js';
export {
  detectEgress, EGRESS_RULES, EGRESS_RULES_VERSION, TELEMETRY_PACKAGES, ONWARD_PATHS, SENDS_TO_OTHERS,
} from './detectEgress.js';
export { VALU_ORIGINS, isValuUrl, hostOf } from './valuOrigins.js';
