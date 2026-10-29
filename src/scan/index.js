// ===========================================================================
// Declaring and reading an app's permissions — one entry point for the server
// that checks them at publish and the Developer Portal that shows them.
// Pure: no DOM, no I/O, no side effects at import (unlike the package root,
// which registers the service functions).
// ===========================================================================
export { detectScopes, stripComments, FINDINGS_PER_CALL, FINDINGS_MAX } from './detectScopes.js';
export { parsePermissionsFile, comparePermissions, SCOPE_PATTERN, WHY_MAX } from './permissionsFile.js';
export { SCOPE_DESCRIPTIONS, SCOPE_WORDING, describeScope } from '../host/scopeWording.js';
export { TIER_OF, tierOf } from '../host/Permissions.js';
