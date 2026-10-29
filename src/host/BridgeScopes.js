// ===========================================================================
// The scopes of Valu Social's older bridge: what an app framed in Valu Social
// can reach without valu-api's own functions (the owner's decision,
// 2026-10-29: inside Valu Social, too, an app may call only what its
// valu-permissions.json declares).
//
// A framed app can post, besides `api:call`:
//
//   api:service-intent   callService(new Intent(service, action))  → scopeOfServiceIntent
//   api:run-intent       run(new Intent(appId, action))            → scopeOfAppIntent
//   api:create-pointer + api:run   getApi(api).run(command)        → scopeOfApiCommand
//   api:run-console      runConsoleCommand('…')                   → never (no scope boundary)
//
// Every function below answers a scope, or `null`. NULL IS A REFUSAL: what is
// not in these tables is not served to a Developer Portal app once the rule is
// enforced. That is on purpose: the inventory of 2026-10-29 found the older
// bridge reaches the session (`network.startNewNetworkSession`), the chat
// encryption seed (`crypto.setSeed`), sign-out, any modal by name, every
// setting and the console, none of which an app may have.
//
// The scopes are the catalogue's where the same thing is a catalogue function
// (a bridge read of rooms is `rooms:read`), plus the few the bridge needs
// that the catalogue has no word for (`ui:open`, `apps:intent`,
// `networks:write`, `videochat:*`, `hubs:*`, `valuguru:write`, in
// `Permissions.TIER_OF`).
//
// No DOM, no I/O.
// ===========================================================================
import { findDescriptor } from '../services/descriptors.js';
import { scopeOfDescriptor, scopeOfIntent } from './Permissions.js';

const UI = 'ui:open';

const has = (table, key) => typeof key === 'string' && Object.hasOwn(table, key);

/** `scope: [keys]` → `{key: scope}`. */
const byScope = (groups) => Object.freeze(Object.fromEntries(
  Object.entries(groups).flatMap(([scope, keys]) => keys.map((key) => [key, scope])),
));

/**
 * Service intents that are not catalogue functions and not the host's own
 * intents (`Permissions.scopeOfIntent`), by `Service.action`.
 */
const SERVICE_INTENT_SCOPE = byScope({
  [UI]: [
    'DataProvider.pick-single', 'DataProvider.pick-multiple', // the user picks; only the choice comes back
    'Application.close_all', 'Application.expand-application', 'Application.close-application',
    'Commerce.open-cart', 'Commerce.open-order', 'Commerce.open-products', 'Commerce.open-purchases',
    'Commerce.open-purchase-in-media', 'Commerce.preview-purchase',
  ],
  'cms:read': ['CMS.pick-resource'],
  'rooms:read': ['RoomPoints.list-room-points', 'RoomZones.list-room-zones', 'RoomZones.zone-occupancy'],
  'rooms:write': [
    'RoomPoints.create-room-point', 'RoomPoints.edit-room-point', 'RoomPoints.save-room-point',
    'RoomPoints.delete-room-point', 'RoomZones.claim-zone', 'RoomZones.release-zone', 'RoomZones.assign-zone',
  ],
  'commerce:write': ['Commerce.checkout', 'Commerce.rate-product', 'Commerce.mark-purchase-file-seen'],
  'commerce:sell': [
    'Commerce.archive-product', 'Commerce.create-discount-code', 'Commerce.delete-product',
    'Commerce.publish-product', 'Commerce.set-donation-tiers', 'Commerce.set-sale', 'Commerce.set-volume-tier',
    'Commerce.unlist-product', 'Commerce.update-discount-code',
  ],
  'developer:read': ['Developer.list-application-apis', 'Developer.list-my-application-apis'],
});

/**
 * Application intents (`run(new Intent(appId, action))`) by `appId.action`.
 * Opening any app (`open`, the implicit action) is `ui:open` and is not listed.
 */
const APP_INTENT_SCOPE = byScope({
  [UI]: [
    'profile.show-current-user', 'profile.show-user', 'profile.open-profile-with-mode', 'user-card.show',
    'textchat.open-channel', 'textchat.close-channel', 'textchat.get-ui-state', 'textchat.options',
    'textchat.open-room-ai-chat', 'textchat.set-active-filter',
    'videochat.open-source-picker',
    'community.create-post', 'community.create-channel', 'community.open-community', 'community.show-channel',
    'community.show-post',
    'groups.open', 'contacts.show-user-connections', 'events.open-calendar',
    'rooms.open', 'rooms.show-room', 'rooms.invite-to-room',
    'metaverse.set-route', 'metaverse.open-room', 'metaverse.preview-prop',
    'cms.show-chat-channel', 'cms.show-folder', 'cms.show-resource', 'cms.preview-resource', 'cms.show-my-files',
    'cms.show-application-storage', 'cms.show-community-channel', 'cms.show-room-contribution',
    'cms.show-prop-content', 'cms.show-room-content', 'cms.preview-prop-resource', 'cms.edit-prop-resource',
    'cms.show-avatars', 'cms.show-purchase',
    'preview.preview',
    'cart.open-section', 'cart.open-cart', 'cart.open-orders', 'cart.open-purchased', 'cart.open-order',
    'cart.open-product',
    'merchant.open-section', 'merchant.open-products', 'merchant.open-product',
    'games.open', 'puzzles.start-puzzle', 'hubs.open',
    'valuguru.open', 'valuguru.show-agents', 'valuguru.open-chat', 'valuguru.open-agent', 'valuguru.open-chatbot',
    'valuguru.create-chatbot',
    'workspace.open-project', 'workspace.open-session',
  ],
  'textchat:write': ['textchat.share-card', 'textchat.send-message', 'textchat.send-message-with-approve'],
  'videochat:write': ['videochat.connect-to-meeting', 'videochat.leave-meeting'],
  'commerce:write': ['cart.add-to-cart'],
  'hubs:read': ['hubs.agent-people', 'hubs.agent-status', 'hubs.find-people'],
  'hubs:write': ['hubs.enter-room', 'hubs.agent-enter-room', 'hubs.agent-walk-to', 'hubs.agent-say', 'hubs.agent-leave'],
  'valuguru:write': ['valuguru.start-session'],
});

/** The aliases the bridge registers an API under, to its one name. `chat` is text chat's (the auth API's alias is never asked for). */
const API_ALIASES = Object.freeze({ u: 'users', v: 'videochat', d: 'dialog', chat: 'text-chat' });

/** API pointer commands (`getApi(api).run(command)`) by `api.command`, the command in camelCase. */
const API_COMMAND_SCOPE = byScope({
  [UI]: [
    'ux.colorScheme', 'ux.toggleColorScheme', 'ux.triggerResize',
    'app.open', 'app.hasApplication', 'app.getApplications', 'app.getApplicationHeader', 'app.isApplicationLoaded',
    'app.getLoadedApplications', 'app.close', 'app.expand', 'app.navigate',
    'rooms.openRoomCard',
  ],
  'users:read': [
    'users.current', 'users.get', 'users.getIcon', 'users.getMany', 'users.getExtended', 'users.getLocator',
    'users.getFollowersCount',
  ],
  'users:write': [
    'users.requestFriendship', 'users.cancelFriendshipRequest', 'users.acceptFriendRequest',
    'users.declineFriendRequest', 'users.deleteFriend', 'users.follow', 'users.unfollow',
  ],
  'networks:read': ['network.id', 'network.get'],
  'networks:write': ['network.switch', 'network.switchForRoom'],
  'videochat:read': ['videochat.getStatus'],
  'textchat:read': ['text-chat.getChannel', 'text-chat.getChannelByRoomId', 'text-chat.getRoomOpenAIChannel'],
  'rooms:read': ['rooms.getMeta', 'rooms.getFullModel', 'rooms.getIcon', 'rooms.getPermissions', 'rooms.getRoomPermissions'],
  'rooms:write': ['rooms.updateMeta', 'rooms.join', 'rooms.leave', 'app.edit-room-point'],
  'resources:read': [
    'resources.getResource', 'resources.invalidateResource', 'resources.getResourcePath', 'resources.getThumbnailUrl',
    'resources.getResourceUrl', 'resources.listBotAvatars',
  ],
});

/**
 * The scope of a service intent: a catalogue function's, the host's own
 * intents', or the bridge's own table. `null`: not served.
 * @param {string} service e.g. `Rooms`
 * @param {string} action e.g. `search-my-rooms`
 * @returns {string|null}
 */
export function scopeOfServiceIntent(service, action) {
  if (typeof service !== 'string' || typeof action !== 'string') return null;
  const descriptor = findDescriptor(`${service}.${action}`);
  if (descriptor) return scopeOfDescriptor(descriptor);
  const key = `${service}.${action}`;
  return scopeOfIntent(service, action) ?? (has(SERVICE_INTENT_SCOPE, key) ? SERVICE_INTENT_SCOPE[key] : null);
}

/**
 * The scope of an application intent. Opening any app is `ui:open`; any
 * request to an app that is itself a frame (another Developer Portal or iframe
 * app, which decides for itself what it does) is `apps:intent`.
 * @param {string} appId
 * @param {string|null|undefined} action `null`/`undefined`/`open`: open the app.
 * @param {{toFrame?: boolean}} [target] whether the app it goes to is a frame.
 * @returns {string|null}
 */
export function scopeOfAppIntent(appId, action, { toFrame = false } = {}) {
  if (typeof appId !== 'string' || appId === '') return null;
  if (action === undefined || action === null || action === 'open') return UI;
  if (typeof action !== 'string') return null;
  if (toFrame) return 'apps:intent';
  const key = `${appId}.${action}`;
  return has(APP_INTENT_SCOPE, key) ? APP_INTENT_SCOPE[key] : null;
}

/** `get-full-model` → `getFullModel`, the way the bridge itself falls back to camelCase. */
const camel = (name) => name.replace(/[-_]+([a-z0-9])/gi, (_, c) => c.toUpperCase());

/**
 * The scope of an API pointer command. `app.run` is not here: it is an intent,
 * and is scoped as the intent it builds (`scopeOfAppIntent` /
 * `scopeOfServiceIntent`).
 * @param {string} api e.g. `users` (or an alias, `u`)
 * @param {string} command e.g. `getMany` (or `get-many`)
 * @returns {string|null}
 */
export function scopeOfApiCommand(api, command) {
  if (typeof api !== 'string' || typeof command !== 'string' || command === '') return null;
  const name = has(API_ALIASES, api) ? API_ALIASES[api] : api;
  for (const candidate of [command, camel(command)]) {
    const key = `${name}.${candidate}`;
    if (has(API_COMMAND_SCOPE, key)) return API_COMMAND_SCOPE[key];
  }
  return null;
}

/** Every scope these tables can answer, for the lists that must know them (the tiers, the wording). */
export const BRIDGE_SCOPES = Object.freeze([...new Set([
  'apps:intent',
  ...Object.values(SERVICE_INTENT_SCOPE), ...Object.values(APP_INTENT_SCOPE), ...Object.values(API_COMMAND_SCOPE),
])].sort());
