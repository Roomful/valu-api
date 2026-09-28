// ===========================================================================
// Bindings — the decisions the manifest does not carry.
//
// SERVICE_MANIFESTS says what a service declares. It does not say HOW a
// declared intent is served: over the socket, computed locally, or handed to
// the host frame. Nor does it say whether a call mutates state, which is what
// decides the cache and retry policy. Those are decisions; they live here, in
// one table, and the generator stamps them onto every descriptor.
//
// Counts asserted by test/catalog.test.js — 92 declared intents = 15 host +
// 8 local + 69 socket.
// ===========================================================================

/** Served by the host frame over the postMessage bridge. Never SDK-able. */
export const HOST_BOUND = [
  // The app dock / AI Guru surface — window management, not data.
  'AiGuru.open',
  'AiGuru.close',
  'AiGuru.has-application',
  'AiGuru.get-applications',
  'AiGuru.is-application-loaded',
  // Frame commands proper (Phase 2d turns these into a named frame API).
  'Application.get-identity-token',
  'Application.close_all',
  'Application.expand-application',
  'Application.close-application',
  // Pickers: they render host UI and return the user's choice.
  'DataProvider.pick-single',
  'DataProvider.pick-multiple',
  // Reads the host's own log buffer.
  'Logging.get-logs',
  // "open" = navigate the host to a screen.
  'Commerce.open-cart',
  'Commerce.open-purchases',
  'Commerce.open-products',
];

/** Answered by the SDK itself — no socket, no host. */
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
  'accept', 'decline', 'cancel', 'upload', 'post', 'open', 'close', 'expand',
  'pick', 'resource-upload', 'resource-delete',
];

/** Explicit overrides where the prefix rule reads the wrong way. */
const MUTATES_OVERRIDE = {
  'Http.post': true,
  'Http.get': false,
  'Http.ping': false,
  // A picker does not mutate platform state, but its result is never cacheable.
  'DataProvider.pick-single': false,
  'DataProvider.pick-multiple': false,
  'Logging.get-logs': false,
};

export function mutates(key, action) {
  if (key in MUTATES_OVERRIDE) return MUTATES_OVERRIDE[key];
  return MUTATING_PREFIXES.some((p) => action === p || action.startsWith(`${p}-`));
}

/**
 * Per-function cache policy overrides. The default (see `defaultCache`) is
 * read-through for socket reads and none for everything else.
 *
 * `mode: 'seeded'` means: serve from cache when the host has seeded it,
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

export function defaultCache(key, binding, isMutation, params, channel) {
  if (key in CACHE_OVERRIDES) return CACHE_OVERRIDES[key];
  if (binding !== 'socket' || isMutation) return { mode: 'none' };
  // Host state is already in memory: caching it buys nothing and costs
  // staleness — a chat history 30 seconds behind is a chat history missing the
  // message the caller asked about. (VerusWallet.get-balance is the exception,
  // and says so in CACHE_OVERRIDES.)
  if (channel === 'host-state') return { mode: 'none' };
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
  'service__system__get_user_timezone',
];
