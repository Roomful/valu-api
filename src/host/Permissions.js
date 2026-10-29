// ===========================================================================
// What a call needs, and what the host does about it (spec §4.6, step 3).
//
// Every function the host serves has exactly one SCOPE: a catalogue descriptor
// carries it (`scopes[0]`, `<service>:<read|write>`), and the intents the host
// serves for Valu Social's application layer are mapped to one here. Every
// scope sits in one TIER:
//
//   basic      allowed once the user is signed in;
//   consent    allowed only with an unrevoked grant for (user, app, scope);
//              without one the call answers `consent_required`;
//   forbidden  never allowed, never asked about;
//   local      runs in the app page, not through the host (`Http.*`), so it
//              never passes this gate (`not_available`).
//
// Before the tier, the DECLARATION (the owner's decision, 2026-10-29): an app
// may call only the scopes its valu-permissions.json declares, as Valu
// recorded it. `checkDeclared` is that rule, for the two tiers that can run
// (basic, consent); the others are refused by their tier anyway. The rule is
// rolled out in three modes: `off` (not checked), `report` (checked, counted,
// not refused) and `enforce`.
//
// `decide` is the whole tier rule, a pure function of the scope and of whether the
// grant is held. WHERE the grant is read from (Valu Guru, cached 60 s) and the
// consent flow that creates one are the host's business, not this module's.
//
// No DOM, no I/O.
// ===========================================================================
import { HOST_ERRORS } from './protocol.js';

/**
 * Scope -> tier. A scope that is not here has no tier (`tierOf` says `null`)
 * and the call fails closed.
 *
 * `http:read` / `http:write` are `'local'`: the SDK's own implementation runs
 * them with the app page's `fetch` (the client's HostTransport executes them in
 * place), so they never reach the host. `decide` refuses one as
 * `not_available`, so a local function cannot pass the gate even if the bridge
 * forgets to check its channel; the bridge answers 501 for a `local`-channel
 * function before it gets here. (`Resources.*` URL builders and `Time.*` are
 * `local`-channel too, but their scopes are basic: the channel check is the
 * bridge's, not this table's.)
 *
 * `application:identity` and `commerce:*` are not derived from a service: they
 * belong to the intents in {@link scopeOfIntent}.
 */
export const TIER_OF = Object.freeze({
  // basic: the signed-in user's own view, and the app's own storage bucket
  'users:read': 'basic',
  'networks:read': 'basic',
  'time:read': 'basic',
  'resources:read': 'basic',
  'profile:read': 'basic',
  'applicationstorage:read': 'basic',
  'applicationstorage:write': 'basic',
  'application:identity': 'basic',
  // basic, the older Valu Social bridge only (BridgeScopes.js): open Valu Social's own screens, and send a
  // request to another framed app, which decides for itself what it does with it
  'ui:open': 'basic',
  'apps:intent': 'basic',
  // consent: reaches other people, or the user's data, or money
  'users:write': 'consent',
  'rooms:read': 'consent',
  'rooms:write': 'consent',
  'textchat:read': 'consent',
  'textchat:write': 'consent',
  'groups:read': 'consent',
  'groups:write': 'consent',
  'events:read': 'consent',
  'events:write': 'consent',
  'community:read': 'consent',
  'cbac:read': 'consent',
  'cms:read': 'consent',
  'cms:write': 'consent',
  'commerce:read': 'consent',
  'commerce:write': 'consent',
  'commerce:sell': 'consent',
  // consent, the older Valu Social bridge only (BridgeScopes.js)
  'networks:write': 'consent',
  'videochat:read': 'consent',
  'videochat:write': 'consent',
  'hubs:read': 'consent',
  'hubs:write': 'consent',
  'valuguru:write': 'consent',
  // local: runs in the app page
  'http:read': 'local',
  'http:write': 'local',
  // forbidden: an app never gets these, whatever the user says. veruswallet:read is here because its one
  // function (VerusWallet.get-balance) is on the app-state channel and the host answers it 501: a consent
  // for it would grant nothing.
  'veruswallet:read': 'forbidden',
  'veruswallet:write': 'forbidden',
  'cbac:write': 'forbidden',
  'developer:write': 'forbidden',
  'developer:read': 'forbidden',
});

/**
 * The Commerce intents Valu Guru serves (`valu-guru` in
 * `APPLICATION_INTENT_REASON`), by the scope they need, plus the two event
 * subscriptions, which are reads. Anything else of Commerce is not served: the
 * `no-rpc` intents (the seller's publish and pricing functions, `checkout`,
 * the `open-*` windows) only Valu Social itself can run.
 */
const COMMERCE_ACTIONS = {
  'commerce:read': [
    'check-entitlements', 'get-cart', 'get-display', 'get-order', 'get-product',
    'get-purchase-contents', 'list-categories', 'list-orders', 'list-products',
    'list-purchases', 'preview-promo',
    'subscribe-events', 'unsubscribe-events',
  ],
  'commerce:write': ['add-to-cart', 'clear-cart', 'remove-from-cart', 'update-cart-item'],
  'commerce:sell': [
    'create-product', 'create-store', 'delete-discount-code', 'end-sale', 'get-analytics',
    'get-my-product', 'get-my-store', 'list-my-products', 'list-network-access',
    'list-promotions', 'list-seller-products', 'quote-bundle', 'remove-volume-tier',
    'request-network-access', 'update-product',
  ],
};

/** `Service.action` -> scope, for every intent the host serves. */
const INTENT_SCOPE = Object.freeze({
  'Application.get-identity-token': 'application:identity',
  ...Object.fromEntries(Object.entries(COMMERCE_ACTIONS)
    .flatMap(([scope, actions]) => actions.map((action) => [`Commerce.${action}`, scope]))),
});

const has = (table, key) => typeof key === 'string' && Object.hasOwn(table, key);

/**
 * The tier of a scope.
 * @param {string} scope
 * @returns {'basic'|'consent'|'forbidden'|'local'|null} `null` for a scope
 *   with no tier.
 */
export function tierOf(scope) {
  return has(TIER_OF, scope) ? TIER_OF[scope] : null;
}

/**
 * The scope a catalogue function needs. Every descriptor has exactly one.
 * @param {{scopes: string[]}} descriptor
 * @returns {string}
 */
export function scopeOfDescriptor(descriptor) {
  return descriptor.scopes[0];
}

/**
 * The scope an intent needs, for the intents the host serves over Valu Guru:
 * Commerce's reads, cart and seller functions, its event subscriptions, and
 * `Application.get-identity-token`. Names are the catalogue's own
 * (`Commerce`, `get-cart`), matched exactly.
 * @param {string} service
 * @param {string} action
 * @returns {string|null} `null` for an intent the host does not serve.
 */
export function scopeOfIntent(service, action) {
  if (typeof service !== 'string' || typeof action !== 'string') return null;
  const key = `${service}.${action}`;
  return has(INTENT_SCOPE, key) ? INTENT_SCOPE[key] : null;
}

/**
 * Whether a call may run.
 *
 * @param {object} call
 * @param {string|null|undefined} call.scope From {@link scopeOfDescriptor} or
 *   {@link scopeOfIntent}. `null`/`undefined` means the function is not one the
 *   host serves; a scope with no tier is treated the same, so a scope added
 *   to the catalogue and not here is refused, not allowed.
 * @param {boolean} [call.hasGrant] Whether the user holds an unrevoked grant
 *   for (user, app, scope). Read only for a `consent` scope, and only the
 *   boolean `true` is a grant: a truthy value that is not `true` (a forgotten
 *   `await` leaves a Promise) is not.
 * @returns {{ok: true}|{ok: false, code: 'forbidden'|'consent_required'|'not_available'|'unknown_function'}}
 */
export function decide({ scope, hasGrant = false } = {}) {
  switch (tierOf(scope)) {
    case 'basic':
      return { ok: true };
    case 'consent':
      return hasGrant === true ? { ok: true } : { ok: false, code: HOST_ERRORS.CONSENT_REQUIRED };
    case 'forbidden':
      return { ok: false, code: HOST_ERRORS.FORBIDDEN };
    case 'local': // runs in the app page; it has no business at the host's gate
      return { ok: false, code: HOST_ERRORS.NOT_AVAILABLE };
    default:
      return { ok: false, code: HOST_ERRORS.UNKNOWN_FUNCTION };
  }
}

/** How the declaration is applied: not at all, counted only, or refused. */
export const PERMISSION_MODES = Object.freeze({ OFF: 'off', REPORT: 'report', ENFORCE: 'enforce' });

const MODES = new Set(Object.values(PERMISSION_MODES));

/**
 * A declaration as the host and Valu Social hold it: `{mode, scopes}`, read
 * back into shape. Anything that is not one is `off` with no list: a server
 * that does not know the rule yet must not switch it on by accident.
 * @param {unknown} value
 * @returns {{mode: 'off'|'report'|'enforce', scopes: string[]|null}}
 */
export function readDeclaration(value) {
  const mode = MODES.has(value?.mode) ? value.mode : PERMISSION_MODES.OFF;
  const scopes = Array.isArray(value?.scopes) ? value.scopes.filter((scope) => typeof scope === 'string') : null;
  return { mode, scopes };
}

/**
 * Does the app declare `scope`? Asked only for the tiers that can run
 * (`basic`, `consent`): a forbidden, local or unknown scope keeps its own answer.
 *
 * - `ok: true` and no `miss`: declared, or the rule is off, or the tier is not asked about.
 * - `ok: true, miss: true`: not declared, and the rule is only being reported.
 * - `ok: false, code: 'permission_not_declared', miss: true`: refused.
 *
 * A list of `null` (no file, no record) declares nothing.
 *
 * @param {{scope: string|null|undefined, declaration: unknown}} call
 * @returns {{ok: true, miss?: true}|{ok: false, code: string, miss: true}}
 */
export function checkDeclared({ scope, declaration } = {}) {
  const tier = tierOf(scope);
  if (tier !== 'basic' && tier !== 'consent') return { ok: true };
  const { mode, scopes } = readDeclaration(declaration);
  if (mode === PERMISSION_MODES.OFF) return { ok: true };
  if (scopes?.includes(scope)) return { ok: true };
  return mode === PERMISSION_MODES.ENFORCE
    ? { ok: false, code: HOST_ERRORS.PERMISSION_NOT_DECLARED, miss: true }
    : { ok: true, miss: true };
}
