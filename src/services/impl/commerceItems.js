// ===========================================================================
// A product's content, both ways.
//
// Vendored from valusocial-web/src/Services/Commerce/{productItemsFromIntent,
// sellerProductForIntent}.js — pure, no store, no transport. They are the
// reason `get-my-product` → edit → `update-product` is a round trip a caller
// can actually make: the read answers in the same vocabulary the write takes.
//
// The seller's ops speak raw database rows (snake_case, items linked by parent
// id). Nothing else in the SDK should have to know that.
// ===========================================================================

/**
 * The intent's description of a product's content → the `ItemInput[]` wire.
 *
 *   items: [
 *     "res_1",                                    // a file, by id
 *     {resourceId: "res_2", title: "Lesson 1"},   // a file, named
 *     {folder: "Unit 1", items: [ … ]},           // a folder holding more
 *     {productId: "prd_9"},                       // another product (a bundle)
 *   ]
 *
 * Refs and parent links are minted in pre-order, which is the order the server
 * walks. Ownership, kinds and cycles are the server's to refuse.
 */
export const productItemsFromIntent = (items) => {
  const out = [];
  let n = 0;
  const walk = (list, parentRef) => {
    for (const entry of Array.isArray(list) ? list : []) {
      const ref = `i${++n}`;
      const item = typeof entry === 'string' ? { resourceId: entry } : entry;
      if (!item || typeof item !== 'object') continue;

      if (item.folder !== undefined) {
        out.push({ ref, type: 'folder', parentRef, title: String(item.folder || 'Folder') });
        walk(item.items, ref);
        continue;
      }
      if (item.productId) {
        out.push({ ref, type: 'product', parentRef, childProductId: String(item.productId), ...(item.title ? { title: String(item.title) } : {}) });
        continue;
      }
      if (item.resourceId) {
        out.push({
          ref,
          type: 'resource',
          parentRef,
          resourceId: String(item.resourceId),
          // A file unless told otherwise; a folder RESOURCE is expanded into
          // its contents at publish time.
          resourceKind: item.kind === 'folder' || item.kind === 'link' ? item.kind : 'file',
          ...(item.title ? { title: String(item.title) } : {}),
        });
      }
      // Anything else says nothing the server could act on and is dropped; the
      // server's own "needs at least one item" answers an empty list.
    }
  };
  walk(items, null);
  return out;
};

/** Only a DRAFT is editable: a live version is frozen for the buyers who hold it. */
export const isEditableProduct = (product) => product?.status === 'draft';

/** A raw seller row → the camelCase fields create/update-product accept. */
export const sellerProductForIntent = (row) => (row ? {
  id: row.id,
  title: row.title,
  description: row.description ?? null,
  status: row.status,
  priceAmount: Number(row.price_amount ?? row.priceAmount ?? 0),
  priceCurrency: row.price_currency ?? row.priceCurrency ?? 'VRSC',
  // null is "unlimited", not "none left" — said the way the params take it.
  stock: row.stock ?? null,
  category: row.category ?? null,
  tags: Array.isArray(row.tags) ? row.tags : [],
  imageResourceId: row.image_resource_id ?? row.imageResourceId ?? null,
  ...(row.content_count != null ? { contentCount: Number(row.content_count) } : {}),
  ...(row.sold_count != null ? { soldCount: Number(row.sold_count) } : {}),
  editable: isEditableProduct(row),
} : null);

/** Flat item rows → the nested intent shape. The inverse of the above. */
export const productItemsToIntent = (rows) => {
  const children = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = row.parent_item_id ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(row);
  }
  const build = (parentId) => (children.get(parentId) ?? [])
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((row) => {
      if (row.item_type === 'folder') return { folder: row.title || 'Folder', items: build(row.id) };
      if (row.item_type === 'product') {
        return { productId: row.child_product_id, ...(row.title ? { title: row.title } : {}) };
      }
      return {
        resourceId: row.resource_id,
        ...(row.title ? { title: row.title } : {}),
        ...(row.resource_kind && row.resource_kind !== 'file' ? { kind: row.resource_kind } : {}),
      };
    });
  return build(null);
};

/** True when a content tree includes another PRODUCT — i.e. it is a bundle. */
export const includesProducts = (items) =>
  items.some((item) => item.type === 'product' || item.childProductId || item.child_product_id);

/**
 * A bundle's own price is not a price — the server charges its parts plus a
 * fixed curator fee (pricing.ts) and IGNORES the bundle's `priceAmount`. So a
 * caller's amount becomes that fee, the same translation the Merchant
 * Console's form makes, rather than a number that is silently never charged.
 */
export const asBundlePrice = (input) => {
  if (input.priceAmount === undefined) return input;
  const amount = Number(input.priceAmount) || 0;
  return {
    ...input,
    priceAmount: 0,
    curatorFeeType: amount > 0 ? 'fixed' : null,
    curatorFeeValue: amount > 0 ? amount : null,
  };
};

/** The fields a create/update carries through to the server, when given. */
export const PRODUCT_FIELDS = [
  'title', 'description', 'priceAmount', 'priceCurrency', 'category', 'tags',
  'imageResourceId', 'stock',
];

/** Only the product fields the caller actually set. */
export const productInput = (params) => {
  const input = {};
  for (const key of PRODUCT_FIELDS) if (params[key] !== undefined) input[key] = params[key];
  return input;
};
