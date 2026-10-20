// ===========================================================================
// The row shapers behind the Commerce data intents (spec §4.7).
//
// Valu Social's Guru ops answer in raw database rows (snake_case, with columns
// no app has any business reading); the intents answer in an app's own idiom.
// These are the pure functions between the two, ported from Valu Social's
// `orderForIntent.js`, `purchaseForIntent.js`, `sellerProductForIntent.js`,
// `storeForIntent.js`, `productItemsFromIntent.js`, `CommerceDataService.js`
// (the promotion rows) and `buyerIntents.js` (the promo preview).
//
// THE RULE THIS FILE EXISTS FOR: orders, purchases, stores and the seller's
// products are PICKED field by field, never spread. An order row carries its
// payment links; an app that held them could draw the code itself. A spread
// would carry any column the server adds tomorrow, so nothing is copied that is
// not named here.
//
// Pure: no ctx, no ops, no DOM, no logging, no imports.
// ===========================================================================

const list = (value) => (Array.isArray(value) ? value : []);

/**
 * The cart's badge number: the rows that are not saved for later. `get-cart`
 * counts the whole cart; the `cart-updated` event passes `appId` and counts one
 * app's rows. A row that is not an object is not a row. One rule for both, so an
 * app's number is the badge's rule whichever way it is asked for.
 * @param {unknown} items the server's `cart.get` rows
 * @param {string} [appId] only this app's rows
 */
export const cartCount = (items, appId) => list(items).filter((item) => (
  item !== null && typeof item === 'object' && (appId === undefined || item.appId === appId) && !item.savedForLater
)).length;

/**
 * What a code would do to this app's selection, judged the way My Cart judges
 * it: a code is VALID only when the server's verdict is good AND it takes
 * something off. A valid code under its minimum gives nothing, which is
 * `not_applicable`. Everything else that took money off (a volume tier, a sale)
 * is listed too, because the totals include it; a part the buyer already owns
 * is not a discount (it was never charged) and is left out.
 */
export function previewAnswer(preview) {
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

export function orderForIntent(order, { lines = [], adjustments = [], payouts = [], payment = null, titleOf } = {}) {
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
 * One thing the user owns, in words an app can act on. "Delivered" is the copy
 * existing, not the ledger's word for it: a finished delivery with no folder is
 * not a copy the buyer can open.
 */
export const purchaseForIntent = (row) => ({
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
export const sellerProductForIntent = (row) => ({
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
export const sellerProductForDisplay = (row) => ({
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
export function nestItemRows(rows, toNode) {
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
export const productItemsToIntent = (rows) => nestItemRows(rows, (row, childrenOf) => {
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
export const productContentsForDisplay = (rows, products = [], { delivered = false } = {}) => {
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
export function productItemsFromIntent(items) {
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
export const asBundlePrice = (input) => {
  if (input.priceAmount === undefined) return input;
  const fee = Number(input.priceAmount) || 0;
  return { ...input, priceAmount: 0, curatorFeeType: fee > 0 ? 'fixed' : null, curatorFeeValue: fee > 0 ? fee : null };
};

export const includesProducts = (wireItems) => wireItems.some((item) => item.type === 'product' || item.childProductId || item.child_product_id);

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
export const profileNameOf = (user) => {
  const name = [user?.firstName, user?.lastName]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ');
  return name || null;
};

/** One store row -> what an app needs to draw the setup checklist and the donation editor, or null. */
export const storeRowForIntent = (row) => {
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
export const storeForIntent = ({ store, user, memberCount, policy, networkId }) => {
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
export const networkAccessForIntent = (row) => ({
  networkId: row?.network_id ?? null,
  status: row?.status ?? null,
  requestedAt: row?.requested_at ?? null,
  decidedAt: row?.decided_at ?? null,
  note: row?.note ?? null,
  message: row?.message ?? null,
});

/** `promotions.list` hands back raw rows, snake_case; this is the one place that states their columns. */
export const mapSaleRow = (row) => ({
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

export const mapTierRow = (row) => ({
  id: row?.id,
  storeId: row?.store_id,
  minItems: row?.min_items,
  percentOff: row?.percent_off,
  status: row?.status,
  createdAt: row?.created_at,
  updatedAt: row?.updated_at,
});

export const mapCodeRow = (row) => ({
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
