// ===========================================================================
// Commerce — 10 functions, channel `valuguru`. The other 3 are application intents.
//
// THE RULE THIS FILE EXISTS FOR, carried over from CommerceService: the
// calling application is the one the RUNTIME stamped on the call — `ctx.
// applicationId` — never an id in the params. A framed app must not be able to
// list, sell or buy as another app, and the params are the one thing it fully
// controls. A runtime that cannot name the caller gets 403, and that is the
// whole of the check: there is nothing to fall back to.
//
// Money stays on the server. These functions forward ids and quantities; the
// backend prices, validates and settles. Paying is deliberately NOT here — the
// buyer scans a QR — so neither an embedded app nor a model can complete a
// purchase on somebody's behalf.
// ===========================================================================
import { ok, fail, guru, str, num, ids, invalid } from './support.js';
import { ERROR_CODES } from '../../Errors.js';
import {
  productItemsFromIntent, productItemsToIntent, sellerProductForIntent,
  isEditableProduct, includesProducts, asBundlePrice, productInput,
} from './commerceItems.js';

/** The calling application, or the 403 that says it could not be identified. */
function callerApp(ctx) {
  const appId = ctx.applicationId;
  if (!appId) {
    return {
      ack: fail(
        ERROR_CODES.FORBIDDEN,
        'the calling application could not be identified, so this commerce action was refused',
        'Commerce scopes every catalogue read and write to the app the RUNTIME stamped on the call. '
        + 'Pass { applicationId } to the SocketTransport; it is never taken from params.',
      ),
    };
  }
  return { appId };
}

export function register(registry) {
  registry
    .define('Commerce.list-products', (params, ctx) => {
      const { appId, ack } = callerApp(ctx);
      if (ack) return ack;
      return guru(ctx, 'valuguru.commerce.catalog.search', {
        appId,
        query: params.query,
        category: params.category,
        tag: params.tag,
        attributes: params.attributes,
        sort: params.sort,
        limit: params.limit,
        offset: params.offset,
      }, (data) => ({
        products: Array.isArray(data.products) ? data.products : [],
        nextOffset: data.nextOffset ?? null,
      }));
    })

    .define('Commerce.get-product', (params, ctx) => {
      const { appId, ack } = callerApp(ctx);
      if (ack) return ack;
      return guru(ctx, 'valuguru.commerce.catalog.get', { productId: str(params.productId), appId });
    })

    // Served rather than hardcoded so a seller's picker and the buyer's chips
    // cannot disagree with what `products.create` accepts.
    .define('Commerce.list-categories', (params, ctx) =>
      guru(ctx, 'valuguru.commerce.catalog.categories', {},
        (data) => ({ categories: Array.isArray(data.categories) ? data.categories : [] })))

    .define('Commerce.add-to-cart', (params, ctx) => {
      const { appId, ack } = callerApp(ctx);
      if (ack) return ack;
      return guru(ctx, 'valuguru.commerce.cart.add', {
        productId: str(params.productId),
        appId,
        qty: num(params.qty, 1),
      }, (data) => ({ items: Array.isArray(data.items) ? data.items : [] }));
    })

    .define('Commerce.check-entitlements', (params, ctx) =>
      guru(ctx, 'valuguru.commerce.entitlements.check', { productIds: ids(params.productIds) },
        (data) => ({ entitlements: data && typeof data === 'object' ? data : {} })))

    // The WHOLE cart, not this app's rows: the buyer checks out one cart in one
    // scan, so a count an app shows has to be the count they will pay for.
    .define('Commerce.get-cart', (params, ctx) =>
      guru(ctx, 'valuguru.commerce.cart.get', {}, (data) => {
        const items = Array.isArray(data.items) ? data.items : [];
        return { items, count: items.filter((i) => !i.savedForLater).length };
      }))

    // A DRAFT, and never more. Publishing decides money and where a thing
    // sells; there is no confirmation gate in tool dispatch, so that decision
    // stays with the seller in the Merchant Console.
    .define('Commerce.create-product', async (params, ctx) => {
      const title = str(params.title).trim();
      if (!title) {
        // The app's other path opens the platform's create-product FORM, which
        // is an application surface with no SDK equivalent. Say which one is missing.
        return fail(
          ERROR_CODES.UNSUPPORTED,
          'create-product without a title opens the platform\'s create-product form, which is an application surface',
          'Pass a title (and any other fields) to create the draft directly, or open the form through the frame bridge.',
        );
      }
      const input = productInput({ ...params, title });
      const items = productItemsFromIntent(params.items);

      const created = await guru(ctx, 'valuguru.commerce.products.create',
        includesProducts(items) ? asBundlePrice(input) : input);
      if (created.error) return created;
      const product = created.data?.product ?? created.data ?? null;

      if (items.length > 0 && product?.id) {
        const set = await guru(ctx, 'valuguru.commerce.products.items.set', { productId: product.id, items });
        // The row exists either way: naming it matters, because the caller now
        // has an empty draft rather than nothing.
        if (set.error) {
          return { error: { ...set.error, description: `the draft "${title}" (${product.id}) was created, but its content was not set: ${set.error.description ?? set.error.message}` } };
        }
      }
      return ok({ product: sellerProductForIntent(product) ?? product });
    })

    // The seller's own catalogue — drafts included, which the buyer's shelf
    // never shows.
    .define('Commerce.list-my-products', (params, ctx) =>
      guru(ctx, 'valuguru.commerce.products.list', {
        status: params.status,
        limit: params.limit,
      }, (data) => (data.store
        ? { hasStore: true, products: (data.products ?? []).map(sellerProductForIntent) }
        : { hasStore: false, products: [] })))

    // One of them WITH its content, in the shape update-product takes back.
    .define('Commerce.get-my-product', async (params, ctx) => {
      const productId = str(params.productId);
      const [detail, tree] = await Promise.all([
        guru(ctx, 'valuguru.commerce.products.get', { productId }),
        guru(ctx, 'valuguru.commerce.products.items.get', { productId }),
      ]);
      if (detail.error) return detail;
      if (tree.error) return tree;
      return ok({
        product: sellerProductForIntent(detail.data?.product ?? detail.data),
        items: productItemsToIntent(tree.data?.items ?? []),
      });
    })

    .define('Commerce.update-product', async (params, ctx) => {
      const productId = str(params.productId).trim();
      if (!productId) return invalid('productId is required');

      const input = productInput(params);
      // "Unlimited" is a null stock, which a schema typed `number` cannot
      // carry — hence its own flag.
      if (params.unlimitedStock === true) input.stock = null;

      const hasItems = params.items !== undefined;
      const items = hasItems ? productItemsFromIntent(params.items) : [];
      // `items` REPLACES the content, so an empty list is refused rather than
      // obeyed: a caller that meant to add one file and sent none must not
      // empty the product.
      if (hasItems && items.length === 0) {
        return invalid('items would leave the product with no content; omit items to keep the current content');
      }
      if (Object.keys(input).length === 0 && !hasItems) return invalid('nothing to update');

      // Read the status FIRST, so a refusal changes nothing.
      const current = await guru(ctx, 'valuguru.commerce.products.get', { productId });
      if (current.error) return current;
      const row = current.data?.product ?? current.data;
      if (!isEditableProduct(row)) {
        return fail(ERROR_CODES.FORBIDDEN,
          row?.status === 'active'
            ? 'this product is on sale, so its version is frozen for buyers'
            : `a ${row?.status ?? 'missing'} product cannot be edited; only drafts can`,
          'Unlisting is the seller\'s decision and is not taken here — it returns the product to a draft.');
      }

      // Is it a bundle? What is being SENT decides when there is content;
      // otherwise the draft's own tree does — and that is read only when a
      // price is actually being set.
      let patch = input;
      if (input.priceAmount !== undefined) {
        let tree = items;
        if (!hasItems) {
          const existing = await guru(ctx, 'valuguru.commerce.products.items.get', { productId });
          if (existing.error) return existing;
          tree = existing.data?.items ?? [];
        }
        if (includesProducts(tree)) patch = asBundlePrice(input);
      }

      let product = row;
      if (Object.keys(patch).length > 0) {
        const updated = await guru(ctx, 'valuguru.commerce.products.update', { productId, ...patch });
        if (updated.error) return updated;
        product = updated.data?.product ?? updated.data ?? product;
      }
      if (hasItems) {
        const set = await guru(ctx, 'valuguru.commerce.products.items.set', { productId, items });
        if (set.error) return set;
      }
      return ok({ product: sellerProductForIntent(product) });
    });

  return registry;
}
