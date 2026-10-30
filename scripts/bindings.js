// ===========================================================================
// Bindings — the decisions the manifest does not carry.
//
// SERVICE_MANIFESTS says what a service declares. It does not say HOW a
// declared intent is served: over a socket, computed locally, or only by the
// Valu Social application itself. Nor does it say whether a call mutates
// state, which is what decides the cache and retry policy. Those are
// decisions; they live here, in one table, and the generator stamps them onto
// every descriptor.
//
// APPLICATION_ONLY is the one that REMOVES functions rather than labelling
// them: this package is a library of Roomful-socket functions, so an intent
// this package cannot run over that one connection gets no descriptor, no
// method and no tool definition. It is still reachable — by name, over the
// postMessage bridge, like any other intent the application registers
// (docs/api-pointers.md). That is the whole argument for not declaring it
// here: the application's registry is the authority and it moves without this
// package.
//
// Counts asserted by test/catalog.test.js — 64 catalogue functions from the
// manifest (133 declared − 69 the application serves itself) + 1 this package
// declares.
// ===========================================================================

/**
 * Declared intents this package does NOT put in its catalogue, grouped by the
 * reason it does not.
 *
 * Three reasons, and they are different enough to be worth separating:
 *
 *   no-rpc      nothing can answer them but the application process itself —
 *               window management, pickers and consent dialogs that render
 *               application UI, subscriptions held for the calling frame, reads
 *               of the application's own memory. There is no RPC to call
 *               without the user or the frame.
 *   valu-guru   the Valu Guru server answers them, over ITS socket. This
 *               package is the user-facing library for the Valu platform: it
 *               holds one connection, the Roomful one, and it carries no
 *               knowledge of the Valu Guru server, its op catalogue or its
 *               envelope. The Valu Social application has that connection and
 *               serves these intents over the bridge.
 *   not-ported  the Roomful socket DOES answer them, so each could be a
 *               function here, and none is yet. A descriptor is a promise that
 *               this package runs it; until a port lands with a parity test,
 *               the application serves them. The one reason that is a backlog
 *               rather than a boundary.
 *
 * Every way the intent is still reachable — by name, over the postMessage
 * bridge, like any other intent the application registers
 * (docs/api-pointers.md). That is the whole argument for not declaring it
 * here: the application's registry is the authority and it moves without this
 * package.
 *
 * Kept as a list (rather than deleted) for three reasons: the generator
 * excludes by it, docs/api-pointers.md prints it so a frame app can see what
 * to ask for, and test/catalog.test.js fails when the app declares a NEW
 * intent that is on neither side — a new intent must be classified, never
 * silently dropped.
 */
export const APPLICATION_ONLY_GROUPS = [
  {
    reason: 'no-rpc',
    title: 'Only the application process can answer them',
    why:
      'Nothing but the application process can answer these: they open a dock or one of '
      + 'its screens, draw a picker or a consent dialog the user must answer before anything '
      + 'is written, hold an event subscription for the calling frame, or read the '
      + "application's own memory. A function here would be a method that fails "
      + 'everywhere this library is meant to run.',
    keys: [
      // The app dock surface — window management, not data.
      'AiGuru.open',
      'AiGuru.close',
      'AiGuru.has-application',
      'AiGuru.get-applications',
      'AiGuru.is-application-loaded',
      // Application lifecycle — the frame asking the app about the frame.
      'Application.get-identity-token',
      'Application.close_all',
      'Application.expand-application',
      'Application.close-application',
      // Pickers: they render application UI and return the user's choice.
      'DataProvider.pick-single',
      'DataProvider.pick-multiple',
      // Reads the application's own log buffer.
      'Logging.get-logs',
      // "open" = navigate the application to a screen, or draw one over the
      // calling app's pane.
      'Commerce.open-cart',
      'Commerce.open-purchases',
      'Commerce.open-products',
      'Commerce.open-order',
      'Commerce.open-purchase-in-media',
      'Commerce.preview-purchase',
      // Payment is My Cart's, always: checkout opens it over the app and
      // resolves when the buyer closes it. No intent pays.
      'Commerce.checkout',
      // Consent dialogs: the host draws them over the calling app's pane and
      // nothing is written until the user answers (update-discount-code asks
      // only when the change is not a pure stop, but it may ask).
      'Commerce.rate-product',
      'Commerce.set-donation-tiers',
      'Commerce.publish-product',
      'Commerce.unlist-product',
      'Commerce.archive-product',
      'Commerce.delete-product',
      'Commerce.set-sale',
      'Commerce.set-volume-tier',
      'Commerce.create-discount-code',
      'Commerce.update-discount-code',
      // Event subscriptions are held for the calling FRAME and delivered as
      // api:trigger posts to it; a caller with no frame is refused.
      'Commerce.subscribe-events',
      'Commerce.unsubscribe-events',
      // The room point editor: opens the application's modal and BLOCKS until
      // the user saves or cancels, as the DataProvider pickers do.
      'RoomPoints.create-room-point',
      'RoomPoints.edit-room-point',
    ],
  },
  {
    reason: 'valu-guru',
    title: 'The Valu Guru server answers them, on its own socket',
    why:
      'These do not ride the Roomful socket at all. Commerce is a catalogue of '
      + '`valuguru.*` ops on the Valu Guru server\'s `data_request` channel '
      + '(valusocial-web src/Services/Commerce/CommerceDataService.js); the knowledge-base '
      + 'query is a typed `rag_search` message on the same channel; the two history reads '
      + "are the Valu Guru chat's own in-memory message lists. A second server, a second "
      + 'envelope and a second auth — and none of it is this package\'s. The Valu Social '
      + 'application holds that connection and serves these intents over the bridge.',
    keys: [
      // valuguru.commerce.* — CommerceDataService.
      'Commerce.add-to-cart',
      'Commerce.check-entitlements',
      'Commerce.create-product',
      'Commerce.get-cart',
      'Commerce.get-my-product',
      'Commerce.get-product',
      'Commerce.list-categories',
      'Commerce.list-my-products',
      'Commerce.list-products',
      'Commerce.update-product',
      // Buyer: purchases, the app's own cart rows, promo preview, display, orders.
      'Commerce.list-purchases',
      'Commerce.get-purchase-contents',
      'Commerce.update-cart-item',
      'Commerce.remove-from-cart',
      'Commerce.clear-cart',
      'Commerce.preview-promo',
      'Commerce.get-display',
      'Commerce.list-orders',
      'Commerce.get-order',
      // Seller: store, network access, products, promotions that only stop a
      // discount, analytics — the writes that need no consent.
      'Commerce.list-seller-products',
      'Commerce.get-my-store',
      'Commerce.create-store',
      'Commerce.list-network-access',
      'Commerce.request-network-access',
      'Commerce.quote-bundle',
      'Commerce.list-promotions',
      'Commerce.end-sale',
      'Commerce.remove-volume-tier',
      'Commerce.delete-discount-code',
      'Commerce.get-analytics',
      // AiGuruService.queryKnowledgeBase -> {type: 'rag_search'}.
      'AiGuru.query-knowledge-base',
      // AiGuruService/AgentsService in-memory session and agent message lists.
      'AiGuru.get-chat-history',
      'AiGuru.get-agent-history',
    ],
  },
  {
    reason: 'not-ported',
    title: 'The Roomful socket answers them, and this package does not yet',
    why:
      'These ride the Roomful socket — `room:getRoom`, `room:addCameraPosition` / '
      + '`room:updateCameraPosition`, `room:deleteCameraPosition` (valusocial-web '
      + 'src/Services/RoomPoints/RoomPointsApi.js) — so each could be a function here, as the '
      + '`Rooms` intents are. None is yet: a function in this catalogue is a promise that the '
      + 'package runs it itself, and these carry the application\'s point normalisation and, '
      + 'for the writes, its room edit-permission check. Until a port lands with a parity '
      + 'test, the Valu Social application serves them over the bridge.',
    keys: [
      'RoomPoints.list-room-points',
      'RoomPoints.save-room-point',
      'RoomPoints.delete-room-point',
    ],
  },
];

/** Every excluded intent, flat — what the generator filters by. */
export const APPLICATION_ONLY = APPLICATION_ONLY_GROUPS.flatMap((g) => g.keys);

/** Why each one is excluded: `'no-rpc'`, `'valu-guru'` or `'not-ported'`. */
export const APPLICATION_ONLY_REASON = Object.fromEntries(
  APPLICATION_ONLY_GROUPS.flatMap((g) => g.keys.map((k) => [k, g.reason])),
);

/** Answered by the SDK itself — no socket, no server. */
export const LOCAL = [
  // Pure URL builders over a resource id + the network's CDN host.
  'Resources.get-thumbnail-url',
  'Resources.generate-public-url',
  'Resources.generate-best-view-url',
  'Resources.generate-direct-public-url',
  // Outbound HTTP from wherever the SDK runs.
  'Http.ping',
  'Http.get',
  'Http.post',
  // The caller's own clock.
  'Time.get-local-time',
];

/**
 * Actions that change state. Everything else is a read: only reads are cached
 * and only reads are retried (see docs/callbacks-policy.md).
 */
const MUTATING_PREFIXES = [
  'create', 'update', 'edit', 'delete', 'remove', 'set', 'add', 'send',
  'message', 'invite', 'join', 'leave', 'paste', 'rename', 'transfer',
  'accept', 'decline', 'cancel', 'upload', 'post',
  'resource-upload', 'resource-delete',
];

/** Explicit overrides where the prefix rule reads the wrong way. */
const MUTATES_OVERRIDE = {
  'Http.post': true,
  'Http.get': false,
  'Http.ping': false,
};

export function mutates(key, action) {
  if (key in MUTATES_OVERRIDE) return MUTATES_OVERRIDE[key];
  return MUTATING_PREFIXES.some((p) => action === p || action.startsWith(`${p}-`));
}

/**
 * Per-function cache policy overrides. The default (see `defaultCache`) is
 * read-through for socket reads and none for everything else.
 *
 * `mode: 'seeded'` means: serve from cache when the caller has seeded it,
 * otherwise go to the socket. The app's VerusWallet.getBalance answers from
 * the store cache and never hits the network (valu-tools/verus.ts records
 * this); the SDK must not silently turn that into a wallet RPC.
 */
export const CACHE_OVERRIDES = {
  'VerusWallet.get-balance': { mode: 'seeded', ttlMs: 15_000, key: 'currency' },
  'Users.current': { mode: 'read-through', ttlMs: 300_000, key: null },
  'Networks.get-current-network': { mode: 'read-through', ttlMs: 300_000, key: null },
};

/** Param names that identify the entity a read is keyed by, in priority order. */
const KEY_PARAMS = [
  'id', 'userId', 'roomId', 'propId', 'groupId', 'communityId', 'channelId',
  'resourceId', 'productId', 'orderId', 'agentId', 'applicationId', 'badgeId',
];

export function defaultCache(key, isMutation, params, channel) {
  if (key in CACHE_OVERRIDES) return CACHE_OVERRIDES[key];
  if (channel === 'local' || isMutation) return { mode: 'none' };
  // Application state is already in memory: caching it buys nothing and costs
  // staleness — a chat history 30 seconds behind is a chat history missing the
  // message the caller asked about. (VerusWallet.get-balance is the exception,
  // and says so in CACHE_OVERRIDES.)
  if (channel === 'app-state') return { mode: 'none' };
  const names = [...params.required, ...params.optional].map((p) => p.name);
  const entityKey = KEY_PARAMS.find((k) => names.includes(k)) ?? null;
  return { mode: 'read-through', ttlMs: 30_000, key: entityKey };
}

/**
 * Server tools that already implement a declared intent, by descriptor key.
 * Phase 2a ports these first — they are already ValuSocket-only and already
 * carry the same service/function split, so the move is mechanical.
 * Source: valu-guru-server/src/valu-tools/*.ts, exact name match.
 */
export const SERVER_TOOLS = [
  'Community.get-channels', 'Community.get-community-info', 'Community.get-posts',
  'Community.search-communities',
  'Events.create-meeting', 'Events.edit-meeting', 'Events.list-events',
  'Groups.list-group-participants', 'Groups.list-groups',
  'Networks.get-current-network',
  'Resources.generate-best-view-url', 'Resources.generate-direct-public-url',
  'Resources.generate-public-url',
  'Rooms.delete-prop-invitation', 'Rooms.get-permissions', 'Rooms.get-prop',
  'Rooms.get-room-props', 'Rooms.invite-to-prop', 'Rooms.list-prop-team-members',
  'Rooms.search-my-rooms', 'Rooms.search-rooms',
  'TextChat.message-owner',
  'Users.accept-connection-request', 'Users.cancel-connection-request',
  'Users.current', 'Users.decline-connection-request', 'Users.find-user',
  'Users.get', 'Users.search-users', 'Users.send-connection-request',
  'VerusWallet.get-balance', 'VerusWallet.transfer',
];

/**
 * Server tools with no declared intent. Phase 2b decides what happens to each;
 * they are listed here so the catalogue can report the gap instead of hiding
 * it.
 */
export const SERVER_ONLY_TOOLS = [
  'service__Torah__corpora',
  'service__Torah__search',
  'service__generate_image',
  'service__Http__curl',
  'service__TextChat__message_user',
  'service__TextChat__send_card',
  'system__get_user_timezone',
];

/**
 * The application-served intents that ARE functions on the tree (the owner's
 * decision, 2026-10-30, docs/superpowers/specs/2026-10-30-typed-intents-mode-
 * parity-design.md in valusocial-web): `valu.Commerce.getCart()`,
 * `valu.Application.expandApplication()`. They stay out of the service
 * catalogue — nothing here runs them; the transport sends them to whoever
 * frames or hosts the app as the intent they always were — and get their own
 * descriptors (`INTENT_DESCRIPTORS`, channel `intent`), each with its scope
 * and a MODE that says what the SDK does at the app's own address:
 *
 *   both             the host serves it (Commerce over Valu Guru, the identity token)
 *   window           it opens a Valu Social window: a Valu Social tab there
 *   embedded-only    it means nothing outside Valu Social: skipped, with a warning
 *   embedded-served  only Valu Social runs it today: `not_available` there (phase 2)
 *
 * The mode is derived (scripts/generate.mjs) from what the host serves and the
 * scope tables; these are the two lists the derivation reads.
 */
export const INTENT_FUNCTION_SERVICES = ['Commerce', 'Application', 'DataProvider', 'RoomPoints'];

/** Overrides of the derived mode: what opens no window and has no meaning at the app's own address. */
export const INTENT_MODE_OVERRIDES = {
  // Paying happens in Valu Social's own cart, on Valu's origin: a window, never a host-served flow.
  'Commerce.checkout': 'window',
  'Application.expand-application': 'embedded-only',
  'Application.close-application': 'embedded-only',
  'Application.close_all': 'embedded-only',
  // The pickers return the user's choice; a window with no way back is not a picker. Until one exists: embedded only.
  'DataProvider.pick-single': 'embedded-only',
  'DataProvider.pick-multiple': 'embedded-only',
};
