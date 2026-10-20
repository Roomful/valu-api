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
//   local      runs in the app page, not through the host (`Http.*`).
//
// `decide` is the whole rule, a pure function of the scope and of whether the
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
 * place), so they never reach the host. A function that does arrive here on the
 * `local` channel is answered 501 by the bridge, not by a tier; `decide` has
 * nothing to say about one and lets it through.
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
  'veruswallet:read': 'consent',
  'commerce:read': 'consent',
  'commerce:write': 'consent',
  'commerce:sell': 'consent',
  // local: runs in the app page
  'http:read': 'local',
  'http:write': 'local',
  // forbidden: an app never gets these, whatever the user says
  'veruswallet:write': 'forbidden',
  'cbac:write': 'forbidden',
  'developer:write': 'forbidden',
  'developer:read': 'forbidden',
});

/**
 * The Commerce intents Valu Guru serves (`valu-guru` in
 * `APPLICATION_INTENT_REASON`), by the scope they need, plus the two event
 * subscriptions, which are reads. Anything of Commerce that is not here — the
 * pickers and the `open-*` windows, which have no RPC — is not served.
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
 *   for (user, app, scope). Read only for a `consent` scope.
 * @returns {{ok: true}|{ok: false, code: 'forbidden'|'consent_required'|'unknown_function'}}
 */
export function decide({ scope, hasGrant = false }) {
  switch (tierOf(scope)) {
    case 'basic':
    case 'local': // the caller's concern: the host answers 501 for a local function
      return { ok: true };
    case 'consent':
      return hasGrant ? { ok: true } : { ok: false, code: HOST_ERRORS.CONSENT_REQUIRED };
    case 'forbidden':
      return { ok: false, code: HOST_ERRORS.FORBIDDEN };
    default:
      return { ok: false, code: HOST_ERRORS.UNKNOWN_FUNCTION };
  }
}
