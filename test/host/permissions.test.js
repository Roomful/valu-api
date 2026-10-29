// ===========================================================================
// Permissions — which scope a call needs, which tier that scope is in, and
// what the host does about it (spec §4.6).
//
// The catalogue tests iterate the REAL catalogue, not a list kept here: a
// function added to the catalogue without a tier fails here, which is the
// point — a scope with no tier would fail closed at run time, and the host
// would answer `unknown_function` for something the SDK can do.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TIER_OF, tierOf, scopeOfDescriptor, scopeOfIntent, decide, checkDeclared, readDeclaration,
} from '../../src/host/Permissions.js';
import { BRIDGE_SCOPES } from '../../src/host/BridgeScopes.js';
import {
  SERVICE_DESCRIPTORS, APPLICATION_ONLY_INTENTS, APPLICATION_INTENT_REASON,
} from '../../src/services/catalog.generated.js';
import { findDescriptor } from '../../src/services/descriptors.js';
import { HOST_ERRORS } from '../../src/host/protocol.js';

/** The scopes of spec §4.6, by tier. Written out here because the spec is the source of truth. */
const SPEC = {
  basic: [
    'users:read', 'networks:read', 'time:read', 'resources:read', 'profile:read',
    'applicationstorage:read', 'applicationstorage:write', 'application:identity',
    // the older Valu Social bridge (BridgeScopes.js, 2026-10-29)
    'ui:open', 'apps:intent',
  ],
  consent: [
    'users:write', 'rooms:read', 'rooms:write', 'textchat:read', 'textchat:write',
    'groups:read', 'groups:write', 'events:read', 'events:write', 'community:read',
    'cbac:read', 'cms:read', 'cms:write',
    'commerce:read', 'commerce:write', 'commerce:sell',
    // the older Valu Social bridge (BridgeScopes.js, 2026-10-29)
    'networks:write', 'videochat:read', 'videochat:write', 'hubs:read', 'hubs:write', 'valuguru:write',
  ],
  local: ['http:read', 'http:write'],
  // veruswallet:read (ruling 2026-10-21): its one function is on the app-state channel and answers 501,
  // so a consent for it would grant nothing.
  forbidden: ['veruswallet:read', 'veruswallet:write', 'cbac:write', 'developer:write', 'developer:read'],
};

/** Commerce intents of spec §4.6, by scope. */
const COMMERCE = {
  'commerce:read': [
    'check-entitlements', 'get-cart', 'get-display', 'get-order', 'get-product',
    'get-purchase-contents', 'list-categories', 'list-orders', 'list-products',
    'list-purchases', 'preview-promo',
  ],
  'commerce:write': ['add-to-cart', 'clear-cart', 'remove-from-cart', 'update-cart-item'],
  'commerce:sell': [
    'create-product', 'create-store', 'delete-discount-code', 'end-sale', 'get-analytics',
    'get-my-product', 'get-my-store', 'list-my-products', 'list-network-access',
    'list-promotions', 'list-seller-products', 'quote-bundle', 'remove-volume-tier',
    'request-network-access', 'update-product',
  ],
};

const split = (key) => { const at = key.indexOf('.'); return [key.slice(0, at), key.slice(at + 1)]; };

// ---------------------------------------------------------------------------
// The tier table
// ---------------------------------------------------------------------------

test('TIER_OF is the table of spec 4.6, and is frozen', () => {
  assert.ok(Object.isFrozen(TIER_OF));
  for (const [tier, scopes] of Object.entries(SPEC)) {
    const actual = Object.entries(TIER_OF).filter(([, t]) => t === tier).map(([scope]) => scope);
    assert.deepEqual(actual.sort(), [...scopes].sort(), `tier ${tier}`);
  }
  assert.equal(Object.keys(TIER_OF).length, 10 + 22 + 2 + 5);
});

test('every one of the 27 descriptor scopes has a tier', () => {
  const scopes = new Set(SERVICE_DESCRIPTORS.map((d) => d.scopes[0]));
  assert.equal(scopes.size, 27);
  for (const descriptor of SERVICE_DESCRIPTORS) {
    assert.equal(descriptor.scopes.length, 1, `${descriptor.key} has one scope`);
    assert.notEqual(tierOf(descriptor.scopes[0]), null, `${descriptor.key}: ${descriptor.scopes[0]}`);
  }
});

test('every descriptor on the local channel is basic or local, never asked about', () => {
  for (const descriptor of SERVICE_DESCRIPTORS.filter((d) => d.channel === 'local')) {
    assert.ok(['basic', 'local'].includes(tierOf(descriptor.scopes[0])), descriptor.key);
  }
  assert.equal(tierOf('http:read'), 'local');
  assert.equal(tierOf('http:write'), 'local');
});

test('no scope in the table is unused: it belongs to a descriptor, an intent or the older bridge', () => {
  const used = new Set([...SERVICE_DESCRIPTORS.map((d) => d.scopes[0]), ...BRIDGE_SCOPES]);
  for (const key of APPLICATION_ONLY_INTENTS) {
    const scope = scopeOfIntent(...split(key));
    if (scope) used.add(scope);
  }
  assert.deepEqual([...used].sort(), Object.keys(TIER_OF).sort());
});

test('tierOf answers null for anything it does not know', () => {
  for (const scope of ['', 'nope:read', 'users', 'users:admin', 'USERS:READ', undefined, null, 7, {}]) {
    assert.equal(tierOf(scope), null, String(scope));
  }
  // an object's own inherited keys are not scopes
  for (const scope of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(tierOf(scope), null, scope);
  }
});

test('the named tiers, spot-checked through tierOf', () => {
  assert.equal(tierOf('users:read'), 'basic');
  assert.equal(tierOf('applicationstorage:write'), 'basic');
  assert.equal(tierOf('application:identity'), 'basic');
  assert.equal(tierOf('rooms:write'), 'consent');
  assert.equal(tierOf('commerce:sell'), 'consent');
  assert.equal(tierOf('veruswallet:read'), 'forbidden');
  assert.equal(tierOf('veruswallet:write'), 'forbidden');
  assert.equal(tierOf('developer:read'), 'forbidden');
});

// ---------------------------------------------------------------------------
// scope of a function
// ---------------------------------------------------------------------------

test('scopeOfDescriptor is the descriptor\'s one scope', () => {
  for (const descriptor of SERVICE_DESCRIPTORS) {
    assert.equal(scopeOfDescriptor(descriptor), descriptor.scopes[0], descriptor.key);
  }
  assert.equal(scopeOfDescriptor(findDescriptor('Users.search-users')), 'users:read');
  assert.equal(scopeOfDescriptor(findDescriptor('VerusWallet.transfer')), 'veruswallet:write');
});

test('every one of the 30 valu-guru Commerce intents has a scope', () => {
  const served = APPLICATION_ONLY_INTENTS.filter((key) => (
    key.startsWith('Commerce.') && APPLICATION_INTENT_REASON[key] === 'valu-guru'));
  assert.equal(served.length, 30);
  for (const key of served) {
    const scope = scopeOfIntent(...split(key));
    assert.ok(scope, `${key} has a scope`);
    assert.equal(tierOf(scope), 'consent', `${key} -> ${scope}`);
  }
});

test('the Commerce intents map to the scopes of spec 4.6', () => {
  let count = 0;
  for (const [scope, actions] of Object.entries(COMMERCE)) {
    for (const act of actions) {
      assert.equal(scopeOfIntent('Commerce', act), scope, `Commerce.${act}`);
      count += 1;
    }
  }
  assert.equal(count, 30);
  assert.equal(COMMERCE['commerce:read'].length, 11);
  assert.equal(COMMERCE['commerce:write'].length, 4);
  assert.equal(COMMERCE['commerce:sell'].length, 15);
});

test('subscribing to Commerce events is commerce:read', () => {
  assert.equal(scopeOfIntent('Commerce', 'subscribe-events'), 'commerce:read');
  assert.equal(scopeOfIntent('Commerce', 'unsubscribe-events'), 'commerce:read');
});

test('Application.get-identity-token is application:identity, and basic', () => {
  assert.equal(scopeOfIntent('Application', 'get-identity-token'), 'application:identity');
  assert.equal(tierOf(scopeOfIntent('Application', 'get-identity-token')), 'basic');
});

test('every other application-only intent has no scope: the host does not serve it', () => {
  const served = new Set([
    ...Object.values(COMMERCE).flat().map((act) => `Commerce.${act}`),
    'Commerce.subscribe-events', 'Commerce.unsubscribe-events',
    'Application.get-identity-token',
  ]);
  let unserved = 0;
  for (const key of APPLICATION_ONLY_INTENTS) {
    if (served.has(key)) continue;
    assert.equal(scopeOfIntent(...split(key)), null, key);
    unserved += 1;
  }
  assert.equal(unserved, APPLICATION_ONLY_INTENTS.length - 33);
});

test('scopeOfIntent answers null for what it does not know, and is exact about it', () => {
  assert.equal(scopeOfIntent('Commerce', 'checkout'), null);
  assert.equal(scopeOfIntent('Commerce', 'nope'), null);
  assert.equal(scopeOfIntent('Nope', 'get-cart'), null);
  assert.equal(scopeOfIntent('commerce', 'get-cart'), null, 'the service is case-sensitive');
  assert.equal(scopeOfIntent('Commerce', 'get_cart'), null);
  assert.equal(scopeOfIntent('Commerce', 'getCart'), null);
  assert.equal(scopeOfIntent('Application', 'close-application'), null);
  assert.equal(scopeOfIntent(undefined, undefined), null);
  assert.equal(scopeOfIntent('Commerce', undefined), null);
  assert.equal(scopeOfIntent('Commerce', 'constructor'), null);
  assert.equal(scopeOfIntent('__proto__', 'x'), null);
  // a service or action that is not one name cannot splice into another's key
  assert.equal(scopeOfIntent('Commerce.get', 'cart'), null);
  assert.equal(scopeOfIntent('Commerce', 'get-cart.x'), null);
});

test('a socket function the catalogue serves is never an intent, so no key is in both', () => {
  for (const key of APPLICATION_ONLY_INTENTS) {
    assert.equal(findDescriptor(key), undefined, key);
  }
});

// ---------------------------------------------------------------------------
// the decision
// ---------------------------------------------------------------------------

test('decide returns consent_required without a grant and ok with one', () => {
  for (const scope of SPEC.consent) {
    assert.deepEqual(decide({ scope, hasGrant: false }), { ok: false, code: 'consent_required' }, scope);
    assert.deepEqual(decide({ scope, hasGrant: true }), { ok: true }, scope);
  }
});

test('hasGrant defaults to false', () => {
  assert.deepEqual(decide({ scope: 'rooms:read' }), { ok: false, code: 'consent_required' });
});

test('only hasGrant === true is a grant: a truthy value that is not true is not', () => {
  // `Promise.resolve(false)` is what a caller gets by forgetting an `await`.
  for (const hasGrant of [Promise.resolve(false), 'false', 'true', 1, {}, [], null, 0, '']) {
    assert.deepEqual(
      decide({ scope: 'rooms:read', hasGrant }),
      { ok: false, code: 'consent_required' },
      String(hasGrant),
    );
  }
});

test('a basic scope is ok with or without a grant', () => {
  for (const scope of SPEC.basic) {
    assert.deepEqual(decide({ scope, hasGrant: false }), { ok: true }, scope);
    assert.deepEqual(decide({ scope, hasGrant: true }), { ok: true }, scope);
  }
});

test('forbidden never asks: no grant opens it, and it is never consent_required', () => {
  for (const scope of SPEC.forbidden) {
    for (const hasGrant of [false, true, undefined]) {
      assert.deepEqual(decide({ scope, hasGrant }), { ok: false, code: 'forbidden' }, `${scope} ${hasGrant}`);
    }
  }
});

test('a local scope never passes the gate: it runs in the app page, not through the host', () => {
  for (const scope of SPEC.local) {
    for (const hasGrant of [false, true, undefined]) {
      assert.deepEqual(decide({ scope, hasGrant }), { ok: false, code: 'not_available' }, `${scope} ${hasGrant}`);
    }
  }
});

test('no scope, and a scope with no tier, are unknown_function: the gate fails closed', () => {
  for (const scope of [null, undefined, '', 'nope:read', 'constructor']) {
    for (const hasGrant of [false, true]) {
      assert.deepEqual(decide({ scope, hasGrant }), { ok: false, code: 'unknown_function' }, `${scope} ${hasGrant}`);
    }
  }
  assert.deepEqual(decide({ scope: null }), { ok: false, code: 'unknown_function' });
});

test('a bare decide() fails closed instead of throwing', () => {
  assert.deepEqual(decide(), { ok: false, code: 'unknown_function' });
  assert.deepEqual(decide({}), { ok: false, code: 'unknown_function' });
});

test('the codes are the host protocol\'s own', () => {
  assert.equal(decide({ scope: 'veruswallet:write' }).code, HOST_ERRORS.FORBIDDEN);
  assert.equal(decide({ scope: 'rooms:read' }).code, HOST_ERRORS.CONSENT_REQUIRED);
  assert.equal(decide({ scope: null }).code, HOST_ERRORS.UNKNOWN_FUNCTION);
  assert.equal(decide({ scope: 'http:read' }).code, HOST_ERRORS.NOT_AVAILABLE);
});

test('every catalogue function gets an answer that is not unknown_function', () => {
  const answers = new Set(['forbidden', 'consent_required', 'not_available']);
  for (const descriptor of SERVICE_DESCRIPTORS) {
    const decision = decide({ scope: scopeOfDescriptor(descriptor), hasGrant: false });
    assert.ok(decision.ok === true || answers.has(decision.code), `${descriptor.key}: ${JSON.stringify(decision)}`);
  }
});

test('checkDeclared: only basic and consent scopes are asked about; modes off, report, enforce', () => {
  const enforce = { mode: 'enforce', scopes: ['rooms:read'] };
  assert.deepEqual(checkDeclared({ scope: 'rooms:read', declaration: enforce }), { ok: true });
  assert.deepEqual(checkDeclared({ scope: 'rooms:write', declaration: enforce }),
    { ok: false, code: 'permission_not_declared', miss: true });
  assert.deepEqual(checkDeclared({ scope: 'cbac:write', declaration: enforce }), { ok: true });
  assert.deepEqual(checkDeclared({ scope: 'http:read', declaration: enforce }), { ok: true });
  assert.deepEqual(checkDeclared({ scope: 'rooms:write', declaration: { mode: 'report', scopes: [] } }),
    { ok: true, miss: true });
  assert.deepEqual(checkDeclared({ scope: 'rooms:write', declaration: { mode: 'off', scopes: [] } }), { ok: true });
});

test('readDeclaration: anything that is not a declaration is off, so a server that does not know the rule never switches it on', () => {
  for (const value of [undefined, null, 'enforce', { mode: 'ENFORCE' }, { mode: 'on', scopes: [] }]) {
    assert.equal(readDeclaration(value).mode, 'off');
  }
  assert.deepEqual(readDeclaration({ mode: 'enforce', scopes: ['a:b', 3, null] }), { mode: 'enforce', scopes: ['a:b'] });
  assert.deepEqual(readDeclaration({ mode: 'enforce' }), { mode: 'enforce', scopes: null });
});
