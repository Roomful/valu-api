// ===========================================================================
// CommerceIntents — the 30 Commerce data intents served by the host, each a
// mapping from an intent to `valuguru.commerce.*` ops and back to the answer
// Valu Social documents (docs/api-pointers.md), plus the event mapping.
//
// The fake `guru` records every call (op, params, options) and answers from a
// script; the error it throws is a `GuruError` look-alike (an `Error` with a
// `code`), so nothing here imports the real client. Params are recorded as
// sent, not as JSON would send them, so a key left `undefined` is visible.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMERCE_INTENTS, COMMERCE_APP_EVENTS, runCommerceIntent, mapCommerceEvent, mintIdempotencyKey,
} from '../../src/host/CommerceIntents.js';

const APP = 'app-1';

const guruError = (code, message = `${code}!`, details) => (
  Object.assign(new Error(message), { name: 'GuruError', code, details })
);

/**
 * A fake guru. `script[op]` is a value, an Error to throw, or a function of
 * (params) returning either; an op with no script is a test mistake and throws.
 */
function fakeGuru(script = {}) {
  const calls = [];
  return {
    calls,
    async request(op, params, opts) {
      calls.push({ op, params, opts });
      if (!(op in script)) throw new Error(`no answer scripted for ${op}`);
      const answer = typeof script[op] === 'function' ? await script[op](params) : script[op];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

async function run(action, params, script, options = {}) {
  const guru = fakeGuru(script);
  const result = await runCommerceIntent(action, params, { guru, appId: APP, ...options });
  return { result, calls: guru.calls, ops: guru.calls.map((c) => c.op) };
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const SCOPE_LISTS = {
  'commerce:read': [
    'check-entitlements', 'get-cart', 'get-display', 'get-order', 'get-product', 'get-purchase-contents',
    'list-categories', 'list-orders', 'list-products', 'list-purchases', 'preview-promo',
  ],
  'commerce:write': ['add-to-cart', 'clear-cart', 'remove-from-cart', 'update-cart-item'],
  'commerce:sell': [
    'create-product', 'create-store', 'delete-discount-code', 'end-sale', 'get-analytics', 'get-my-product',
    'get-my-store', 'list-my-products', 'list-network-access', 'list-promotions', 'list-seller-products',
    'quote-bundle', 'remove-volume-tier', 'request-network-access', 'update-product',
  ],
};

/** The op each action is served by (clear-cart, create-product and update-product do more than one). */
const OP_OF = {
  'check-entitlements': 'valuguru.commerce.entitlements.check',
  'get-cart': 'valuguru.commerce.cart.get',
  'get-display': 'valuguru.commerce.display.get',
  'get-order': 'valuguru.commerce.orders.get',
  'get-product': 'valuguru.commerce.catalog.get',
  'get-purchase-contents': 'valuguru.commerce.purchases.tree',
  'list-categories': 'valuguru.commerce.catalog.categories',
  'list-orders': 'valuguru.commerce.orders.list',
  'list-products': 'valuguru.commerce.catalog.search',
  'list-purchases': 'valuguru.commerce.purchases.list',
  'preview-promo': 'valuguru.commerce.orders.previewPromo',
  'add-to-cart': 'valuguru.commerce.cart.add',
  'clear-cart': 'valuguru.commerce.cart.remove',
  'remove-from-cart': 'valuguru.commerce.cart.remove',
  'update-cart-item': 'valuguru.commerce.cart.update',
  'create-product': 'valuguru.commerce.products.create',
  'create-store': 'valuguru.commerce.store.create',
  'delete-discount-code': 'valuguru.commerce.promotions.code.delete',
  'end-sale': 'valuguru.commerce.promotions.sale.end',
  'get-analytics': 'valuguru.commerce.store.analytics',
  'get-my-product': 'valuguru.commerce.products.get',
  'get-my-store': 'valuguru.commerce.store.get',
  'list-my-products': 'valuguru.commerce.products.list',
  'list-network-access': 'valuguru.commerce.store.networks.list',
  'list-promotions': 'valuguru.commerce.promotions.list',
  'list-seller-products': 'valuguru.commerce.products.list',
  'quote-bundle': 'valuguru.commerce.products.quote',
  'remove-volume-tier': 'valuguru.commerce.promotions.tier.remove',
  'request-network-access': 'valuguru.commerce.store.networks.request',
  'update-product': 'valuguru.commerce.products.update',
};

test('every §4.6 action maps to an op, with the scope the spec lists', () => {
  const expected = Object.entries(SCOPE_LISTS).flatMap(([scope, actions]) => actions.map((a) => [a, scope]));
  assert.equal(expected.length, 30);
  assert.deepEqual(Object.keys(COMMERCE_INTENTS).sort(), expected.map(([a]) => a).sort());

  for (const [action, scope] of expected) {
    const entry = COMMERCE_INTENTS[action];
    assert.equal(entry.scope, scope, `${action} scope`);
    assert.equal(entry.op, OP_OF[action], `${action} op`);
    const composite = typeof entry.run === 'function';
    assert.ok(
      composite || (typeof entry.toParams === 'function' && typeof entry.fromResult === 'function'),
      `${action} is either one op with toParams/fromResult, or a run`,
    );
  }
});

test('the table and its entries are frozen', () => {
  assert.ok(Object.isFrozen(COMMERCE_INTENTS));
  for (const [action, entry] of Object.entries(COMMERCE_INTENTS)) {
    assert.ok(Object.isFrozen(entry), `${action} is frozen`);
  }
  assert.throws(() => { COMMERCE_INTENTS['open-cart'] = {}; }, TypeError);
});

test('the UI intents and the payment ops are not in the table', () => {
  for (const ui of ['open-cart', 'open-order', 'open-products', 'open-purchases', 'checkout', 'rate-product',
    'publish-product', 'unlist-product', 'archive-product', 'delete-product', 'set-sale', 'set-volume-tier',
    'create-discount-code', 'update-discount-code', 'set-donation-tiers', 'subscribe-events', 'unsubscribe-events',
    'mark-purchase-file-seen', 'open-purchase-in-media', 'preview-purchase']) {
    assert.equal(ui in COMMERCE_INTENTS, false, ui);
  }
  const forbidden = /api\.keys|simulatePayment|payInstantly|\.admin\.|orders\.create|orders\.buyNow|orders\.cancel|orders\.delete/;
  for (const entry of Object.values(COMMERCE_INTENTS)) assert.doesNotMatch(entry.op, forbidden);
});

test('no action reaches an op outside the commerce catalogue, and appId is never an app\'s to name', async () => {
  const everything = Object.values(SCOPE_LISTS).flat();
  const reached = new Set();
  for (const action of everything) {
    const guru = fakeGuru();
    // Every op answers an empty object: most flows then refuse or shape nothing,
    // which is fine — what is checked is where each one goes and what it sends.
    guru.request = async function request(op, params, opts) {
      guru.calls.push({ op, params, opts });
      return { items: [{ id: 'i1', appId: APP }], product: { id: 'p1', status: 'draft' } };
    };
    await runCommerceIntent(action, {
      appId: 'evil', scope: 'evil', productId: 'p1', productIds: ['p1'], itemId: 'i1', orderId: 'o1', title: 'T',
      code: 'abc', saleId: 's1', tierId: 't1', codeId: 'c1', networkId: 'n1', qty: 1,
    }, { guru, appId: APP, user: { id: 'u1' } });
    for (const call of guru.calls) {
      reached.add(call.op);
      assert.match(call.op, /^valuguru\.commerce\./, `${action} -> ${call.op}`);
      if ('appId' in call.params) assert.equal(call.params.appId, APP, `${action} -> ${call.op} appId`);
      if ('scope' in call.params) assert.equal(call.params.scope, APP, `${action} -> ${call.op} scope`);
    }
  }
  assert.ok(reached.size >= 25, `drove ${reached.size} distinct ops`);
});

// ---------------------------------------------------------------------------
// runCommerceIntent — the envelope
// ---------------------------------------------------------------------------

test('list-products sends catalog.search with appId stamped from ctx, not params', async () => {
  const { result, calls } = await run(
    'list-products',
    { appId: 'evil', query: 'x', storeId: 's1', category: 'books', tag: 'new', attributes: { a: 1 }, sort: 'popular', limit: 10, offset: 20 },
    { 'valuguru.commerce.catalog.search': { products: [{ id: 'p1' }], nextOffset: 30 } },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, 'valuguru.commerce.catalog.search');
  assert.deepEqual(calls[0].params, {
    appId: APP, storeId: 's1', query: 'x', category: 'books', tag: 'new', attributes: { a: 1 }, sort: 'popular', limit: 10, offset: 20,
  });
  assert.deepEqual(result, { products: [{ id: 'p1' }], nextOffset: 30 });
});

test('list-products with only a query sends only that and the stamp; an odd answer is an empty shelf', async () => {
  const { result, calls } = await run('list-products', { query: 'x' }, { 'valuguru.commerce.catalog.search': null });
  assert.deepEqual(calls[0].params, { appId: APP, query: 'x' });
  assert.deepEqual(result, { products: [], nextOffset: null });
});

test('the default timeout is the client\'s: no timeoutMs is passed for an ordinary read', async () => {
  const { calls } = await run('list-categories', {}, { 'valuguru.commerce.catalog.categories': {} });
  assert.equal(calls[0].opts, undefined);
});

test('add-to-cart answers Valu Social\'s shape', async () => {
  const items = [{ id: 'i1', productId: 'p1', appId: APP, qty: 2 }];
  const { result, calls } = await run(
    'add-to-cart',
    { appId: 'evil', productId: 'p1', qty: 2 },
    { 'valuguru.commerce.cart.add': { items } },
  );
  assert.deepEqual(calls.map((c) => [c.op, c.params]), [['valuguru.commerce.cart.add', { productId: 'p1', appId: APP, qty: 2 }]]);
  assert.deepEqual(result, { success: true, items });
});

test('add-to-cart with an answer that holds no list answers an empty one', async () => {
  const { result } = await run('add-to-cart', { productId: 'p1' }, { 'valuguru.commerce.cart.add': {} });
  assert.deepEqual(result, { success: true, items: [] });
});

test('a GuruError becomes {success:false, code, error}', async () => {
  const { result } = await run(
    'add-to-cart',
    { productId: 'p1' },
    { 'valuguru.commerce.cart.add': guruError('out_of_stock', 'None left', { productId: 'p1' }) },
  );
  assert.deepEqual(result, { success: false, code: 'out_of_stock', error: 'None left' });
});

test('an error with no code is answered as code "error"; a timeout keeps its code', async () => {
  const plain = await run('get-cart', {}, { 'valuguru.commerce.cart.get': new TypeError('boom') });
  assert.deepEqual(plain.result, { success: false, code: 'error', error: 'boom' });
  const slow = await run('get-cart', {}, { 'valuguru.commerce.cart.get': guruError('timeout', 'No answer in time') });
  assert.deepEqual(slow.result, { success: false, code: 'timeout', error: 'No answer in time' });
});

test('an unknown action answers not_available, and never reaches the guru', async () => {
  for (const action of ['open-cart', 'checkout', 'nope', '', undefined, null, 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const { result, calls } = await run(action, {}, {});
    assert.equal(result.success, false, String(action));
    assert.equal(result.code, 'not_available', String(action));
    assert.equal(typeof result.error, 'string');
    assert.deepEqual(calls, []);
  }
});

test('an app that cannot be identified is refused before any op', async () => {
  for (const appId of [undefined, null, '']) {
    const guru = fakeGuru({});
    const result = await runCommerceIntent('get-cart', {}, { guru, appId });
    assert.equal(result.success, false);
    assert.equal(result.code, 'forbidden');
    assert.deepEqual(guru.calls, []);
  }
});

test('params that are not an object are read as no params', async () => {
  for (const params of [undefined, null, 'x', 5, []]) {
    const { result } = await run('list-categories', params, { 'valuguru.commerce.catalog.categories': { categories: [] } });
    assert.deepEqual(result, { categories: [] });
  }
});

test('idempotency keys are minted fresh each time', () => {
  const a = mintIdempotencyKey();
  const b = mintIdempotencyKey();
  assert.match(a, /^[\w-]{8,}$/);
  assert.notEqual(a, b);
});

test('without crypto.randomUUID the key falls back to ck_<timestamp>_<random>', () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    for (const stub of [undefined, {}]) {
      Object.defineProperty(globalThis, 'crypto', { value: stub, configurable: true, writable: true });
      const a = mintIdempotencyKey();
      const b = mintIdempotencyKey();
      assert.match(a, /^ck_[0-9a-z]+_[0-9a-z]{1,8}$/);
      assert.notEqual(a, b);
    }
  } finally {
    Object.defineProperty(globalThis, 'crypto', real);
  }
  assert.match(mintIdempotencyKey(), /^[0-9a-f]{8}-[0-9a-f]{4}-/, 'and with it, a uuid again');
});

test('the runner gives an entry a ctx with the stamp and idempotency keys, and honours its timeout', async () => {
  // None of the 30 carries a timeout or needs a key (checkout and publish, which
  // do, are not data intents), so the runner's side of that contract is shown on
  // a table of its own.
  const seen = [];
  const intents = Object.freeze({
    probe: Object.freeze({
      op: 'valuguru.commerce.orders.create',
      scope: 'commerce:write',
      timeoutMs: 60_000,
      toParams: (params, ctx) => {
        seen.push(ctx);
        return { appId: ctx.appId, first: ctx.idempotencyKey(), second: ctx.idempotencyKey() };
      },
      fromResult: (data, params, ctx) => ({ data, params, appId: ctx.appId, hasRequest: typeof ctx.request === 'function' }),
    }),
  });
  const guru = fakeGuru({ 'valuguru.commerce.orders.create': { order: 1 } });
  const result = await runCommerceIntent('probe', { x: 1 }, { guru, appId: APP, intents });

  assert.deepEqual(guru.calls[0].opts, { timeoutMs: 60_000 });
  assert.equal(guru.calls[0].params.appId, APP);
  assert.notEqual(guru.calls[0].params.first, guru.calls[0].params.second);
  assert.deepEqual(result, { data: { order: 1 }, params: { x: 1 }, appId: APP, hasRequest: true });
  assert.equal('probe' in COMMERCE_INTENTS, false, 'the real table is untouched');
});

// ---------------------------------------------------------------------------
// Buyer reads (commerce:read)
// ---------------------------------------------------------------------------

test('check-entitlements sends the ids and answers {entitlements}', async () => {
  const { result, calls } = await run(
    'check-entitlements', { productIds: ['p1', 'p2'] },
    { 'valuguru.commerce.entitlements.check': { p1: true, p2: false } },
  );
  assert.deepEqual(calls[0].params, { productIds: ['p1', 'p2'] });
  assert.deepEqual(result, { entitlements: { p1: true, p2: false } });

  const none = await run('check-entitlements', { productIds: 'p1' }, { 'valuguru.commerce.entitlements.check': null });
  assert.deepEqual(none.calls[0].params, { productIds: [] });
  assert.deepEqual(none.result, { entitlements: {} });
});

test('get-cart answers the whole cart and counts what is not saved for later', async () => {
  const items = [
    { id: 'i1', appId: APP }, { id: 'i2', appId: 'other' }, { id: 'i3', appId: APP, savedForLater: true },
  ];
  const { result, calls } = await run('get-cart', {}, { 'valuguru.commerce.cart.get': { items } });
  assert.deepEqual(calls[0].params, {});
  assert.deepEqual(result, { items, count: 2 });
});

test('get-cart counts with the one badge rule: a row that is not an object is no row, and a truthy savedForLater is saved', async () => {
  const items = [{ id: 'i1', appId: APP }, null, 'x', { id: 'i2', appId: APP, savedForLater: 1 }, { id: 'i3', appId: 'other', savedForLater: false }];
  const { result } = await run('get-cart', {}, { 'valuguru.commerce.cart.get': { items } });
  assert.equal(result.count, 2);
  assert.equal(result.items.length, 5, 'the rows are answered as the server sent them');
});

test('get-display answers the currency and the rate, or the defaults', async () => {
  const shown = await run('get-display', {}, { 'valuguru.commerce.display.get': { currency: 'VRSC', vrscUsd: '2.5', extra: 1 } });
  assert.deepEqual(shown.result, { currency: 'VRSC', vrscUsd: 2.5 });
  const odd = await run('get-display', {}, { 'valuguru.commerce.display.get': { currency: 'EUR', vrscUsd: 0 } });
  assert.deepEqual(odd.result, { currency: 'USD', vrscUsd: null });
});

const ORDER_DETAIL = {
  order: {
    id: 'o1', status: 'paid', created_at: '2026-10-01T10:00:00Z', paid_at: '2026-10-01T10:05:00Z', expires_at: null,
    is_test: false, subtotal_vrsc: '10', total_vrsc: '9', rate_snapshot: { vrscUsd: 2 },
    deeplinks: ['verus://pay-secret'], payment_request_id: 'pr-secret',
  },
  lines: [
    { id: 'l1', order_id: 'o1', role: 'item', product_id: 'p1', app_id: APP, title_snapshot: 'Bundle', qty: 1, unit_price_vrsc: '10', line_total_vrsc: '10', sort_order: 0 },
    { id: 'l2', order_id: 'o1', role: 'component', parent_line_id: 'l1', product_id: 'p2', title_snapshot: 'Part', sort_order: 1 },
    { id: 'l3', order_id: 'o1', role: 'curator_fee', parent_line_id: 'l1', line_total_vrsc: '1', sort_order: 2 },
  ],
  adjustments: [
    { kind: 'discount_code', label: '', amount_vrsc: '1' },
    { kind: 'excluded_owned', product_id: 'p9', amount_vrsc: '3' },
  ],
  payouts: [{ kind: 'store', identity_name: 'seller@', store_id: 's1', amount_vrsc: '8', status: 'paid', donation_percent: null, donation_member_count: null }],
  payment: { method: 'verus', txid: 'tx1', confirmedAt: '2026-10-01T10:05:00Z' },
};

const ORDER_ANSWER = {
  id: 'o1',
  status: 'paid',
  createdAt: '2026-10-01T10:00:00Z',
  paidAt: '2026-10-01T10:05:00Z',
  expiresAt: null,
  isTest: false,
  subtotalVrsc: 10,
  totalVrsc: 9,
  rateVrscUsd: 2,
  items: [{
    productId: 'p1', appId: APP, title: 'Bundle', qty: 1, unitPriceVrsc: 10, lineTotalVrsc: 10, imageResourceId: null,
    deletedBySeller: false, parts: [{ productId: 'p2', title: 'Part' }], bundleFeeVrsc: 1,
  }],
  discounts: [{ kind: 'discount_code', label: 'Discount code', amountVrsc: 1 }],
  notCharged: [{ productId: 'p9', title: 'Owned part', amountVrsc: 3 }],
  payouts: [{
    kind: 'store', identityName: 'seller@', storeId: 's1', amountVrsc: 8, status: 'paid', donationPercent: null, donationMemberCount: null,
  }],
  payment: { method: 'verus', transactionId: 'tx1', failureReason: null },
};

test('get-order answers {order} in the receipt shape, names an owned part from the purchases, and never carries a way to pay', async () => {
  const { result, calls } = await run('get-order', { orderId: 'o1' }, {
    'valuguru.commerce.orders.get': ORDER_DETAIL,
    'valuguru.commerce.purchases.list': { products: [{ productId: 'p9', title: 'Owned part' }] },
  });
  assert.deepEqual(calls[0], { op: 'valuguru.commerce.orders.get', params: { orderId: 'o1' }, opts: undefined });
  assert.deepEqual(result, { order: ORDER_ANSWER });
  const wire = JSON.stringify(result);
  assert.doesNotMatch(wire, /pay-secret|pr-secret|deeplinks/);
});

test('get-order reads the purchases only when a part was already owned, and survives that read failing', async () => {
  const plain = await run('get-order', { orderId: 'o1' }, {
    'valuguru.commerce.orders.get': { ...ORDER_DETAIL, adjustments: [] },
  });
  assert.deepEqual(plain.ops, ['valuguru.commerce.orders.get']);

  const failing = await run('get-order', { orderId: 'o1' }, {
    'valuguru.commerce.orders.get': ORDER_DETAIL,
    'valuguru.commerce.purchases.list': guruError('timeout'),
  });
  assert.deepEqual(failing.result.order.notCharged, [{ productId: 'p9', title: null, amountVrsc: 3 }]);
});

test('get-order refuses a missing id without a round trip, and passes the server\'s refusal on', async () => {
  const none = await run('get-order', { orderId: '  ' }, {});
  assert.deepEqual(none.result, { success: false, code: 'validation_failed', error: 'Say which order: orderId is required' });
  assert.deepEqual(none.calls, []);

  const other = await run('get-order', { orderId: 'o9' }, { 'valuguru.commerce.orders.get': guruError('not_found', 'No such order') });
  assert.deepEqual(other.result, { success: false, code: 'not_found', error: 'No such order' });
});

const PRODUCT_DETAIL = {
  id: 'p1',
  title: 'Course',
  owned: false,
  children: [{ id: 'c1', title: 'Child product' }],
  items: [
    { id: 'f1', item_type: 'folder', title: 'Unit 1', sort_order: 0, resource_id: null },
    {
      id: 'r1', item_type: 'resource', parent_item_id: 'f1', resource_id: 'res-secret', vault_resource_id: 'vault-secret',
      resource_kind: 'file', title: 'Lesson', resource_meta: { contentType: 'video/mp4', fileSize: 12 }, sort_order: 0,
    },
    { id: 'i3', item_type: 'product', child_product_id: 'c1', title: '', sort_order: 1 },
  ],
};

test('get-product stamps appId, withholds the paid files\' ids from a browser, and adds the contents tree', async () => {
  const { result, calls } = await run(
    'get-product', { productId: 'p1', appId: 'evil' },
    { 'valuguru.commerce.catalog.get': PRODUCT_DETAIL },
  );
  assert.deepEqual(calls[0].params, { productId: 'p1', appId: APP });
  assert.equal(result.id, 'p1');
  assert.deepEqual(result.children, PRODUCT_DETAIL.children);
  assert.deepEqual(result.items.map((i) => [i.id, i.resource_id, i.vault_resource_id]), [
    ['f1', null, null], ['r1', null, null], ['i3', null, null],
  ]);
  assert.deepEqual(result.contents, [
    {
      type: 'folder',
      title: 'Unit 1',
      items: [{ type: 'file', resourceId: null, title: 'Lesson', kind: 'file', contentType: 'video/mp4', fileSize: 12 }],
    },
    { type: 'product', productId: 'c1', title: 'Child product' },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /res-secret|vault-secret/);
  assert.equal(PRODUCT_DETAIL.items[1].resource_id, 'res-secret', 'the answer from the wire is not mutated');
});

test('get-product keeps the file ids for an owner and for the seller', async () => {
  for (const flag of ['owned', 'isOwnProduct']) {
    const { result } = await run('get-product', { productId: 'p1' }, {
      'valuguru.commerce.catalog.get': { ...PRODUCT_DETAIL, [flag]: true },
    });
    assert.equal(result.items[1].resource_id, 'res-secret', flag);
    assert.equal(result.contents[0].items[0].resourceId, 'res-secret', flag);
  }
});

test('get-product with no item list answers the product as it came', async () => {
  const { result } = await run('get-product', { productId: 'p1' }, { 'valuguru.commerce.catalog.get': { id: 'p1', title: 'T' } });
  assert.deepEqual(result, { id: 'p1', title: 'T' });
});

test('get-purchase-contents answers the bought tree with the buyer\'s own copies', async () => {
  const { result, calls } = await run('get-purchase-contents', { productId: 'p1' }, {
    'valuguru.commerce.purchases.tree': {
      title: 'Course', deletedBySeller: 0, version: { id: 'v1' }, seenResourceIds: ['res-1'], children: [{ id: 'c1', title: 'Part' }],
      items: [
        {
          id: 'r1', item_type: 'resource', resource_id: 'res-1', delivered_resource_id: 'del-1', resource_kind: 'file',
          title: 'Lesson 1', resource_meta: { contentType: 'application/pdf', fileSize: 99 }, sort_order: 0,
        },
        { id: 'i2', item_type: 'product', child_product_id: 'c1', title: '', sort_order: 1 },
      ],
    },
  });
  assert.deepEqual(calls.map((c) => [c.op, c.params]), [['valuguru.commerce.purchases.tree', { productId: 'p1' }]]);
  assert.deepEqual(result, {
    productId: 'p1',
    title: 'Course',
    deletedBySeller: false,
    contents: [
      {
        type: 'file', resourceId: 'res-1', title: 'Lesson 1', kind: 'file', contentType: 'application/pdf', fileSize: 99,
        deliveredResourceId: 'del-1',
      },
      { type: 'product', productId: 'c1', title: 'Part' },
    ],
  });
});

test('get-purchase-contents: not owned is not_owned, a missing id is refused, other refusals pass', async () => {
  const stranger = await run('get-purchase-contents', { productId: 'p1' }, {
    'valuguru.commerce.purchases.tree': guruError('forbidden', 'not yours'),
  });
  assert.deepEqual(stranger.result, { success: false, code: 'not_owned', error: 'The user does not own this product' });

  const none = await run('get-purchase-contents', {}, {});
  assert.deepEqual(none.result, { success: false, code: 'validation_failed', error: 'Say which purchase: productId is required' });
  assert.deepEqual(none.calls, []);

  const other = await run('get-purchase-contents', { productId: 'p1' }, {
    'valuguru.commerce.purchases.tree': guruError('not_found', 'gone'),
  });
  assert.deepEqual(other.result, { success: false, code: 'not_found', error: 'gone' });
});

test('list-categories answers {categories}', async () => {
  const { result, calls } = await run('list-categories', {}, {
    'valuguru.commerce.catalog.categories': { categories: [{ id: 'books', label: 'Books' }, { id: 'other', label: 'Other' }] },
  });
  assert.deepEqual(calls[0].params, {});
  assert.deepEqual(result, { categories: [{ id: 'books', label: 'Books' }, { id: 'other', label: 'Other' }] });
});

const orderRow = (id, created) => ({ id, status: 'paid', created_at: created, total_vrsc: '1' });
const LIST_ORDERS = {
  orders: [orderRow('o1', '2026-10-01T00:00:00Z'), orderRow('o2', '2026-10-03T00:00:00Z'), orderRow('o3', '2026-10-02T00:00:00Z')],
  lines: [
    { id: 'l1', order_id: 'o1', role: 'item', app_id: APP, product_id: 'p1', title_snapshot: 'Mine' },
    { id: 'l2', order_id: 'o2', role: 'item', app_id: 'other', product_id: 'p2', title_snapshot: 'Theirs' },
    { id: 'l3', order_id: 'o3', role: 'component', app_id: APP, product_id: 'p3', title_snapshot: 'Part of theirs' },
  ],
  adjustments: [], payouts: [], payments: [],
};

test('list-orders answers every order newest first, in the receipt shape', async () => {
  const { result, calls } = await run('list-orders', { status: 'paid', limit: 5 }, { 'valuguru.commerce.orders.list': LIST_ORDERS });
  assert.deepEqual(calls[0].params, { status: 'paid', limit: 5 });
  assert.deepEqual(result.orders.map((o) => o.id), ['o2', 'o3', 'o1']);
  assert.deepEqual(result.orders[2].items, [{
    productId: 'p1', appId: APP, title: 'Mine', qty: 1, unitPriceVrsc: null, lineTotalVrsc: null, imageResourceId: null,
    deletedBySeller: false, parts: [], bundleFeeVrsc: null,
  }]);
});

test('list-orders with thisAppOnly keeps an order only when one of its ITEMS is the calling app\'s', async () => {
  const { result } = await run('list-orders', { thisAppOnly: true }, { 'valuguru.commerce.orders.list': LIST_ORDERS });
  assert.deepEqual(result.orders.map((o) => o.id), ['o1']);
});

test('list-orders: a status that is not one is refused without a round trip; no params sends none', async () => {
  const bad = await run('list-orders', { status: 'refunded' }, {});
  assert.equal(bad.result.code, 'validation_failed');
  assert.match(bad.result.error, /pending_payment, paid, expired, cancelled, failed/);
  assert.deepEqual(bad.calls, []);

  const bare = await run('list-orders', {}, { 'valuguru.commerce.orders.list': {} });
  assert.deepEqual(bare.calls[0].params, {});
  assert.deepEqual(bare.result, { orders: [] });
});

test('list-orders names an owned part from the purchases, for the orders that are kept only', async () => {
  const { result, ops } = await run('list-orders', {}, {
    'valuguru.commerce.orders.list': {
      ...LIST_ORDERS,
      adjustments: [{ order_id: 'o1', kind: 'excluded_owned', product_id: 'p9', amount_vrsc: '2' }],
    },
    'valuguru.commerce.purchases.list': { products: [{ productId: 'p9', title: 'Owned part' }] },
  });
  assert.deepEqual(ops, ['valuguru.commerce.orders.list', 'valuguru.commerce.purchases.list']);
  assert.deepEqual(result.orders.find((o) => o.id === 'o1').notCharged, [{ productId: 'p9', title: 'Owned part', amountVrsc: 2 }]);
});

test('list-purchases answers what the user owns, picking fields', async () => {
  const row = {
    productId: 'p1', title: 'Course', imageResourceId: 'img-1', grantedAt: '2026-10-01T00:00:00Z', orderId: 'o1', appId: 'app-2',
    role: 'component', deliveryStatus: 'delivered', deliveredResourceId: 'd1', deletedBySeller: false,
    myScore: 5, myReview: 'great', entitlementId: 'ent-secret',
  };
  const { result, calls } = await run('list-purchases', {}, { 'valuguru.commerce.purchases.list': { products: [row] } });
  assert.deepEqual(calls[0].params, {}, 'every purchase, wherever it was bought');
  assert.deepEqual(result, {
    purchases: [{
      productId: 'p1', title: 'Course', coverResourceId: 'img-1', purchasedAt: '2026-10-01T00:00:00Z', orderId: 'o1',
      boughtInAppId: 'app-2', isBundlePart: true, delivered: true, deletedBySeller: false,
    }],
  });
});

test('list-purchases with thisAppOnly asks for this app\'s purchases, by the stamp', async () => {
  const { result, calls } = await run('list-purchases', { thisAppOnly: true, appId: 'evil' }, { 'valuguru.commerce.purchases.list': { products: [] } });
  assert.deepEqual(calls[0].params, { appId: APP });
  assert.deepEqual(result, { purchases: [] });

  const loose = await run('list-purchases', { thisAppOnly: 'yes' }, { 'valuguru.commerce.purchases.list': { products: [] } });
  assert.deepEqual(loose.calls[0].params, {}, 'only the boolean true narrows it');
});

test('list-purchases: delivered needs the copy to exist, and a thin row gets defaults', async () => {
  const { result } = await run('list-purchases', {}, {
    'valuguru.commerce.purchases.list': {
      products: [{ productId: 'p1', deliveryStatus: 'delivered' }, { productId: 'p2', deliveryStatus: 'pending', deliveredResourceId: 'd' }],
    },
  });
  assert.deepEqual(result.purchases.map((p) => [p.productId, p.title, p.delivered, p.isBundlePart, p.coverResourceId, p.orderId]), [
    ['p1', '', false, false, null, null], ['p2', '', false, false, null, null],
  ]);
});

test('preview-promo scopes the code to the calling app, upper-cases it, and answers what it would do', async () => {
  const { result, calls } = await run('preview-promo', { code: ' save10 ', scope: 'all', appId: 'evil' }, {
    'valuguru.commerce.orders.previewPromo': {
      verdict: { ok: true },
      adjustments: [
        { kind: 'discount_code', label: 'SAVE10', amountVrsc: '1' },
        { kind: 'excluded_owned', amount_vrsc: 3 },
        { kind: 'volume_tier', amount_vrsc: '0.5' },
      ],
      subtotalVrsc: '10',
      totalVrsc: '8.5',
    },
  });
  assert.deepEqual(calls[0].params, { scope: APP, code: 'SAVE10' });
  assert.deepEqual(result, {
    valid: true,
    reason: null,
    discounts: [
      { kind: 'discount_code', label: 'SAVE10', amountVrsc: 1 },
      { kind: 'volume_tier', label: 'volume_tier', amountVrsc: 0.5 },
    ],
    subtotalVrsc: 10,
    totalVrsc: 8.5,
  });
});

test('preview-promo: a code that takes nothing off is not_applicable; a refused one carries the server\'s reason', async () => {
  const under = await run('preview-promo', { code: 'MIN50' }, {
    'valuguru.commerce.orders.previewPromo': { verdict: { ok: true }, adjustments: [], subtotalVrsc: 4, totalVrsc: 4 },
  });
  assert.equal(under.result.valid, false);
  assert.equal(under.result.reason, 'not_applicable');

  const expired = await run('preview-promo', { code: 'OLD' }, {
    'valuguru.commerce.orders.previewPromo': { verdict: { ok: false, reason: 'promo_expired' }, adjustments: [], subtotalVrsc: 4, totalVrsc: 4 },
  });
  assert.equal(expired.result.reason, 'promo_expired');

  const blank = await run('preview-promo', { code: '  ' }, {});
  assert.deepEqual(blank.result, { success: false, code: 'validation_failed', error: 'Give the code to check' });
  assert.deepEqual(blank.calls, []);
});

// ---------------------------------------------------------------------------
// Buyer writes (commerce:write) — an app changes only its own rows
// ---------------------------------------------------------------------------

const CART = [
  { id: 'a', appId: APP, qty: 1 },
  { id: 'b', appId: 'other', qty: 1 },
  { id: 'c', appId: APP, qty: 1, savedForLater: true },
];

test('update-cart-item changes one of the app\'s own rows and answers the whole cart', async () => {
  const after = [{ id: 'a', appId: APP, qty: 3, selected: false }, CART[1], CART[2]];
  const { result, calls } = await run('update-cart-item', { itemId: 'a', qty: 3.9, selected: false, appId: 'evil' }, {
    'valuguru.commerce.cart.get': { items: CART },
    'valuguru.commerce.cart.update': { items: after },
  });
  assert.deepEqual(calls.map((c) => [c.op, c.params]), [
    ['valuguru.commerce.cart.get', {}],
    ['valuguru.commerce.cart.update', { itemId: 'a', qty: 3, selected: false }],
  ]);
  assert.deepEqual(result, { success: true, items: after, count: 2 });
});

test('update-cart-item refuses another app\'s row, a missing row and nonsense, before any write', async () => {
  const script = { 'valuguru.commerce.cart.get': { items: CART }, 'valuguru.commerce.cart.update': { items: [] } };

  const theirs = await run('update-cart-item', { itemId: 'b', qty: 2 }, script);
  assert.equal(theirs.result.code, 'not_yours');
  assert.deepEqual(theirs.ops, ['valuguru.commerce.cart.get']);

  const gone = await run('update-cart-item', { itemId: 'zzz', qty: 2 }, script);
  assert.equal(gone.result.code, 'not_found');

  const noId = await run('update-cart-item', { qty: 2 }, script);
  assert.equal(noId.result.code, 'validation_failed');

  for (const params of [{ itemId: 'a', qty: 0 }, { itemId: 'a', qty: '2' }, { itemId: 'a', selected: 'yes' }, { itemId: 'a' }]) {
    const bad = await run('update-cart-item', params, script);
    assert.equal(bad.result.code, 'validation_failed', JSON.stringify(params));
    assert.deepEqual(bad.calls, [], 'nonsense never becomes a round trip');
  }
});

test('remove-from-cart removes only the app\'s own row and answers the whole cart', async () => {
  const after = [CART[1], CART[2]];
  const { result, calls } = await run('remove-from-cart', { itemId: 'a' }, {
    'valuguru.commerce.cart.get': { items: CART },
    'valuguru.commerce.cart.remove': { items: after },
  });
  assert.deepEqual(calls.map((c) => [c.op, c.params]), [
    ['valuguru.commerce.cart.get', {}],
    ['valuguru.commerce.cart.remove', { itemId: 'a' }],
  ]);
  assert.deepEqual(result, { success: true, items: after, count: 1 });

  const theirs = await run('remove-from-cart', { itemId: 'b' }, { 'valuguru.commerce.cart.get': { items: CART } });
  assert.equal(theirs.result.code, 'not_yours');
  assert.deepEqual(theirs.ops, ['valuguru.commerce.cart.get'], 'nothing was removed');
});

test('clear-cart removes the app\'s own rows one at a time and never another app\'s', async () => {
  const remaining = [[CART[1], CART[2]], [CART[1]]];
  const { result, calls } = await run('clear-cart', { appId: 'evil' }, {
    'valuguru.commerce.cart.get': { items: CART },
    'valuguru.commerce.cart.remove': () => ({ items: remaining.shift() }),
  });
  assert.deepEqual(calls.map((c) => [c.op, c.params]), [
    ['valuguru.commerce.cart.get', {}],
    ['valuguru.commerce.cart.remove', { itemId: 'a' }],
    ['valuguru.commerce.cart.remove', { itemId: 'c' }],
  ]);
  assert.deepEqual(result, { success: true, items: [CART[1]], count: 1 });
});

test('clear-cart with nothing of the app\'s in the cart writes nothing', async () => {
  const { result, ops } = await run('clear-cart', {}, { 'valuguru.commerce.cart.get': { items: [CART[1]] } });
  assert.deepEqual(ops, ['valuguru.commerce.cart.get']);
  assert.deepEqual(result, { success: true, items: [CART[1]], count: 1 });
});

test('clear-cart: a row that is already gone is what was asked for; any other refusal stops the clear', async () => {
  let n = 0;
  const gone = await run('clear-cart', {}, {
    'valuguru.commerce.cart.get': { items: CART },
    'valuguru.commerce.cart.remove': () => {
      n += 1;
      if (n === 1) return guruError('not_found', 'already gone');
      return { items: [CART[1]] };
    },
  });
  assert.deepEqual(gone.result, { success: true, items: [CART[1]], count: 1 });

  const stopped = await run('clear-cart', {}, {
    'valuguru.commerce.cart.get': { items: CART },
    'valuguru.commerce.cart.remove': guruError('busy', 'try later'),
  });
  assert.deepEqual(stopped.result, { success: false, code: 'busy', error: 'try later' });
  assert.equal(stopped.ops.filter((op) => op.endsWith('cart.remove')).length, 1, 'it stopped at the refusal');
});

// ---------------------------------------------------------------------------
// Seller (commerce:sell)
// ---------------------------------------------------------------------------

const STORE_ROW = {
  id: 's1', name: 'Ada\'s store', description: null, status: 'active', payout_identity_name: 'ada@',
  donation_tiers: [{ minMembers: 0, percent: '1' }, { minMembers: 100, percent: 2 }], donation_updated_at: '2026-10-01', owner_user_id: 'secret',
};
const STORE_ANSWER = {
  id: 's1', name: 'Ada\'s store', description: null, status: 'active', payoutIdentityName: 'ada@',
  donationTiers: [{ minMembers: 0, percent: 1 }, { minMembers: 100, percent: 2 }], donationUpdatedAt: '2026-10-01',
};

test('get-my-store answers the store, whether the user can sell, and this network', async () => {
  const { result, calls } = await run('get-my-store', {}, {
    'valuguru.commerce.store.get': { store: STORE_ROW },
    'valuguru.commerce.network.memberCount': { memberCount: 150 },
    'valuguru.commerce.network.policy.get': {
      policy: { networkId: 'roomful', mode: 'open', allowedRatings: ['G'], displayCurrency: 'USD', secret: 1 },
    },
  }, { user: { id: 'u1', firstName: 'Ada', lastName: 'Lovelace', identityType: 2 }, networkId: 'ignored-when-policy-names-one' });

  assert.deepEqual(calls.map((c) => c.op).sort(), [
    'valuguru.commerce.network.memberCount', 'valuguru.commerce.network.policy.get', 'valuguru.commerce.store.get',
  ]);
  assert.deepEqual(result, {
    hasStore: true,
    identityVerified: true,
    sellerName: 'Ada Lovelace',
    sellerUserId: 'u1',
    store: STORE_ANSWER,
    network: { id: 'roomful', memberCount: 150, mode: 'open', allowedRatings: ['G'], displayCurrency: 'USD', donationTierIndex: 1 },
  });
});

test('get-my-store without a store, or without the network reads, says what it does not know', async () => {
  const { result } = await run('get-my-store', {}, {
    'valuguru.commerce.store.get': { store: null },
    'valuguru.commerce.network.memberCount': guruError('forbidden'),
    'valuguru.commerce.network.policy.get': guruError('forbidden'),
  }, { user: { id: 'u1', identityType: 1 }, networkId: 'roomful' });
  assert.deepEqual(result, {
    hasStore: false,
    identityVerified: false,
    sellerName: null,
    sellerUserId: 'u1',
    store: null,
    network: { id: 'roomful', memberCount: null, mode: null, allowedRatings: [], displayCurrency: null, donationTierIndex: null },
  });
});

test('get-my-store: the store read is the point, and its refusal is the answer', async () => {
  const { result } = await run('get-my-store', {}, {
    'valuguru.commerce.store.get': guruError('unauthorized', 'sign in'),
    'valuguru.commerce.network.memberCount': { memberCount: 1 },
    'valuguru.commerce.network.policy.get': { policy: null },
  }, { user: { id: 'u1' } });
  assert.deepEqual(result, { success: false, code: 'unauthorized', error: 'sign in' });
});

test('get-my-store and create-store refuse, before any op, when the host does not know the signed-in user', async () => {
  const script = {
    'valuguru.commerce.store.get': { store: STORE_ROW },
    'valuguru.commerce.store.create': { store: STORE_ROW },
  };
  for (const action of ['get-my-store', 'create-store']) {
    for (const options of [{}, { user: null }, { user: undefined, networkId: 'roomful' }]) {
      const { result, calls } = await run(action, { name: 'Mine' }, script, options);
      assert.deepEqual(result, { success: false, code: 'unsupported', error: 'signed-in user unknown' }, action);
      assert.deepEqual(calls, [], `${action} sent nothing`);
    }
  }
});

test('create-store opens the store under the owner\'s profile name when none is given', async () => {
  const { result, calls } = await run('create-store', { description: 'Books' }, {
    'valuguru.commerce.store.create': { store: STORE_ROW },
  }, { user: { firstName: ' Ada ', lastName: 'Lovelace' } });
  assert.deepEqual(calls[0].params, { name: 'Ada Lovelace', description: 'Books' });
  assert.deepEqual(result, { success: true, store: STORE_ANSWER });
});

test('create-store: a name is trimmed and checked; with no name and no profile name, the server decides', async () => {
  const user = { id: 'u1' };
  const named = await run('create-store', { name: '  Mine  ' }, { 'valuguru.commerce.store.create': { store: STORE_ROW } }, { user });
  assert.deepEqual(named.calls[0].params, { name: 'Mine' });

  const bare = await run('create-store', {}, { 'valuguru.commerce.store.create': { store: STORE_ROW } }, { user });
  assert.deepEqual(bare.calls[0].params, {});

  for (const params of [{ name: 5 }, { name: '   ' }, { name: 'x'.repeat(121) }, { name: 'ok', description: 5 }, { name: 'ok', description: 'x'.repeat(2001) }]) {
    const bad = await run('create-store', params, {}, { user });
    assert.equal(bad.result.code, 'validation_failed', JSON.stringify(params).slice(0, 40));
    assert.deepEqual(bad.calls, []);
  }

  const kyc = await run('create-store', {}, { 'valuguru.commerce.store.create': guruError('not_eligible_kyc', 'Verify your identity first') }, { user });
  assert.deepEqual(kyc.result, { success: false, code: 'not_eligible_kyc', error: 'Verify your identity first' });
});

test('list-network-access answers where the store stands in each network', async () => {
  const { result } = await run('list-network-access', {}, {
    'valuguru.commerce.store.networks.list': {
      networks: [{ network_id: 'n1', status: 'pending', requested_at: 'r', decided_at: null, note: null, message: 'hi', decided_by: 'secret' }],
    },
  });
  assert.deepEqual(result, {
    networks: [{ networkId: 'n1', status: 'pending', requestedAt: 'r', decidedAt: null, note: null, message: 'hi' }],
  });
});

test('request-network-access sends the network and message, and answers {success, request}', async () => {
  const { result, calls } = await run('request-network-access', { networkId: 'n1', message: 'please' }, {
    'valuguru.commerce.store.networks.request': { storeNetwork: { network_id: 'n1', status: 'pending', message: 'please' } },
  });
  assert.deepEqual(calls[0].params, { networkId: 'n1', message: 'please' });
  assert.deepEqual(result, {
    success: true,
    request: { networkId: 'n1', status: 'pending', requestedAt: null, decidedAt: null, note: null, message: 'please' },
  });

  for (const params of [{}, { networkId: 'n1', message: 5 }, { networkId: 'n1', message: 'x'.repeat(2001) }]) {
    const bad = await run('request-network-access', params, {});
    assert.equal(bad.result.code, 'validation_failed');
    assert.deepEqual(bad.calls, []);
  }
});

test('quote-bundle sends the parts and answers the server\'s quote as it is', async () => {
  const quote = { currency: 'VRSC', parts: [{ productId: 'p1', amount: 1 }], included: 1, own: 2, total: 3, duplicates: [], unavailable: [] };
  const { result, calls } = await run('quote-bundle', { productIds: ['p1'], priceCurrency: 'VRSC', ownPrice: '2' }, {
    'valuguru.commerce.products.quote': quote,
  });
  assert.deepEqual(calls[0].params, { productIds: ['p1'], priceCurrency: 'VRSC', ownPrice: 2 });
  assert.deepEqual(result, quote);

  for (const params of [{ productIds: 'p1' }, { productIds: [''] }, { productIds: ['p1'], ownPrice: -1 }, { productIds: ['p1'], priceCurrency: 'EUR' }]) {
    const bad = await run('quote-bundle', params, {});
    assert.equal(bad.result.code, 'validation_failed', JSON.stringify(params));
  }
});

const SALE_ROW = {
  id: 'sale1', store_id: 'st', product_id: 'p1', sale_price_amount: 1, sale_price_currency: 'VRSC', starts_at: null, ends_at: null,
  status: 'ended', created_at: 'c', updated_at: 'u',
};
const SALE = {
  id: 'sale1', storeId: 'st', productId: 'p1', salePriceAmount: 1, salePriceCurrency: 'VRSC', startsAt: null, endsAt: null,
  status: 'ended', createdAt: 'c', updatedAt: 'u',
};

test('list-promotions answers the sales, tiers and codes in the facade\'s camelCase', async () => {
  const { result } = await run('list-promotions', {}, {
    'valuguru.commerce.promotions.list': {
      sales: [SALE_ROW],
      tiers: [{ id: 't1', store_id: 'st', min_items: 3, percent_off: 10, status: 'active', created_at: 'c', updated_at: 'u' }],
      codes: [{
        id: 'c1', store_id: 'st', code: 'SAVE', kind: 'percent', value: 10, currency: null, min_subtotal_vrsc: 5, max_redemptions: 100,
        redeemed_count: 1, reserved_count: 0, per_buyer_limit: 1, starts_at: null, ends_at: null, status: 'active', created_at: 'c', updated_at: 'u',
      }],
    },
  });
  assert.deepEqual(result, {
    sales: [SALE],
    tiers: [{ id: 't1', storeId: 'st', minItems: 3, percentOff: 10, status: 'active', createdAt: 'c', updatedAt: 'u' }],
    codes: [{
      id: 'c1', storeId: 'st', code: 'SAVE', kind: 'percent', value: 10, currency: null, minSubtotalVrsc: 5, maxRedemptions: 100,
      redeemedCount: 1, reservedCount: 0, perBuyerLimit: 1, startsAt: null, endsAt: null, status: 'active', createdAt: 'c', updatedAt: 'u',
    }],
  });

  const empty = await run('list-promotions', {}, { 'valuguru.commerce.promotions.list': {} });
  assert.deepEqual(empty.result, { sales: [], tiers: [], codes: [] });
});

test('end-sale, remove-volume-tier and delete-discount-code are direct writes', async () => {
  const sale = await run('end-sale', { saleId: 'sale1' }, { 'valuguru.commerce.promotions.sale.end': { sale: SALE_ROW } });
  assert.deepEqual(sale.calls[0].params, { saleId: 'sale1' });
  assert.deepEqual(sale.result, { success: true, sale: SALE });

  const tier = await run('remove-volume-tier', { tierId: 't1' }, { 'valuguru.commerce.promotions.tier.remove': { ok: true } });
  assert.deepEqual(tier.calls[0].params, { tierId: 't1' });
  assert.deepEqual(tier.result, { success: true });

  const code = await run('delete-discount-code', { codeId: 'c1' }, { 'valuguru.commerce.promotions.code.delete': {} });
  assert.deepEqual(code.calls[0].params, { codeId: 'c1' });
  assert.deepEqual(code.result, { success: true });

  const used = await run('delete-discount-code', { codeId: 'c1' }, { 'valuguru.commerce.promotions.code.delete': guruError('conflict', 'It was used') });
  assert.deepEqual(used.result, { success: false, code: 'conflict', error: 'It was used' });

  for (const action of ['end-sale', 'remove-volume-tier', 'delete-discount-code']) {
    const bad = await run(action, {}, {});
    assert.equal(bad.result.code, 'validation_failed', action);
    assert.deepEqual(bad.calls, []);
  }
});

test('get-analytics sends the range and answers the server\'s numbers untouched', async () => {
  const numbers = { range: { from: 'a', to: 'b' }, totals: { orders: 0 }, series: [{ day: 'd', suppressed: true }], suppressedCells: 1 };
  const { result, calls } = await run('get-analytics', { from: '2026-10-01', to: '2026-10-20', testOnly: true }, {
    'valuguru.commerce.store.analytics': numbers,
  });
  assert.deepEqual(calls[0].params, { from: '2026-10-01', to: '2026-10-20', testOnly: true });
  assert.deepEqual(result, numbers);

  const plain = await run('get-analytics', { testOnly: 'yes' }, { 'valuguru.commerce.store.analytics': numbers });
  assert.deepEqual(plain.calls[0].params, {});

  const bad = await run('get-analytics', { from: 'yesterday' }, {});
  assert.equal(bad.result.code, 'validation_failed');
});

const PRODUCT_ROW = {
  id: 'p1', title: 'Course', description: 'About', status: 'draft', price_amount: '5', price_currency: 'USD', stock: 3, category: 'books',
  tags: ['a'], image_resource_id: 'img', content_count: 4, sold_count: 2, internal_column: 'secret',
};
const PRODUCT_FOR_EDIT = {
  id: 'p1', title: 'Course', description: 'About', status: 'draft', priceAmount: 5, priceCurrency: 'USD', stock: 3, category: 'books',
  tags: ['a'], imageResourceId: 'img', contentCount: 4, soldCount: 2, editable: true,
};

test('list-my-products answers the seller\'s own products in the shape update-product takes', async () => {
  const { result, calls } = await run('list-my-products', { status: 'draft', limit: 20 }, {
    'valuguru.commerce.products.list': { store: STORE_ROW, products: [PRODUCT_ROW, { id: 'p2', title: 'Live', status: 'active' }] },
  });
  assert.deepEqual(calls[0].params, { status: 'draft', limit: 20 });
  assert.deepEqual(result, {
    hasStore: true,
    products: [
      PRODUCT_FOR_EDIT,
      {
        id: 'p2', title: 'Live', description: null, status: 'active', priceAmount: 0, priceCurrency: 'VRSC', stock: null, category: null,
        tags: [], imageResourceId: null, editable: false,
      },
    ],
  });

  const none = await run('list-my-products', {}, { 'valuguru.commerce.products.list': { store: null, products: [] } });
  assert.deepEqual(none.calls[0].params, {});
  assert.deepEqual(none.result, { hasStore: false, products: [] });
});

test('list-seller-products answers the display shape, with the quoted total for a bundle', async () => {
  const { result } = await run('list-seller-products', {}, {
    'valuguru.commerce.products.list': {
      store: STORE_ROW,
      products: [
        {
          id: 'p1', title: 'Bundle', description: 'd', status: 'active', category: 'books', tags: ['a'], price_amount: '3', price_currency: 'VRSC',
          bundle_price: { total: '7', own: '1', currency: 'VRSC' }, included_count: 2, cover_resource_id: 'c1', image_resource_id: 'i1',
          stock: null, sold_count: 4, content_count: 6,
        },
        { id: 'p2', title: 'Unquoted bundle', status: 'draft', included_count: 1, image_resource_id: 'i2' },
        { id: 'p3', title: 'Plain', status: 'draft', price_amount: 2 },
      ],
    },
  });
  assert.deepEqual(result.products[0], {
    id: 'p1', title: 'Bundle', description: 'd', status: 'active', category: 'books', tags: ['a'], priceAmount: 3, priceCurrency: 'VRSC',
    totalPriceAmount: 7, isBundle: true, coverResourceId: 'c1', stock: null, soldCount: 4, contentCount: 6,
  });
  assert.equal(result.products[1].totalPriceAmount, null, 'an unquoted bundle is not "free"');
  assert.equal(result.products[1].coverResourceId, 'i2');
  assert.equal(result.products[2].totalPriceAmount, 2);
  assert.equal(result.products[2].isBundle, false);
  assert.equal(result.hasStore, true);

  const none = await run('list-seller-products', {}, { 'valuguru.commerce.products.list': { store: null } });
  assert.deepEqual(none.result, { hasStore: false, products: [] });
});

test('get-my-product answers {product, items} with the content as a tree update-product takes back', async () => {
  const { result, calls } = await run('get-my-product', { productId: 'p1' }, {
    'valuguru.commerce.products.get': { product: PRODUCT_ROW },
    'valuguru.commerce.products.items.get': {
      version: null,
      items: [
        { id: 'f1', item_type: 'folder', title: 'Unit', sort_order: 0 },
        { id: 'r2', item_type: 'resource', parent_item_id: 'f1', resource_id: 'res2', resource_kind: 'file', title: 'Two', sort_order: 1 },
        { id: 'r1', item_type: 'resource', parent_item_id: 'f1', resource_id: 'res1', resource_kind: 'link', sort_order: 0 },
        { id: 'p', item_type: 'product', child_product_id: 'c9', title: 'Inside', sort_order: 1 },
        { id: 'r3', item_type: 'resource', resource_id: 'res3', resource_kind: 'file', sort_order: 2 },
      ],
    },
  });
  assert.deepEqual(calls.map((c) => [c.op, c.params]).sort(), [
    ['valuguru.commerce.products.get', { productId: 'p1' }],
    ['valuguru.commerce.products.items.get', { productId: 'p1' }],
  ]);
  assert.deepEqual(result, {
    product: PRODUCT_FOR_EDIT,
    items: [
      { folder: 'Unit', items: [{ resourceId: 'res1', kind: 'link' }, { resourceId: 'res2', title: 'Two' }] },
      { productId: 'c9', title: 'Inside' },
      { resourceId: 'res3' },
    ],
  });
});

test('get-my-product: a product the server does not return is not_found', async () => {
  const { result } = await run('get-my-product', { productId: 'p1' }, {
    'valuguru.commerce.products.get': {},
    'valuguru.commerce.products.items.get': { items: [] },
  });
  assert.equal(result.code, 'not_found');
});

// ---- create-product and update-product -----------------------------------------

test('create-product with a title makes a draft from the fields, and only those fields', async () => {
  const { result, calls } = await run(
    'create-product',
    { title: 'Course', description: 'About', priceAmount: 5, priceCurrency: 'USD', category: 'books', tags: ['a'], imageResourceId: 'img', stock: 3, appId: 'evil', status: 'active', storeId: 'x' },
    { 'valuguru.commerce.products.create': { product: { id: 'p1', status: 'draft' } } },
  );
  assert.deepEqual(calls.map((c) => [c.op, c.params]), [[
    'valuguru.commerce.products.create',
    { title: 'Course', description: 'About', priceAmount: 5, priceCurrency: 'USD', category: 'books', tags: ['a'], imageResourceId: 'img', stock: 3 },
  ]]);
  assert.deepEqual(result, { success: true, product: { id: 'p1', status: 'draft' } });
});

test('create-product sets the content in the order the server walks it, from the intent\'s description', async () => {
  const { result, calls } = await run(
    'create-product',
    { title: 'Course', items: ['res1', { folder: 'Unit', items: [{ resourceId: 'res2', title: 'Two', kind: 'link' }] }, { productId: 'p9' }, 5] },
    {
      'valuguru.commerce.products.create': { product: { id: 'p1' } },
      'valuguru.commerce.products.items.set': { ok: true },
    },
  );
  assert.deepEqual(calls[1], {
    op: 'valuguru.commerce.products.items.set',
    params: {
      productId: 'p1',
      items: [
        { ref: 'i1', type: 'resource', parentRef: null, resourceId: 'res1', resourceKind: 'file' },
        { ref: 'i2', type: 'folder', parentRef: null, title: 'Unit' },
        { ref: 'i3', type: 'resource', parentRef: 'i2', resourceId: 'res2', resourceKind: 'link', title: 'Two' },
        { ref: 'i4', type: 'product', parentRef: null, childProductId: 'p9' },
      ],
    },
    opts: undefined,
  });
  assert.deepEqual(result, { success: true, product: { id: 'p1' } });
});

test('create-product: a price on a bundle becomes the curator fee on top of its parts', async () => {
  const { calls } = await run(
    'create-product',
    { title: 'Bundle', priceAmount: 5, items: [{ productId: 'p9' }] },
    { 'valuguru.commerce.products.create': { product: { id: 'p1' } }, 'valuguru.commerce.products.items.set': {} },
  );
  assert.deepEqual(calls[0].params, { title: 'Bundle', priceAmount: 0, curatorFeeType: 'fixed', curatorFeeValue: 5 });

  const free = await run(
    'create-product',
    { title: 'Bundle', priceAmount: 0, items: [{ productId: 'p9' }] },
    { 'valuguru.commerce.products.create': { product: { id: 'p1' } }, 'valuguru.commerce.products.items.set': {} },
  );
  assert.deepEqual(free.calls[0].params, { title: 'Bundle', priceAmount: 0, curatorFeeType: null, curatorFeeValue: null });
});

test('create-product without a title would open a form, which the host has no screen for', async () => {
  for (const params of [{}, { title: '   ' }, { title: 5 }, { description: 'only' }]) {
    const { result, calls } = await run('create-product', params, {});
    assert.equal(result.success, false);
    assert.equal(result.product, null, 'the docs show product: null on a refusal');
    assert.equal(result.code, 'unsupported');
    assert.match(result.error, /title/);
    assert.deepEqual(calls, []);
  }
});

test('create-product: a server that answers without the product is not_found, and its content is not sent', async () => {
  for (const answer of [{}, null, { product: null }]) {
    const { result, ops } = await run('create-product', { title: 'T', items: ['res1'] }, {
      'valuguru.commerce.products.create': answer,
      'valuguru.commerce.products.items.set': {},
    });
    assert.equal(result.success, false);
    assert.equal(result.product, null);
    assert.equal(result.code, 'not_found');
    assert.equal(typeof result.error, 'string');
    assert.deepEqual(ops, ['valuguru.commerce.products.create'], 'nothing to put content in');
  }
});

test('create-product: a refusal names the draft when one was already made', async () => {
  const early = await run('create-product', { title: 'T' }, { 'valuguru.commerce.products.create': guruError('validation_failed', 'bad category') });
  assert.deepEqual(early.result, { success: false, product: null, code: 'validation_failed', error: 'bad category' });

  const late = await run('create-product', { title: 'T', items: ['res1'] }, {
    'valuguru.commerce.products.create': { product: { id: 'p1' } },
    'valuguru.commerce.products.items.set': guruError('forbidden', 'not your file'),
  });
  assert.deepEqual(late.result, { success: false, product: { id: 'p1' }, code: 'forbidden', error: 'not your file' });
});

test('update-product edits a draft: the fields given, then the content when given', async () => {
  const { result, calls } = await run(
    'update-product',
    { productId: ' p1 ', title: 'New', stock: 5, items: ['res1'], appId: 'evil', status: 'active' },
    {
      'valuguru.commerce.products.get': { product: { id: 'p1', status: 'draft' } },
      'valuguru.commerce.products.update': { product: PRODUCT_ROW },
      'valuguru.commerce.products.items.set': { ok: true },
    },
  );
  assert.deepEqual(calls.map((c) => [c.op, c.params]), [
    ['valuguru.commerce.products.get', { productId: 'p1' }],
    ['valuguru.commerce.products.update', { productId: 'p1', title: 'New', stock: 5 }],
    ['valuguru.commerce.products.items.set', { productId: 'p1', items: [{ ref: 'i1', type: 'resource', parentRef: null, resourceId: 'res1', resourceKind: 'file' }] }],
  ]);
  assert.deepEqual(result, { success: true, product: PRODUCT_FOR_EDIT });
});

test('update-product: unlimitedStock is a null stock, and content alone writes no fields', async () => {
  const unlimited = await run('update-product', { productId: 'p1', unlimitedStock: true }, {
    'valuguru.commerce.products.get': { product: { id: 'p1', status: 'draft' } },
    'valuguru.commerce.products.update': { product: PRODUCT_ROW },
  });
  assert.deepEqual(unlimited.calls[1].params, { productId: 'p1', stock: null });

  const contentOnly = await run('update-product', { productId: 'p1', items: ['res1'] }, {
    'valuguru.commerce.products.get': { product: { id: 'p1', status: 'draft', title: 'Kept' } },
    'valuguru.commerce.products.items.set': { ok: true },
  });
  assert.deepEqual(contentOnly.ops, ['valuguru.commerce.products.get', 'valuguru.commerce.products.items.set']);
  assert.equal(contentOnly.result.product.title, 'Kept');
});

test('update-product refuses what would never work, before any write', async () => {
  const draft = { 'valuguru.commerce.products.get': { product: { id: 'p1', status: 'draft' } } };

  const noId = await run('update-product', { title: 'x' }, draft);
  assert.deepEqual(noId.result, { success: false, code: 'validation_failed', error: 'productId is required' });
  assert.deepEqual(noId.calls, []);

  const nothing = await run('update-product', { productId: 'p1' }, draft);
  assert.deepEqual(nothing.result, { success: false, code: 'validation_failed', error: 'Nothing to update' });
  assert.deepEqual(nothing.calls, []);

  const empty = await run('update-product', { productId: 'p1', items: [] }, draft);
  assert.equal(empty.result.code, 'validation_failed');
  assert.match(empty.result.error, /no content/);
  assert.deepEqual(empty.calls, []);

  const live = await run('update-product', { productId: 'p1', title: 'x' }, { 'valuguru.commerce.products.get': { product: { id: 'p1', status: 'active' } } });
  assert.equal(live.result.code, 'not_editable');
  assert.match(live.result.error, /Unlist/);
  assert.deepEqual(live.ops, ['valuguru.commerce.products.get'], 'nothing was written');

  const archived = await run('update-product', { productId: 'p1', title: 'x' }, { 'valuguru.commerce.products.get': { product: { id: 'p1', status: 'archived' } } });
  assert.equal(archived.result.code, 'not_editable');

  const missing = await run('update-product', { productId: 'p1', title: 'x' }, { 'valuguru.commerce.products.get': {} });
  assert.equal(missing.result.code, 'not_editable');
});

test('update-product: a product that needs attention takes content only', async () => {
  const broken = { 'valuguru.commerce.products.get': { product: { id: 'p1', status: 'broken' } }, 'valuguru.commerce.products.items.set': {} };

  const fields = await run('update-product', { productId: 'p1', title: 'x', items: ['res1'] }, broken);
  assert.equal(fields.result.code, 'not_editable');
  assert.deepEqual(fields.ops, ['valuguru.commerce.products.get']);

  const content = await run('update-product', { productId: 'p1', items: ['res1'] }, broken);
  assert.equal(content.result.success, true);
  assert.deepEqual(content.ops, ['valuguru.commerce.products.get', 'valuguru.commerce.products.items.set']);
});

test('update-product: a price on a bundle becomes the curator fee, judged from the content sent or the draft\'s own', async () => {
  const draft = { 'valuguru.commerce.products.get': { product: { id: 'p1', status: 'draft' } }, 'valuguru.commerce.products.update': { product: PRODUCT_ROW } };

  const sent = await run('update-product', { productId: 'p1', priceAmount: 4, items: [{ productId: 'p9' }] }, { ...draft, 'valuguru.commerce.products.items.set': {} });
  assert.deepEqual(sent.calls[1].params, { productId: 'p1', priceAmount: 0, curatorFeeType: 'fixed', curatorFeeValue: 4 });

  const stored = await run('update-product', { productId: 'p1', priceAmount: 4 }, {
    ...draft,
    'valuguru.commerce.products.items.get': { items: [{ item_type: 'product', child_product_id: 'p9' }] },
  });
  assert.deepEqual(stored.ops, ['valuguru.commerce.products.get', 'valuguru.commerce.products.items.get', 'valuguru.commerce.products.update']);
  assert.deepEqual(stored.calls[2].params, { productId: 'p1', priceAmount: 0, curatorFeeType: 'fixed', curatorFeeValue: 4 });

  const plain = await run('update-product', { productId: 'p1', priceAmount: 4 }, {
    ...draft,
    'valuguru.commerce.products.items.get': { items: [{ item_type: 'resource', resource_id: 'r' }] },
  });
  assert.deepEqual(plain.calls[2].params, { productId: 'p1', priceAmount: 4 });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const ALL = new Set(COMMERCE_APP_EVENTS);
const NETWORK = 'roomful';

test('COMMERCE_APP_EVENTS holds the seven app event names, frozen', () => {
  assert.deepEqual([...COMMERCE_APP_EVENTS], [
    'cart-updated', 'order-updated', 'delivery-updated', 'catalogue-updated',
    'seller-product-updated', 'seller-store-updated', 'seller-promotions-updated',
  ]);
  assert.ok(Object.isFrozen(COMMERCE_APP_EVENTS));
});

test('mapCommerceEvent drops order-updated for other apps and catalogue-updated for other networks', () => {
  const order = { event: 'commerce.order.updated', orderId: 'o1', status: 'paid', appIds: ['app-1', 'app-2'] };
  assert.deepEqual(
    mapCommerceEvent(order, { appId: 'app-1', networkId: NETWORK, subscribed: ALL }),
    { event: 'order-updated', data: { orderId: 'o1', status: 'paid' } },
    'an app named in the frame hears it, without the list of the other apps',
  );
  assert.equal(mapCommerceEvent(order, { appId: 'app-3', networkId: NETWORK, subscribed: ALL }), null);
  assert.equal(mapCommerceEvent({ ...order, appIds: undefined }, { appId: 'app-1', networkId: NETWORK, subscribed: ALL }), null, 'no list reaches nobody');
  assert.equal(mapCommerceEvent({ ...order, appIds: 'app-1' }, { appId: 'app-1', networkId: NETWORK, subscribed: ALL }), null);

  const shelf = { event: 'commerce.catalogue.updated', productId: 'p1', change: 'updated', networkId: NETWORK };
  assert.deepEqual(
    mapCommerceEvent(shelf, { appId: 'app-1', networkId: NETWORK, subscribed: ALL }),
    { event: 'catalogue-updated', data: { productId: 'p1', change: 'updated' } },
  );
  assert.equal(mapCommerceEvent({ ...shelf, networkId: 'other-net' }, { appId: 'app-1', networkId: NETWORK, subscribed: ALL }), null);
});

test('a catalogue frame that names no network, or a host that knows none, is passed on', () => {
  const shelf = { event: 'commerce.catalogue.updated', productId: null, change: 'reindexed' };
  assert.deepEqual(
    mapCommerceEvent(shelf, { appId: 'app-1', networkId: NETWORK, subscribed: ALL }),
    { event: 'catalogue-updated', data: { productId: null, change: 'reindexed' } },
  );
  assert.deepEqual(
    mapCommerceEvent({ ...shelf, networkId: 'n9' }, { appId: 'app-1', networkId: null, subscribed: ALL }),
    { event: 'catalogue-updated', data: { productId: null, change: 'reindexed' } },
  );
});

test('delivery-updated goes only to the apps in the order, like order-updated', () => {
  const frame = { event: 'commerce.delivery.updated', orderId: 'o1', status: 'delivered', appIds: ['app-2'] };
  assert.equal(mapCommerceEvent(frame, { appId: 'app-1', networkId: NETWORK, subscribed: ALL }), null);
  assert.deepEqual(
    mapCommerceEvent(frame, { appId: 'app-2', networkId: NETWORK, subscribed: ALL }),
    { event: 'delivery-updated', data: { orderId: 'o1', status: 'delivered' } },
  );
});

test('the seller events go to every subscriber, saying what changed and never the state', () => {
  const ctx = { appId: 'app-1', networkId: NETWORK, subscribed: ALL };
  assert.deepEqual(
    mapCommerceEvent({ event: 'commerce.product.updated', productId: 'p1', change: 'published', secret: 1 }, ctx),
    { event: 'seller-product-updated', data: { productId: 'p1', change: 'published' } },
  );
  assert.deepEqual(
    mapCommerceEvent({ event: 'commerce.store.updated', change: 'donation', networkId: 'n2' }, ctx),
    { event: 'seller-store-updated', data: { change: 'donation', networkId: 'n2' } },
  );
  assert.deepEqual(
    mapCommerceEvent({ event: 'commerce.store.updated', change: 'created' }, ctx),
    { event: 'seller-store-updated', data: { change: 'created' } },
  );
  assert.deepEqual(
    mapCommerceEvent({ event: 'commerce.promotions.updated', change: 'code' }, ctx),
    { event: 'seller-promotions-updated', data: { change: 'code' } },
  );
  assert.deepEqual(
    mapCommerceEvent({ event: 'commerce.product.updated' }, ctx),
    { event: 'seller-product-updated', data: { productId: null, change: null } },
  );
});

test('mapCommerceEvent returns null for an event the app did not subscribe to', () => {
  const frame = { event: 'commerce.product.updated', productId: 'p1', change: 'published' };
  assert.equal(mapCommerceEvent(frame, { appId: 'app-1', networkId: NETWORK, subscribed: new Set(['order-updated']) }), null);
  assert.equal(mapCommerceEvent(frame, { appId: 'app-1', networkId: NETWORK, subscribed: new Set() }), null);
  assert.equal(mapCommerceEvent(frame, { appId: 'app-1', networkId: NETWORK, subscribed: undefined }), null);
  assert.deepEqual(
    mapCommerceEvent(frame, { appId: 'app-1', networkId: NETWORK, subscribed: ['seller-product-updated'] }),
    { event: 'seller-product-updated', data: { productId: 'p1', change: 'published' } },
    'a list of names works as a set',
  );
});

test('frames that map to nothing are dropped: cart (the caller\'s), moderation, listing, unknown and malformed', () => {
  const ctx = { appId: 'app-1', networkId: NETWORK, subscribed: ALL };
  for (const frame of [
    { event: 'commerce.cart.updated' }, { event: 'commerce.moderation.updated' }, { event: 'commerce.listing.updated' },
    { event: 'commerce.nope' }, { event: 'constructor' }, { event: '__proto__' }, {}, null, undefined, 'commerce.order.updated', 5,
  ]) {
    assert.equal(mapCommerceEvent(frame, ctx), null, JSON.stringify(frame));
  }
});
