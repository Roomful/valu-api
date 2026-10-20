// ===========================================================================
// The Commerce data intents the host serves (spec §4.6, §4.7).
//
// Valu Social serves 30 `valu-guru` Commerce intents to its embedded apps, each
// one a `valuguru.commerce.*` op on the Valu Guru socket. The host serves the
// same 30 to a dedicated app, over its own Guru socket, and answers in the
// shapes Valu Social documents (docs/api-pointers.md). This file is that
// mapping and nothing else: intent -> op -> params, and the op's data -> the
// answer. It is ported from Valu Social's `CommerceDataService.js`,
// `intents/buyerIntents.js`, `intents/sellerIntents.js`, `CommerceService.js`
// and the `*ForIntent.js` shapers beside them, and keeps their rules:
//
//   - `appId` is the host's stamp (`ctx.appId`) and is NEVER read from the
//     app's params; a params `appId` (or `scope`) is ignored.
//   - An app WRITES only its own cart rows. The server cannot tell: a cart
//     write carries no app, so the rows are read first and the write refused
//     (`not_yours`, `not_found`) before it is sent.
//   - Orders, purchases, stores and the seller's products are PICKED field by
//     field, never spread, so a column the server adds to a row does not reach
//     an app (an order row carries its payment links; an app that held them
//     could draw the code itself). The catalogue, the cart, analytics and
//     bundle quotes are the server's own public shapes and pass as they come.
//   - A refusal is an answer, `{ success:false, code, error }`, never a throw.
//
// Not here, on purpose: the UI intents (open-cart, checkout, rate-product,
// publish/unlist/archive/delete-product, the sale / tier / code / donation
// writes that wait for a dialog), subscribe-events (the bridge's), and every op
// an app must never reach (api keys, payment simulation, orders.create, the
// network moderation writes, admin). `get-my-store` does read two network
// facts (`network.memberCount`, `network.policy.get`) for the `network` block
// of its answer. `create-product` without a title would open Valu Social's
// form, which the host has no screen for: it answers `unsupported`.
//
// Entries of `COMMERCE_INTENTS`:
//   { op, scope, timeoutMs?, toParams(params, ctx), fromResult(data, params, ctx) }
// is one op: `toParams` builds its params (it may be async, to read before it
// writes), `fromResult` shapes its data into the answer (it may be async, to
// read what the answer needs besides). `op` names the op that does the work.
// A few intents are several writes with no one op to hang that on; they carry
// `run(params, ctx)` instead. `ctx` is `{ appId, user, networkId,
// idempotencyKey(), request(op, params, opts?) }`. Timeouts default to the Guru
// client's (10 s); `timeoutMs` is for an op that needs more, and none of the 30
// does (checkout and publish, which do, are not data intents).
//
// Nothing here touches the DOM or logs.
// ===========================================================================

// ---------------------------------------------------------------------------
// Events (commerceEvents.js)
// ---------------------------------------------------------------------------

/** Every event an app can subscribe to, in the order an answer lists them. */
export const COMMERCE_APP_EVENTS = Object.freeze([
  'cart-updated',
  'order-updated',
  'delivery-updated',
  'catalogue-updated',
  'seller-product-updated',
  'seller-store-updated',
  'seller-promotions-updated',
]);

/** The apps an order frame is about. No list, or not a list: nobody. */
const appsInOrder = (frame) => new Set(Array.isArray(frame.appIds) ? frame.appIds : []);

/**
 * A Guru `commerce_event` frame -> what a subscribed app is told, and (when not
 * every subscriber may hear it) which apps may. A Map, so a frame named after
 * something on Object.prototype maps to nothing. Absent on purpose:
 * `commerce.cart.updated` (the caller reads the count it announces and emits
 * `cart-updated`), `commerce.moderation.updated` (the server sends
 * `store.updated` beside it) and `commerce.listing.updated` (`product.updated`
 * says the same thing better).
 */
const FROM_FRAME = new Map([
  ['commerce.order.updated', (frame) => ({
    event: 'order-updated',
    data: { orderId: frame.orderId ?? null, status: frame.status ?? null },
    onlyTo: appsInOrder(frame),
  })],
  ['commerce.delivery.updated', (frame) => ({
    event: 'delivery-updated',
    data: { orderId: frame.orderId ?? null, status: frame.status ?? null },
    onlyTo: appsInOrder(frame),
  })],
  // A null product is "re-read the whole shelf".
  ['commerce.catalogue.updated', (frame) => ({
    event: 'catalogue-updated',
    data: { productId: frame.productId ?? null, change: frame.change ?? null },
  })],
  // The seller's own store, which `list-seller-products` already shows any app
  // the signed-in user opens: nothing here another app could not read.
  ['commerce.product.updated', (frame) => ({
    event: 'seller-product-updated',
    data: { productId: frame.productId ?? null, change: frame.change ?? null },
  })],
  ['commerce.store.updated', (frame) => ({
    event: 'seller-store-updated',
    data: { change: frame.change ?? null, ...(frame.networkId != null ? { networkId: frame.networkId } : {}) },
  })],
  ['commerce.promotions.updated', (frame) => ({
    event: 'seller-promotions-updated',
    data: { change: frame.change ?? null },
  })],
]);

/**
 * What a frame means to one app: `{ event, data }`, or `null` when the app is
 * not to hear it.
 *
 * - an order or delivery frame goes only to the apps it names in `appIds` (the
 *   apps with an item in that order). A frame that names none reaches nobody,
 *   and the list itself is never passed on: it names the other apps the buyer
 *   bought from.
 * - a catalogue frame is dropped when it names a network and this is not it. A
 *   frame that names none, or a host that does not know its network yet, is
 *   passed on: a missed shelf event costs a stale screen, a wrong drop is silent.
 * - the app hears only the names it subscribed to.
 * - `cart-updated` is not mapped: the caller reads the count and emits it.
 *
 * @param {object} frame the raw `commerce_event` frame (`frame.event` is `commerce.*`).
 * @param {{ appId: string, networkId?: string|null, subscribed?: Set<string>|string[] }} context
 *   `appId` is the app's stamped id, the one the cart rows carry.
 * @returns {{ event: string, data: object }|null}
 */
export function mapCommerceEvent(frame, { appId, networkId = null, subscribed } = {}) {
  const toApps = frame && FROM_FRAME.get(frame.event);
  if (!toApps) return null;
  if (frame.event === 'commerce.catalogue.updated' && frame.networkId && networkId && frame.networkId !== networkId) {
    return null;
  }
  const { event, data, onlyTo } = toApps(frame);
  if (onlyTo && !onlyTo.has(appId)) return null;
  const wanted = subscribed instanceof Set ? subscribed.has(event) : Array.isArray(subscribed) && subscribed.includes(event);
  return wanted ? { event, data } : null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A refusal with a code an app can branch on. */
const refusal = (code, message) => Object.assign(new Error(message), { code });
const invalid = (message) => refusal('validation_failed', message);

const list = (value) => (Array.isArray(value) ? value : []);

/** The object without its undefined keys: only what was given travels. */
const defined = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

/** The listed keys of `source` that are not undefined. */
const pick = (source, keys) => defined(Object.fromEntries(keys.map((key) => [key, source[key]])));

/** A non-empty id, or a refusal naming the param. */
const idParam = (params, key) => {
  const value = typeof params?.[key] === 'string' ? params[key].trim() : '';
  if (!value) throw invalid(`${key} is required`);
  return value;
};

/** A number from a number or a numeric string; anything else is NaN, so a range check refuses it. */
const toNumber = (value) => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
};

/** An optional ISO date: absent is undefined; anything that is not a date is refused. */
const optionalDate = (params, key) => {
  const value = params?.[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw invalid(`${key} must be an ISO date`);
  return value;
};

const optionalCurrency = (params, key) => {
  const value = params?.[key];
  if (value === undefined || value === null) return undefined;
  if (value !== 'VRSC' && value !== 'USD') throw invalid(`${key} must be VRSC or USD`);
  return value;
};

/** A read that is a label, not a precondition: when it fails, the label is null. */
const quietly = async (read) => {
  try {
    return await read();
  } catch {
    return null;
  }
};

/** A key that makes a retried write return the FIRST result, never a second one. */
export const mintIdempotencyKey = () => globalThis.crypto.randomUUID();

// ---------------------------------------------------------------------------
// The cart (buyerIntents.js)
// ---------------------------------------------------------------------------

const cartItems = (data) => list(data?.items);

/** What the badge counts and `get-cart` answers: the cart, saved for later excluded. */
const countOf = (items) => items.filter((item) => !item.savedForLater).length;

/** Every cart write answers the way `get-cart` reads: the WHOLE cart, every app's rows. */
const cartAnswer = (items) => ({ success: true, items, count: countOf(items) });

/**
 * The calling app's own row, read off the cart: or the refusal that says why it
 * is not one. `not_found` for a row the cart does not hold, `not_yours` for
 * another app's. A row's `appId` never changes once it is in the cart, so
 * reading the row first and then writing it cannot be raced into writing
 * someone else's.
 */
async function ownRow(ctx, itemId) {
  if (typeof itemId !== 'string' || !itemId.trim()) throw invalid('Say which cart row: itemId is required');
  const row = cartItems(await ctx.request('valuguru.commerce.cart.get', {})).find((item) => item.id === itemId);
  if (!row) throw refusal('not_found', 'That item is not in the cart');
  if (row.appId !== ctx.appId) {
    throw refusal('not_yours', 'That item was added by another app; the buyer can change it in My Cart');
  }
  return row;
}

/** What `update-cart-item` may change, checked so a nonsense value never becomes a round trip. */
function cartPatchOf(params) {
  const patch = {};
  if (params.qty !== undefined) {
    const qty = typeof params.qty === 'number' ? Math.trunc(params.qty) : NaN;
    if (!Number.isFinite(qty) || qty < 1) throw invalid('qty must be a whole number, at least 1');
    patch.qty = qty;
  }
  for (const flag of ['selected', 'savedForLater']) {
    if (params[flag] === undefined) continue;
    if (typeof params[flag] !== 'boolean') throw invalid(`${flag} must be true or false`);
    patch[flag] = params[flag];
  }
  if (Object.keys(patch).length === 0) throw invalid('Nothing to change: give qty, selected or savedForLater');
  return patch;
}

/**
 * What a code would do to this app's selection, judged the way My Cart judges
 * it: a code is VALID only when the server's verdict is good AND it takes
 * something off. A valid code under its minimum gives nothing, which is
 * `not_applicable`. Everything else that took money off (a volume tier, a sale)
 * is listed too, because the totals include it; a part the buyer already owns
 * is not a discount (it was never charged) and is left out.
 */
function previewAnswer(preview) {
  const adjustments = list(preview?.adjustments);
  const verdict = preview?.verdict;
  const valid = verdict?.ok === true && adjustments.some((a) => a.kind === 'discount_code');
  return {
    valid,
    reason: valid ? null : verdict?.ok === true ? 'not_applicable' : verdict?.reason || 'promo_invalid',
    discounts: adjustments
      .filter((a) => a.kind !== 'excluded_owned')
      .map((a) => ({ kind: a.kind, label: a.label || a.kind, amountVrsc: Number(a.amountVrsc ?? a.amount_vrsc ?? 0) })),
    subtotalVrsc: Number(preview?.subtotalVrsc ?? 0),
    totalVrsc: Number(preview?.totalVrsc ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Orders (orderForIntent.js) — every field PICKED, never spread
// ---------------------------------------------------------------------------

const ORDER_STATUSES = ['pending_payment', 'paid', 'expired', 'cancelled', 'failed'];

/** An adjustment with no label of its own (a row from before labels), said the way the receipt says it. */
const ADJUSTMENT_LABEL = { discount_code: 'Discount code', volume_tier: 'Volume discount', sale: 'Sale' };

/** A figure, or null when the row has none: never a 0 that was not there. */
const amount = (value) => (value == null || value === '' ? null : Number(value));

const byFrozenOrder = (a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);

/** How the order was paid, or null while nothing has happened to it. */
const paymentFor = (order, payment) => {
  const transactionId = order.txid || payment?.txid || null;
  const failureReason = order.failure_reason || null;
  if (!payment && !transactionId && !failureReason) return null;
  return { method: payment?.method ?? null, transactionId, failureReason };
};

function orderForIntent(order, { lines = [], adjustments = [], payouts = [], payment = null, titleOf } = {}) {
  const sorted = [...lines].sort(byFrozenOrder);
  const childrenOf = (lineId) => sorted.filter((l) => l.parent_line_id === lineId);
  const rate = Number(order?.rate_snapshot?.vrscUsd);

  return {
    id: order.id,
    status: order.status,
    createdAt: order.created_at ?? null,
    paidAt: order.paid_at || payment?.confirmedAt || null,
    expiresAt: order.expires_at ?? null,
    isTest: Boolean(order.is_test || payment?.isTest),
    subtotalVrsc: amount(order.subtotal_vrsc),
    totalVrsc: amount(order.total_vrsc),
    // The rate frozen at checkout, never today's.
    rateVrscUsd: rate > 0 ? rate : null,
    items: sorted
      .filter((line) => line.role === 'item')
      .map((line) => {
        const children = childrenOf(line.id);
        const fees = children.filter((c) => c.role === 'curator_fee');
        return {
          productId: line.product_id,
          appId: line.app_id ?? null,
          title: line.title_snapshot ?? '',
          qty: Number(line.qty) || 1,
          unitPriceVrsc: amount(line.unit_price_vrsc),
          lineTotalVrsc: amount(line.line_total_vrsc),
          // Resolved live by `orders.list`; `orders.get` does not, so a single
          // order's lines have no picture rather than an undefined one.
          imageResourceId: line.image_resource_id ?? null,
          deletedBySeller: Boolean(line.deleted_by_seller),
          parts: children
            .filter((c) => c.role === 'component')
            .map((c) => ({ productId: c.product_id, title: c.title_snapshot ?? '' })),
          bundleFeeVrsc: fees.length > 0 ? fees.reduce((sum, f) => sum + (Number(f.line_total_vrsc) || 0), 0) : null,
        };
      }),
    // What took money off. A part the buyer already owned is not a discount: it
    // was never charged at all, so it is listed apart.
    discounts: adjustments
      .filter((a) => a.kind !== 'excluded_owned')
      .map((a) => ({ kind: a.kind, label: a.label || ADJUSTMENT_LABEL[a.kind] || a.kind, amountVrsc: amount(a.amount_vrsc) })),
    notCharged: adjustments
      .filter((a) => a.kind === 'excluded_owned')
      .map((a) => ({ productId: a.product_id ?? null, title: titleOf?.(a.product_id) ?? null, amountVrsc: amount(a.amount_vrsc) })),
    // Who was paid, and why that amount. Not WHERE: no address or transaction of a payout.
    payouts: payouts.map((p) => ({
      kind: p.kind ?? 'store',
      identityName: p.identity_name ?? null,
      storeId: p.store_id ?? null,
      amountVrsc: amount(p.amount_vrsc),
      status: p.status ?? null,
      donationPercent: amount(p.donation_percent),
      donationMemberCount: amount(p.donation_member_count),
    })),
    payment: paymentFor(order, payment),
  };
}

/**
 * What the parts a buyer already owned are called. Such a part was not
 * charged, so the order froze no line (and no title) for it; the buyer owns it,
 * so their purchases name it. Read only when an order has one, and a failed
 * read costs the names, never the orders.
 */
async function ownedTitles(ctx, adjustments) {
  if (!adjustments.some((a) => a.kind === 'excluded_owned')) return undefined;
  const purchases = await ctx.request('valuguru.commerce.purchases.list', {}).then((data) => list(data?.products), () => []);
  const titles = new Map(purchases.map((p) => [p.productId, p.title]));
  return (productId) => titles.get(productId) ?? null;
}

// ---------------------------------------------------------------------------
// Purchases, contents and products (purchaseForIntent.js, sellerProductForIntent.js)
// ---------------------------------------------------------------------------

/**
 * One thing the user owns, in words an app can act on. "Delivered" is the copy
 * existing, not the ledger's word for it: a finished delivery with no folder is
 * not a copy the buyer can open.
 */
const purchaseForIntent = (row) => ({
  productId: row.productId,
  title: row.title ?? '',
  coverResourceId: row.imageResourceId ?? null,
  purchasedAt: row.grantedAt ?? null,
  orderId: row.orderId ?? null,
  // Where it was bought: not necessarily the app asking.
  boughtInAppId: row.appId ?? null,
  // Bought as a part of a bundle rather than on its own line.
  isBundlePart: row.role === 'component',
  delivered: row.deliveryStatus === 'delivered' && Boolean(row.deliveredResourceId),
  deletedBySeller: Boolean(row.deletedBySeller),
});

/** How many products a seller row says it includes, whichever field carried it. */
const includedCount = (product) => Number(product?.included_count ?? product?.child_count ?? product?.childCount ?? 0);

/**
 * What a buyer would pay, as the SERVER priced it. A bundle's `price_amount` is
 * not its price; the server quotes it as its parts plus the seller's own price
 * on top. A bundle the server could not quote says so (null), never "free".
 */
const totalPriceOf = (product) => {
  if (product?.bundle_price) return Number(product.bundle_price.total) || 0;
  if (includedCount(product) > 0) return null;
  return Number(product?.price_amount) || 0;
};

/** The fields a caller can read and write, and whether it may write them now (only a draft is editable). */
const sellerProductForIntent = (row) => ({
  id: row.id,
  title: row.title,
  description: row.description ?? null,
  status: row.status,
  priceAmount: Number(row.price_amount ?? 0),
  priceCurrency: row.price_currency ?? 'VRSC',
  // null is "unlimited", not "none left": said the way the params take it.
  stock: row.stock ?? null,
  category: row.category ?? null,
  tags: Array.isArray(row.tags) ? row.tags : [],
  imageResourceId: row.image_resource_id ?? null,
  ...(row.content_count != null ? { contentCount: Number(row.content_count) } : {}),
  ...(row.sold_count != null ? { soldCount: Number(row.sold_count) } : {}),
  editable: row.status === 'draft',
});

/** The same row as an app SHOWS it (`list-seller-products`): read-only. */
const sellerProductForDisplay = (row) => ({
  id: row.id,
  title: row.title,
  description: row.description ?? null,
  status: row.status,
  category: row.category ?? null,
  tags: Array.isArray(row.tags) ? row.tags : [],
  priceAmount: Number(row.price_amount ?? 0),
  priceCurrency: row.price_currency ?? 'VRSC',
  totalPriceAmount: totalPriceOf(row),
  isBundle: includedCount(row) > 0,
  coverResourceId: row.cover_resource_id ?? row.image_resource_id ?? null,
  stock: row.stock ?? null,
  soldCount: Number(row.sold_count ?? 0),
  contentCount: Number(row.content_count ?? 0),
});

/** Item rows are flat (`parent_item_id` + `sort_order`) and every reader wants them nested. */
function nestItemRows(rows, toNode) {
  const children = new Map();
  for (const row of list(rows)) {
    const key = row.parent_item_id ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(row);
  }
  const build = (parentId) => (children.get(parentId) ?? [])
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((row) => toNode(row, build));
  return build(null);
}

/**
 * Item rows -> the nested shape `update-product` takes back:
 * `{resourceId, title?, kind?}`, `{folder, items}`, `{productId, title?}`.
 */
const productItemsToIntent = (rows) => nestItemRows(rows, (row, childrenOf) => {
  if (row.item_type === 'folder') return { folder: row.title || 'Folder', items: childrenOf(row.id) };
  if (row.item_type === 'product') return { productId: row.child_product_id, ...(row.title ? { title: row.title } : {}) };
  return {
    resourceId: row.resource_id,
    ...(row.title ? { title: row.title } : {}),
    ...(row.resource_kind && row.resource_kind !== 'file' ? { kind: row.resource_kind } : {}),
  };
});

/**
 * Item rows -> the tree an app DRAWS (`contents`). Every node says what it is
 * (folder | file | product) and has a title, so an app never prints a blank
 * row; an included product is named from `children` when its row has no title.
 * With `delivered`, for a purchase's tree, a file also says where the buyer's
 * own copy is.
 */
const productContentsForDisplay = (rows, products = [], { delivered = false } = {}) => {
  const titles = new Map(list(products).map((p) => [p?.id, p?.title]));
  return nestItemRows(rows, (row, childrenOf) => {
    if (row.item_type === 'folder') return { type: 'folder', title: row.title || 'Folder', items: childrenOf(row.id) };
    if (row.item_type === 'product') {
      return { type: 'product', productId: row.child_product_id, title: row.title || titles.get(row.child_product_id) || 'Product' };
    }
    const saved = row.resource_meta && typeof row.resource_meta === 'object' ? row.resource_meta : {};
    return {
      type: 'file',
      resourceId: row.resource_id,
      title: row.title || saved.title || saved.fileName || 'File',
      kind: row.resource_kind || 'file',
      contentType: typeof saved.contentType === 'string' ? saved.contentType : null,
      fileSize: Number.isFinite(saved.fileSize) ? saved.fileSize : null,
      ...(delivered ? { deliveredResourceId: row.delivered_resource_id ?? null } : {}),
    };
  });
};

/**
 * A product's content as an intent describes it (a resource id, `{resourceId,
 * title?, kind?}`, `{folder, items}`, `{productId}`) -> the wire the server
 * takes (`products.items.set`): refs and parent links minted in pre-order.
 * Nothing here validates ownership, kinds or cycles; the server does.
 */
function productItemsFromIntent(items) {
  const out = [];
  let n = 0;
  const walk = (entries, parentRef) => {
    for (const entry of list(entries)) {
      const ref = `i${++n}`;
      const item = typeof entry === 'string' ? { resourceId: entry } : entry;
      if (!item || typeof item !== 'object') continue;
      if (item.folder !== undefined) {
        out.push({ ref, type: 'folder', parentRef, title: String(item.folder || 'Folder') });
        walk(item.items, ref);
      } else if (item.productId) {
        out.push({ ref, type: 'product', parentRef, childProductId: String(item.productId), ...(item.title ? { title: String(item.title) } : {}) });
      } else if (item.resourceId) {
        out.push({
          ref,
          type: 'resource',
          parentRef,
          resourceId: String(item.resourceId),
          resourceKind: item.kind === 'folder' || item.kind === 'link' ? item.kind : 'file',
          ...(item.title ? { title: String(item.title) } : {}),
        });
      }
      // Anything else says nothing the server could act on: dropped.
    }
  };
  walk(items, null);
  return out;
}

/**
 * A price on a product that includes other products is "on top of them": the
 * server ignores a bundle's own price and charges its parts plus a fixed
 * curator fee, so the caller's `priceAmount` on a bundle becomes that fee.
 */
const asBundlePrice = (input) => {
  if (input.priceAmount === undefined) return input;
  const fee = Number(input.priceAmount) || 0;
  return { ...input, priceAmount: 0, curatorFeeType: fee > 0 ? 'fixed' : null, curatorFeeValue: fee > 0 ? fee : null };
};

const includesProducts = (wireItems) => wireItems.some((item) => item.type === 'product' || item.childProductId || item.child_product_id);

/** The product fields `create-product` and `update-product` take. */
const PRODUCT_FIELDS = ['title', 'description', 'priceAmount', 'priceCurrency', 'category', 'tags', 'imageResourceId', 'stock'];

// ---------------------------------------------------------------------------
// Store, promotions (storeForIntent.js, CommerceDataService.js)
// ---------------------------------------------------------------------------

/** Lower bound of each donation tier, in members (transcribed from the server). */
const DONATION_TIERS = [0, 100, 1000, 10000];

/** The index of the tier a network of `memberCount` members falls in, or null for a count not known. */
const tierIndexFor = (memberCount) => {
  const count = Number(memberCount);
  if (memberCount == null || !Number.isFinite(count)) return null;
  let index = 0;
  DONATION_TIERS.forEach((min, i) => { if (min <= Math.max(0, count)) index = i; });
  return index;
};

/** Verus identity tier "Verified Self Sovereign": the one the server opens a store on. */
const VERIFIED_IDENTITY = 2;

/** A user's own profile name, first and last, trimmed: or null. The name a buyer knows the seller by. */
const profileNameOf = (user) => {
  const name = [user?.firstName, user?.lastName]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ');
  return name || null;
};

/** One store row -> what an app needs to draw the setup checklist and the donation editor, or null. */
const storeRowForIntent = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name ?? '',
    description: row.description ?? null,
    status: row.status ?? null,
    payoutIdentityName: row.payout_identity_name ?? null,
    // "Not set" is one fact: an empty list, never null.
    donationTiers: Array.isArray(row.donation_tiers)
      ? row.donation_tiers.map((tier) => ({ minMembers: Number(tier?.minMembers), percent: Number(tier?.percent) }))
      : [],
    donationUpdatedAt: row.donation_updated_at ?? null,
  };
};

/**
 * `get-my-store`'s whole answer. `identityVerified` is a Verified identity OR a
 * store (the server opens one only on a verified identity). `sellerName` is the
 * name to show for the seller: the owner's profile name, else the identity
 * buyers pay into, else the store's own name. `network` is the one the user is
 * in now; its policy facts are null when the policy could not be read (an
 * unknown mode is not "open").
 */
const storeForIntent = ({ store, user, memberCount, policy, networkId }) => {
  const hasStore = Boolean(store);
  const count = memberCount == null || !Number.isFinite(Number(memberCount)) ? null : Number(memberCount);
  return {
    hasStore,
    identityVerified: hasStore || Number(user?.identityType) >= VERIFIED_IDENTITY,
    sellerName: profileNameOf(user) ?? (store?.payout_identity_name || null) ?? (store?.name || null),
    sellerUserId: user?.id ?? null,
    store: storeRowForIntent(store),
    network: {
      id: policy?.networkId ?? networkId ?? null,
      memberCount: count,
      mode: policy?.mode ?? null,
      allowedRatings: Array.isArray(policy?.allowedRatings) ? policy.allowedRatings : [],
      displayCurrency: policy?.displayCurrency ?? null,
      donationTierIndex: hasStore ? tierIndexFor(count) : null,
    },
  };
};

/** One row of the store's standing in a network. `status` is `pending | approved | rejected | suspended`. */
const networkAccessForIntent = (row) => ({
  networkId: row?.network_id ?? null,
  status: row?.status ?? null,
  requestedAt: row?.requested_at ?? null,
  decidedAt: row?.decided_at ?? null,
  note: row?.note ?? null,
  message: row?.message ?? null,
});

/** `promotions.list` hands back raw rows, snake_case; this is the one place that states their columns. */
const mapSaleRow = (row) => ({
  id: row?.id,
  storeId: row?.store_id,
  productId: row?.product_id,
  salePriceAmount: row?.sale_price_amount,
  salePriceCurrency: row?.sale_price_currency,
  startsAt: row?.starts_at,
  endsAt: row?.ends_at,
  status: row?.status,
  createdAt: row?.created_at,
  updatedAt: row?.updated_at,
});

const mapTierRow = (row) => ({
  id: row?.id,
  storeId: row?.store_id,
  minItems: row?.min_items,
  percentOff: row?.percent_off,
  status: row?.status,
  createdAt: row?.created_at,
  updatedAt: row?.updated_at,
});

const mapCodeRow = (row) => ({
  id: row?.id,
  storeId: row?.store_id,
  code: row?.code,
  kind: row?.kind,
  value: row?.value,
  currency: row?.currency,
  minSubtotalVrsc: row?.min_subtotal_vrsc,
  maxRedemptions: row?.max_redemptions,
  redeemedCount: row?.redeemed_count,
  reservedCount: row?.reserved_count,
  perBuyerLimit: row?.per_buyer_limit,
  startsAt: row?.starts_at,
  endsAt: row?.ends_at,
  status: row?.status,
  createdAt: row?.created_at,
  updatedAt: row?.updated_at,
});

/** A store's name: text, not blank, at most the console's 120 characters. */
const storeName = (value) => {
  if (typeof value !== 'string') throw invalid('name must be text');
  const name = value.trim();
  if (!name) throw invalid('A store needs a name');
  if (name.length > 120) throw invalid('A store\'s name is at most 120 characters');
  return name;
};

const storeDescription = (value) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid('description must be text');
  if (value.length > 2000) throw invalid('A store\'s description is at most 2000 characters');
  return value;
};

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const READ = 'commerce:read';
const WRITE = 'commerce:write';
const SELL = 'commerce:sell';

const TABLE = {
  // ---- commerce:read (11) ----------------------------------------------------

  'check-entitlements': {
    op: 'valuguru.commerce.entitlements.check',
    scope: READ,
    toParams: (params) => ({ productIds: list(params.productIds) }),
    fromResult: (data) => ({ entitlements: data && typeof data === 'object' ? data : {} }),
  },

  // The WHOLE cart, not just this app's rows: the user checks out one cart in
  // one scan, so an app that shows a count has to count the same cart.
  'get-cart': {
    op: 'valuguru.commerce.cart.get',
    scope: READ,
    toParams: () => ({}),
    fromResult: (data) => {
      const items = cartItems(data);
      return { items, count: countOf(items) };
    },
  },

  // How this network SHOWS prices, and the rate. Amounts everywhere stay VRSC.
  'get-display': {
    op: 'valuguru.commerce.display.get',
    scope: READ,
    toParams: () => ({}),
    fromResult: (data) => ({
      currency: data?.currency === 'VRSC' ? 'VRSC' : 'USD',
      vrscUsd: Number(data?.vrscUsd) > 0 ? Number(data.vrscUsd) : null,
    }),
  },

  // One order. Someone else's is `not_found`: the server's rule, so an id is not a probe.
  'get-order': {
    op: 'valuguru.commerce.orders.get',
    scope: READ,
    toParams: (params) => {
      const orderId = typeof params.orderId === 'string' ? params.orderId.trim() : '';
      if (!orderId) throw invalid('Say which order: orderId is required');
      return { orderId };
    },
    fromResult: async (data, params, ctx) => {
      if (!data?.order) throw refusal('not_found', 'Order not found');
      const adjustments = list(data.adjustments);
      return {
        order: orderForIntent(data.order, {
          lines: list(data.lines),
          adjustments,
          payouts: list(data.payouts),
          payment: data.payment ?? null,
          titleOf: await ownedTitles(ctx, adjustments),
        }),
      };
    },
  },

  // The ids that OPEN the files go only to someone who owns the product or
  // sells it: the previewer and the resource URLs do not ask who is looking, so
  // an id handed to a browsing app would be the paid file itself. Titles and
  // types stay: they are the shop window.
  'get-product': {
    op: 'valuguru.commerce.catalog.get',
    scope: READ,
    toParams: (params, ctx) => defined({ productId: params.productId, appId: ctx.appId }),
    fromResult: (data) => {
      if (!Array.isArray(data?.items)) return data;
      const items = data.owned || data.isOwnProduct
        ? data.items
        : data.items.map((row) => ({ ...row, resource_id: null, vault_resource_id: null }));
      return { ...data, items, contents: productContentsForDisplay(items, data.children) };
    },
  },

  // One purchase opened up: the version the user BOUGHT, frozen at purchase.
  // The server decides ownership, and its refusal is `not_owned` to an app.
  'get-purchase-contents': {
    op: 'valuguru.commerce.purchases.tree',
    scope: READ,
    run: async (params, ctx) => {
      if (!params.productId) throw invalid('Say which purchase: productId is required');
      let tree;
      try {
        tree = await ctx.request('valuguru.commerce.purchases.tree', { productId: params.productId });
      } catch (err) {
        if (err?.code === 'forbidden') throw refusal('not_owned', 'The user does not own this product');
        throw err;
      }
      return {
        productId: params.productId,
        title: tree?.title ?? '',
        deletedBySeller: Boolean(tree?.deletedBySeller),
        contents: productContentsForDisplay(list(tree?.items), list(tree?.children), { delivered: true }),
      };
    },
  },

  'list-categories': {
    op: 'valuguru.commerce.catalog.categories',
    scope: READ,
    toParams: () => ({}),
    fromResult: (data) => ({ categories: list(data?.categories) }),
  },

  // The buyer's orders, newest first. Every app may read every order, unless it
  // asks for its own: `thisAppOnly` keeps an order with at least one ITEM from
  // the calling app (a part inside another app's bundle does not make it this
  // app's). The server pages before the filter, so `limit` counts every app's.
  'list-orders': {
    op: 'valuguru.commerce.orders.list',
    scope: READ,
    toParams: (params) => {
      if (params.status !== undefined && !ORDER_STATUSES.includes(params.status)) {
        throw invalid(`status must be one of ${ORDER_STATUSES.join(', ')}`);
      }
      return defined({ status: params.status, limit: params.limit });
    },
    fromResult: async (data, params, ctx) => {
      const lines = list(data?.lines);
      const adjustments = list(data?.adjustments);
      let orders = list(data?.orders);
      if (params.thisAppOnly === true) {
        const mine = new Set(lines.filter((l) => l.role === 'item' && l.app_id === ctx.appId).map((l) => l.order_id));
        orders = orders.filter((order) => mine.has(order.id));
      }
      // The server sends them newest first today; said here, so an app can rely on it.
      orders = [...orders].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
      const titleOf = await ownedTitles(ctx, adjustments.filter((a) => orders.some((o) => o.id === a.order_id)));
      const payouts = list(data?.payouts);
      const payments = list(data?.payments);
      return {
        orders: orders.map((order) => orderForIntent(order, {
          lines: lines.filter((l) => l.order_id === order.id),
          adjustments: adjustments.filter((a) => a.order_id === order.id),
          payouts: payouts.filter((p) => p.order_id === order.id),
          payment: payments.find((p) => p.orderId === order.id) ?? null,
          titleOf,
        })),
      };
    },
  },

  // Products listed in ONE app (the stamp) and available in the caller's
  // network. A product the server refuses is simply not in the answer.
  'list-products': {
    op: 'valuguru.commerce.catalog.search',
    scope: READ,
    toParams: (params, ctx) => defined({
      appId: ctx.appId,
      storeId: params.storeId,
      query: params.query,
      category: params.category,
      tag: params.tag,
      attributes: params.attributes,
      sort: params.sort,
      limit: params.limit,
      offset: params.offset,
    }),
    fromResult: (data) => ({ products: list(data?.products), nextOffset: data?.nextOffset ?? null }),
  },

  // What the user OWNS, wherever they bought it, unless the app asks for the
  // ones bought in it; "it" is the host's stamp, never a param.
  'list-purchases': {
    op: 'valuguru.commerce.purchases.list',
    scope: READ,
    toParams: (params, ctx) => defined({ appId: params.thisAppOnly === true ? ctx.appId : undefined }),
    fromResult: (data) => ({ purchases: list(data?.products).map(purchaseForIntent) }),
  },

  // Read-only: nothing is reserved, and My Cart asks the server again when the
  // buyer pays, so a stale preview can never become a wrong charge. Codes are
  // stored and matched upper-cased.
  'preview-promo': {
    op: 'valuguru.commerce.orders.previewPromo',
    scope: READ,
    toParams: (params, ctx) => {
      const code = typeof params.code === 'string' ? params.code.trim().toUpperCase() : '';
      if (!code) throw invalid('Give the code to check');
      return { scope: ctx.appId, code };
    },
    fromResult: previewAnswer,
  },

  // ---- commerce:write (4): an app changes only its own rows -----------------------

  'add-to-cart': {
    op: 'valuguru.commerce.cart.add',
    scope: WRITE,
    toParams: (params, ctx) => defined({ productId: params.productId, appId: ctx.appId, qty: params.qty }),
    fromResult: (data) => ({ success: true, items: cartItems(data) }),
  },

  // NOT `cart.clear {appId}`: a server from before that parameter ignores the
  // app and empties EVERY app's rows, and nothing tells the two servers apart
  // before the rows are gone. So the app's rows go one at a time, each the
  // server's ordinary `cart.remove`. A row already gone is what was asked for;
  // any other refusal stops the clear and is the answer.
  'clear-cart': {
    op: 'valuguru.commerce.cart.remove',
    scope: WRITE,
    run: async (params, ctx) => {
      let items = cartItems(await ctx.request('valuguru.commerce.cart.get', {}));
      const mine = items.filter((item) => item.appId === ctx.appId).map((item) => item.id);
      for (const itemId of mine) {
        try {
          items = cartItems(await ctx.request('valuguru.commerce.cart.remove', { itemId }));
        } catch (err) {
          if (err?.code !== 'not_found') throw err;
        }
      }
      return cartAnswer(items);
    },
  },

  'remove-from-cart': {
    op: 'valuguru.commerce.cart.remove',
    scope: WRITE,
    toParams: async (params, ctx) => ({ itemId: (await ownRow(ctx, params.itemId)).id }),
    fromResult: (data) => cartAnswer(cartItems(data)),
  },

  'update-cart-item': {
    op: 'valuguru.commerce.cart.update',
    scope: WRITE,
    toParams: async (params, ctx) => {
      const patch = cartPatchOf(params);
      const row = await ownRow(ctx, params.itemId);
      return { itemId: row.id, ...patch };
    },
    fromResult: (data) => cartAnswer(cartItems(data)),
  },

  // ---- commerce:sell (15): the signed-in user's own store --------------------------

  // A DRAFT from the fields given, and never more: publishing decides money and
  // where it sells, so it stays with the seller. Without a title Valu Social
  // opens its create form; the host has none. A refusal AFTER the row was
  // created still names the product, so the caller knows an empty draft exists.
  'create-product': {
    op: 'valuguru.commerce.products.create',
    scope: SELL,
    run: async (params, ctx) => {
      if (typeof params.title !== 'string' || !params.title.trim()) {
        throw refusal('unsupported', 'create-product needs a title: without one it would open a form, and this host has no screen for it');
      }
      const input = pick(params, PRODUCT_FIELDS);
      const items = productItemsFromIntent(params.items);
      let product = null;
      try {
        ({ product = null } = await ctx.request('valuguru.commerce.products.create', includesProducts(items) ? asBundlePrice(input) : input));
        if (items.length > 0) await ctx.request('valuguru.commerce.products.items.set', { productId: product.id, items });
        return { success: true, product };
      } catch (err) {
        return { success: false, product, code: err?.code || 'error', error: err?.message || String(err) };
      }
    },
  },

  // Open the seller's store. An existing one comes back as it is (the server's
  // rule); a user without a Verified identity is refused `not_eligible_kyc`.
  // The name is optional: buyers see the owner, not the store. Without one the
  // owner's profile name is sent when the host knows it (an older server still
  // requires a name); with neither, the server decides.
  'create-store': {
    op: 'valuguru.commerce.store.create',
    scope: SELL,
    toParams: (params, ctx) => {
      const name = params.name === undefined ? profileNameOf(ctx.user) ?? undefined : storeName(params.name);
      return defined({ name, description: storeDescription(params.description) });
    },
    fromResult: (data) => ({ success: true, store: storeRowForIntent(data?.store) }),
  },

  // Only a code nothing ever used: the server keeps a used one (`conflict`).
  'delete-discount-code': {
    op: 'valuguru.commerce.promotions.code.delete',
    scope: SELL,
    toParams: (params) => ({ codeId: idParam(params, 'codeId') }),
    fromResult: () => ({ success: true }),
  },

  // Ending a sale only stops a discount: direct.
  'end-sale': {
    op: 'valuguru.commerce.promotions.sale.end',
    scope: SELL,
    toParams: (params) => ({ saleId: idParam(params, 'saleId') }),
    fromResult: (data) => ({ success: true, sale: mapSaleRow(data?.sale) }),
  },

  // The server's numbers, untouched: a cell built from too few orders comes back
  // with no figure, and nothing here may turn "withheld" into a zero.
  'get-analytics': {
    op: 'valuguru.commerce.store.analytics',
    scope: SELL,
    toParams: (params) => ({
      ...defined({ from: optionalDate(params, 'from'), to: optionalDate(params, 'to') }),
      ...(params.testOnly === true ? { testOnly: true } : {}),
    }),
    fromResult: (data) => data,
  },

  // One of the seller's own products with its content, in exactly the shape
  // `update-product` takes back.
  'get-my-product': {
    op: 'valuguru.commerce.products.get',
    scope: SELL,
    toParams: (params) => defined({ productId: params.productId }),
    fromResult: async (data, params, ctx) => {
      if (!data?.product) throw refusal('not_found', 'Product not found');
      const content = await ctx.request('valuguru.commerce.products.items.get', { productId: params.productId });
      return { product: sellerProductForIntent(data.product), items: productItemsToIntent(list(content?.items)) };
    },
  },

  // The store, whether the user can sell, and this network: enough to draw the
  // console's setup checklist. The network's size and policy are labels, unknown
  // when unread and never a failure; the store read is the point, and its
  // refusal is the answer.
  'get-my-store': {
    op: 'valuguru.commerce.store.get',
    scope: SELL,
    toParams: () => ({}),
    fromResult: async (data, params, ctx) => {
      const [memberCount, policy] = await Promise.all([
        quietly(async () => {
          const members = (await ctx.request('valuguru.commerce.network.memberCount', {}))?.memberCount;
          return members == null || !Number.isFinite(Number(members)) ? null : Number(members);
        }),
        quietly(async () => (await ctx.request('valuguru.commerce.network.policy.get', {}))?.policy ?? null),
      ]);
      return storeForIntent({ store: data?.store ?? null, user: ctx.user, memberCount, policy, networkId: ctx.networkId });
    },
  },

  // The seller's own catalogue, drafts included, which `list-products` (the
  // buyer's shelf) never shows, so an app can find what to edit.
  'list-my-products': {
    op: 'valuguru.commerce.products.list',
    scope: SELL,
    toParams: (params) => defined({ status: params.status, limit: params.limit }),
    fromResult: (data) => (data?.store
      ? { hasStore: true, products: list(data.products).map(sellerProductForIntent) }
      : { hasStore: false, products: [] }),
  },

  'list-network-access': {
    op: 'valuguru.commerce.store.networks.list',
    scope: SELL,
    toParams: () => ({}),
    fromResult: (data) => ({ networks: list(data?.networks).map(networkAccessForIntent) }),
  },

  'list-promotions': {
    op: 'valuguru.commerce.promotions.list',
    scope: SELL,
    toParams: () => ({}),
    fromResult: (data) => ({
      sales: list(data?.sales).map(mapSaleRow),
      tiers: list(data?.tiers).map(mapTierRow),
      codes: list(data?.codes).map(mapCodeRow),
    }),
  },

  // The same catalogue for an app to SHOW: every product of the signed-in
  // seller's store, drafts, archived and network-blocked ones included,
  // read-only. The store is the one the server finds for the connection's
  // user; there is no `storeId` to pass, so an app cannot read someone else's.
  'list-seller-products': {
    op: 'valuguru.commerce.products.list',
    scope: SELL,
    toParams: (params) => defined({ status: params.status, limit: params.limit }),
    fromResult: (data) => (data?.store
      ? { hasStore: true, products: list(data.products).map(sellerProductForDisplay) }
      : { hasStore: false, products: [] }),
  },

  // What a bundle of these would cost a buyer: the server's own pricing, as is.
  'quote-bundle': {
    op: 'valuguru.commerce.products.quote',
    scope: SELL,
    toParams: (params) => {
      const ids = params.productIds;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id)) {
        throw invalid('productIds must be a list of product ids');
      }
      const ownPrice = params.ownPrice === undefined ? undefined : toNumber(params.ownPrice);
      if (ownPrice !== undefined && !(ownPrice >= 0)) throw invalid('ownPrice must be zero or more');
      return defined({ productIds: ids, priceCurrency: optionalCurrency(params, 'priceCurrency'), ownPrice });
    },
    fromResult: (data) => data,
  },

  // Removing a volume discount only stops it: direct.
  'remove-volume-tier': {
    op: 'valuguru.commerce.promotions.tier.remove',
    scope: SELL,
    toParams: (params) => ({ tierId: idParam(params, 'tierId') }),
    fromResult: () => ({ success: true }),
  },

  // Ask a network's admins to let the store sell there; they decide.
  'request-network-access': {
    op: 'valuguru.commerce.store.networks.request',
    scope: SELL,
    toParams: (params) => {
      const networkId = idParam(params, 'networkId');
      if (params.message !== undefined && typeof params.message !== 'string') throw invalid('message must be text');
      if (params.message?.length > 2000) throw invalid('message is at most 2000 characters');
      return defined({ networkId, message: params.message });
    },
    fromResult: (data) => ({ success: true, request: networkAccessForIntent(data?.storeNetwork) }),
  },

  // Edit one of the seller's own DRAFTS from fields: `products.update` for the
  // fields given, `products.items.set` when `items` is given. Only a draft (a
  // live product's version is frozen for the buyers who have it); the one
  // exception is a product that needs attention (`broken`), whose CONTENT alone
  // may change. The status is read first so a refusal changes nothing. `items`
  // REPLACES the content, so an empty list is refused rather than obeyed: "omit
  // it" is how to keep the content.
  'update-product': {
    op: 'valuguru.commerce.products.update',
    scope: SELL,
    run: async (params, ctx) => {
      const productId = typeof params.productId === 'string' ? params.productId.trim() : '';
      if (!productId) throw invalid('productId is required');

      const input = pick(params, PRODUCT_FIELDS);
      // "Unlimited" is a null stock, which a tool schema typed `number` cannot always carry.
      if (params.unlimitedStock === true) input.stock = null;
      const hasItems = params.items !== undefined;
      const items = hasItems ? productItemsFromIntent(params.items) : [];
      if (hasItems && items.length === 0) {
        throw invalid('items would leave the product with no content; omit items to keep the current content');
      }
      if (Object.keys(input).length === 0 && !hasItems) throw invalid('Nothing to update');

      const { product: current } = (await ctx.request('valuguru.commerce.products.get', { productId })) ?? {};
      const contentOnly = current?.status === 'broken';
      if (contentOnly && Object.keys(input).length > 0) {
        throw refusal('not_editable', 'This product needs attention: only its content (items) can change, and it goes back on sale when it is '
          + 'published again. Its other fields are frozen with the version buyers have');
      }
      if (!contentOnly && current?.status !== 'draft') {
        throw refusal('not_editable', current?.status === 'active'
          ? 'This product is on sale, so its version is frozen for buyers. The seller can Unlist it in the Merchant Console to edit it'
          : `A ${current?.status ?? 'missing'} product cannot be edited; only drafts and unlisted products can`);
      }

      // Is it a bundle? The content being sent decides when there is some;
      // otherwise the draft's own tree does, read only when a price is being set.
      let patch = input;
      if (input.priceAmount !== undefined) {
        const tree = hasItems ? items : list((await ctx.request('valuguru.commerce.products.items.get', { productId }))?.items);
        if (includesProducts(tree)) patch = asBundlePrice(input);
      }

      let product = current;
      if (Object.keys(patch).length > 0) {
        ({ product } = await ctx.request('valuguru.commerce.products.update', { productId, ...patch }));
      }
      if (hasItems) await ctx.request('valuguru.commerce.products.items.set', { productId, items });
      return { success: true, product: sellerProductForIntent(product) };
    },
  },
};

/**
 * The 30 Commerce data intents: action -> `{ op, scope, timeoutMs?, toParams,
 * fromResult }` (or `run`, see the header). Frozen, entries too.
 */
export const COMMERCE_INTENTS = Object.freeze(
  Object.fromEntries(Object.entries(TABLE).map(([action, entry]) => [action, Object.freeze(entry)])),
);

// ---------------------------------------------------------------------------
// Running one
// ---------------------------------------------------------------------------

/**
 * Serve one Commerce data intent over the Guru socket.
 *
 * Always resolves: a refusal (the server's, or this module's own validation)
 * is `{ success:false, code, error }`, and an action that is not one of the 30
 * is `{ success:false, code:'not_available', error }`. Permission (sign-in, the
 * scope's grant) is the caller's, before this.
 *
 * @param {string} action the intent's action, e.g. `'list-products'`.
 * @param {object} params the app's params; read-only, and never the source of `appId`.
 * @param {object} options
 * @param {{ request: (op: string, params?: object, opts?: object) => Promise<any> }} options.guru
 * @param {string} options.appId the host's stamp: the only app id this module trusts.
 * @param {object|null} [options.user] the signed-in user (`user_info.user`), for `get-my-store` and `create-store`.
 * @param {string|null} [options.networkId] the current network, when the policy cannot say.
 * @param {Record<string, object>} [options.intents] the table to serve from; the 30 unless a test says otherwise.
 * @returns {Promise<any>}
 */
export async function runCommerceIntent(action, params, { guru, appId, user = null, networkId = null, intents = COMMERCE_INTENTS } = {}) {
  const entry = typeof action === 'string' && Object.hasOwn(intents, action) ? intents[action] : null;
  if (!entry) return { success: false, code: 'not_available', error: `Action ${String(action)} is not available through the host` };
  if (!appId) {
    return { success: false, code: 'forbidden', error: 'The calling app could not be identified, so this commerce action was refused' };
  }

  const input = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const ctx = {
    appId,
    user,
    networkId,
    idempotencyKey: mintIdempotencyKey,
    request: (op, opParams, opts) => (opts ? guru.request(op, opParams, opts) : guru.request(op, opParams)),
  };

  try {
    if (entry.run) return await entry.run(input, ctx);
    const opParams = await entry.toParams(input, ctx);
    const data = await ctx.request(entry.op, opParams, entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : undefined);
    return await entry.fromResult(data, input, ctx);
  } catch (err) {
    return { success: false, code: err?.code || 'error', error: err?.message || String(err) };
  }
}
