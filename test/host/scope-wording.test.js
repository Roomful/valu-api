// ===========================================================================
// One plain sentence for every scope (scopeWording.js): what the consent page
// shows for a consent-tier scope, and what the Developer Portal shows for every
// other tier, so an app's whole permission list reads in one voice.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SCOPE_DESCRIPTIONS, SCOPE_WORDING, describeScope } from '../../src/host/scopeWording.js';
import { SCOPE_WORDING as PAGE_WORDING } from '../../src/host/consentPage.js';
import { TIER_OF } from '../../src/host/Permissions.js';

test('there is a sentence for every scope the host knows, and no other', () => {
  assert.deepEqual(Object.keys(SCOPE_DESCRIPTIONS).sort(), Object.keys(TIER_OF).sort());
});

test('a consent scope says exactly what the consent window says', () => {
  for (const [scope, tier] of Object.entries(TIER_OF)) {
    if (tier !== 'consent') continue;
    assert.equal(SCOPE_DESCRIPTIONS[scope], SCOPE_WORDING[scope], scope);
  }
});

test('every sentence is plain, short and finished', () => {
  for (const [scope, text] of Object.entries(SCOPE_DESCRIPTIONS)) {
    assert.equal(typeof text, 'string', scope);
    assert.ok(text.length > 0 && text.length < 300, scope);
    assert.ok(text.endsWith('.'), scope);
  }
  assert.ok(Object.isFrozen(SCOPE_DESCRIPTIONS));
});

test('describeScope answers null for a scope Valu does not know', () => {
  assert.equal(describeScope('nope:x'), null);
  assert.equal(describeScope(undefined), null);
  assert.equal(describeScope('rooms:read'), SCOPE_WORDING['rooms:read']);
});

test('the consent page still exports the same wording object', () => {
  assert.equal(PAGE_WORDING, SCOPE_WORDING);
});
