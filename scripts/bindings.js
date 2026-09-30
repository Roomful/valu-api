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
// them: this package is a library of socket functions, so an intent only the
// application can serve gets no descriptor, no method and no tool definition.
// It is still reachable — by name, over the postMessage bridge, like any other
// intent the application registers (docs/api-pointers.md). That is the whole
// argument for not declaring it here: the application's registry is the
// authority and it moves without this package.
//
// Counts asserted by test/catalog.test.js — 77 catalogue functions from the
// manifest (92 declared − 15 application-only) + 1 this package declares.
// ===========================================================================

/**
 * Declared intents this package does NOT put in its catalogue.
 *
 * No RPC serves any of them: they are window management, pickers that render
 * application UI, and reads of the application's own memory. A socket cannot
 * answer one, so a function here would be a method that fails everywhere this
 * library is meant to run.
 *
 * Kept as a list (rather than deleted) for three reasons: the generator
 * excludes by it, docs/api-pointers.md prints it so a frame app can see what
 * to ask for, and test/catalog.test.js fails when the app declares a NEW
 * intent that is on neither side — a new intent must be classified, never
 * silently dropped.
 */
export const APPLICATION_ONLY = [
  // The app dock / AI Guru surface — window management, not data.
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
  // "open" = navigate the application to a screen.
  'Commerce.open-cart',
  'Commerce.open-purchases',
  'Commerce.open-products',
];

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
