// ===========================================================================
// The typed intents at the transport: an intent's reply read into the ack
// envelope, and the Valu Social page a `window` intent opens at the app's own
// address.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  intentAck, intentWindowUrl, openedIntentAck, popupBlockedAck, skippedIntentAck,
} from '../../src/services/intents.js';

test('a reply that succeeded is the data', () => {
  assert.deepEqual(intentAck({ success: true, items: [1] }), { data: { success: true, items: [1] } });
  assert.deepEqual(intentAck(undefined), { data: {} });
  assert.deepEqual(intentAck({ count: 2 }), { data: { count: 2 } });
});

test("an application's refusal keeps its code, its words and its scope, under the ack's numeric code", () => {
  assert.deepEqual(intentAck({ success: false, code: 'consent_required', error: 'not allowed yet', scope: 'commerce:read' }), {
    error: { status: true, code: 403, message: 'consent_required', description: 'not allowed yet', scope: 'commerce:read' },
  });
  assert.deepEqual(intentAck({ success: false, code: 'out_of_stock', error: 'gone' }), {
    error: { status: true, code: 500, message: 'out_of_stock', description: 'gone' },
  });
  assert.deepEqual(intentAck({ success: false }), { error: { status: true, code: 500, message: 'error' } });
});

test("the host's refusal is read the same way", () => {
  assert.deepEqual(intentAck({ error: { code: 'not_available', message: 'Commerce.open-cart is not available through the valu-api host' } }), {
    error: { status: true, code: 501, message: 'not_available', description: 'Commerce.open-cart is not available through the valu-api host' },
  });
  assert.deepEqual(intentAck({ error: { code: 'permission_not_declared', message: 'x', scope: 'commerce:read' } }).error.scope, 'commerce:read');
  assert.equal(intentAck({ error: { code: 'sign_in_required', message: 'x' } }).error.code, 401);
});

test('the window url is the intent route on the sign-in origin, popup forced off, objects as JSON', () => {
  const url = intentWindowUrl('https://live.valuverse.io', { service: 'Commerce', action: 'open-order' }, {
    orderId: 'ord_1', popup: true, count: 2, flag: false, nothing: undefined, nested: { a: 1 },
  });
  assert.equal(url, 'https://live.valuverse.io/-i/Commerce/open-order?orderId=ord_1&count=2&flag=false&nested=%7B%22a%22%3A1%7D&popup=false');
  assert.equal(intentWindowUrl('https://x.test', { service: 'Commerce', action: 'open-cart' }), 'https://x.test/-i/Commerce/open-cart?popup=false');
});

test('the fixed answers', () => {
  assert.deepEqual(skippedIntentAck(), { data: { success: true, skipped: true, reason: 'embedded_only' } });
  assert.deepEqual(openedIntentAck(), { data: { success: true, opened: 'tab' } });
  assert.equal(popupBlockedAck('Commerce.open-cart').error.message, 'popup_blocked');
  assert.equal(popupBlockedAck('Commerce.open-cart').error.code, 501);
});
