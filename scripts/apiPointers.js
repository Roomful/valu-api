// ===========================================================================
// The API-pointer surface of valusocial-web, vendored.
//
// API pointers are the OLDER way through the host: `api:create-pointer` names
// a module, `api:run` calls a function on it by string. This package gives
// them no catalogue and no per-function method — `ValuApi.getApi()` is the
// whole of it — which is exactly why they need writing down somewhere.
//
// Vendored for the same reason the service manifest is: docs/api-pointers.md
// must build without the app repo present. `npm run measure:api-pointers`
// checks this file against a real checkout and exits non-zero the moment the
// app registers, renames or drops one.
//
//   module   the name `getApi(name)` takes, and the aliases that also resolve
//   fn       the string `run(fn, params)` takes
//   arg      its ONE parameter, as the app declares it. APIBridge refuses a
//            function of more than one parameter, and some take a bare value
//            where others take an object — there is no convention, which is
//            half the argument for the typed surface.
//   sdk      the declared function that covers it, or null
//   via      'same'  the SDK function does the same work, usually the same RPC
//            'close' a declared function is adjacent but not equivalent — the
//                    note says how, and the difference has bitten somebody
//            null    no declared intent: the pointer is the only way
// ===========================================================================

/** @typedef {{fn: string, arg: string, does: string, sdk: string|null, via: 'same'|'close'|null, note?: string}} PointerFn */

/** @type {{module: string, file: string, aliases: string[], summary: string, functions: PointerFn[]}[]} */
export const API_POINTER_MODULES = [
  {
    module: 'app',
    file: 'src/Stores/ApplicationCenter/ApplicationCenterStoreAPI.js',
    aliases: [],
    summary: 'The application dock: what is installed, what is open, and how a pane behaves.',
    functions: [
      { fn: 'open', arg: 'applicationId', does: 'Open an application in the dock.', sdk: 'AiGuru.open', via: 'same' },
      { fn: 'close', arg: 'applicationId', does: 'Close an open application.', sdk: 'AiGuru.close', via: 'same', note: 'The declared `Application.close-application` closes the CALLER; this closes whichever id you name.' },
      { fn: 'expand', arg: 'applicationId', does: 'Expand an application pane.', sdk: 'Application.expand-application', via: 'close', note: 'The declared intent expands the caller and takes no id.' },
      { fn: 'hasApplication', arg: 'applicationId', does: 'Whether the dock knows this application at all.', sdk: 'AiGuru.has-application', via: 'same' },
      { fn: 'isApplicationLoaded', arg: 'applicationId', does: 'Whether it is loaded right now — a different question.', sdk: 'AiGuru.is-application-loaded', via: 'same' },
      { fn: 'getApplications', arg: '()', does: 'Every application the dock can open, with id, slug and icon.', sdk: 'AiGuru.get-applications', via: 'same' },
      { fn: 'getApplicationHeader', arg: 'applicationId', does: "An application's title and a glyph already drawn with the platform font, for a page on another origin that cannot draw a Font Awesome class.", sdk: null, via: null },
      { fn: 'getSetting', arg: 'key', does: 'Read one platform setting by key.', sdk: null, via: null },
      { fn: 'navigate', arg: '{path}', does: 'Navigate the host router.', sdk: null, via: null, note: '`api.pushRoute(path)` / `api.replaceRoute(path)` do this over `api:run-command`, which is a bridge command rather than a declared intent.' },
      { fn: 'run', arg: '{applicationId, action, params}', does: 'Run an intent against another application.', sdk: null, via: null, note: '`api.sendIntent(intent)` is the typed form, over `api:run-intent`.' },
      { fn: 'configure-intent', arg: '{...}', does: "Open the host's intent-configuration modal.", sdk: null, via: null },
      { fn: 'notifyApplicationStateUpdated', arg: '{applicationId, intent}', does: 'Tell the dock an application\'s state changed, so it can re-render its entry.', sdk: null, via: null },
      { fn: 'blockExternalLinks', arg: 'block', does: 'Stop the host opening external links from this app.', sdk: null, via: null },
      { fn: 'overriderAppLoading', arg: '()', does: 'Take over the application loading indicator.', sdk: null, via: null },
      { fn: 'overriderPopupLoading', arg: '()', does: 'Take over the popup loading indicator.', sdk: null, via: null },
    ],
  },
  {
    module: 'users',
    file: 'src/Stores/Application/UsersAPI.js',
    aliases: ['u'],
    summary: 'People: identity, connections, following.',
    functions: [
      { fn: 'current', arg: '()', does: 'The signed-in user.', sdk: 'Users.current', via: 'same', note: "The pointer returns the store's `baseUser`; the SDK resolves the socket's own id through `social:getUsersSimpleInfo`, because headless there is no store." },
      { fn: 'get', arg: 'userId', does: 'One user model by id.', sdk: 'Users.get', via: 'same', note: 'Same RPC (`social:getUsersSimpleInfo`). The pointer takes a bare string; the SDK takes `{userId}`.' },
      { fn: 'getMany', arg: 'userIds', does: 'Several user models in one call.', sdk: null, via: null, note: 'The RPC accepts a list of ids; the declared `Users.get` only asks for one. A batch read is a Phase 3 candidate.' },
      { fn: 'getIcon', arg: '{userId, size}', does: "A user's avatar URL at a size, from the host's URL cache.", sdk: null, via: null },
      { fn: 'getExtended', arg: 'userId', does: 'The extended profile (`social:getUserProfileInfo`).', sdk: null, via: null },
      { fn: 'getLocator', arg: 'userId', does: "Where the user is — the locator record (`social:getUserLocator`).", sdk: null, via: null },
      { fn: 'requestFriendship', arg: 'userId', does: 'Send a connection request.', sdk: 'Users.send-connection-request', via: 'same' },
      { fn: 'cancelFriendshipRequest', arg: 'userId', does: 'Withdraw one you sent.', sdk: 'Users.cancel-connection-request', via: 'same' },
      { fn: 'acceptFriendRequest', arg: 'userId', does: 'Accept one you received.', sdk: 'Users.accept-connection-request', via: 'same' },
      { fn: 'declineFriendRequest', arg: 'userId', does: 'Decline one you received.', sdk: 'Users.decline-connection-request', via: 'same' },
      { fn: 'deleteFriend', arg: 'userId', does: 'Remove an existing connection (`social:deleteFriend`).', sdk: null, via: null, note: 'The manifest declares the four request transitions and not the removal, so an agent can connect people and cannot disconnect them.' },
      { fn: 'getFollowersCount', arg: 'userId', does: 'How many followers a user has, or null when it cannot be read.', sdk: 'Users.search-users', via: 'close', note: 'Same RPC (`social:searchUserFollowers`), but the declared function answers a page of users; the count is in the response the SDK discards.' },
      { fn: 'follow', arg: 'userId', does: 'Follow a user (`social:followUser`).', sdk: null, via: null },
      { fn: 'unfollow', arg: 'userId', does: 'Unfollow a user (`social:unfollowUser`).', sdk: null, via: null },
    ],
  },
  {
    module: 'rooms',
    file: 'src/Applications/RoomsApplication/Stores/RoomsApi.js',
    aliases: [],
    summary: 'Rooms: their model, their permissions, joining and leaving.',
    functions: [
      { fn: 'getMeta', arg: '{roomId, networkId?}', does: 'The basic room model.', sdk: 'Rooms.get-room', via: 'same', note: 'Same RPC (`room:getRoomBasicModel`).' },
      { fn: 'getFullModel', arg: '{roomId, networkId?}', does: 'The full room model — metadata, settings, stories.', sdk: 'Rooms.get-room', via: 'close', note: 'A different RPC (`room:getRoom`). The declared function answers the BASIC model; the full one is read inside the SDK only, by the prop-order logic.' },
      { fn: 'getPermissions', arg: '{roomId}', does: "The caller's permissions in a room.", sdk: 'Rooms.get-permissions', via: 'same', note: 'Same RPC (`room:permissions`).' },
      { fn: 'getRoomPermissions', arg: '{roomId}', does: 'The same thing again.', sdk: 'Rooms.get-permissions', via: 'same', note: 'A duplicate of `getPermissions` — both emit `room:permissions`.' },
      { fn: 'getIcon', arg: '{roomId, size}', does: "A room's icon URL at a size.", sdk: null, via: null },
      { fn: 'updateMeta', arg: '{roomBuilder}', does: 'Change room metadata (`room:updateMetadata`).', sdk: null, via: null, note: 'Takes a live `RoomBuilder` instance, which cannot cross the bridge as JSON — so this one is host-internal in practice.' },
      { fn: 'join', arg: '{roomId}', does: 'Join a room.', sdk: null, via: null },
      { fn: 'leave', arg: '{roomId}', does: 'Leave a room.', sdk: null, via: null },
      { fn: 'openRoomCard', arg: '{e, roomId}', does: "Open the host's room card, anchored to a click event.", sdk: null, via: null, note: 'Host UI, and it takes a DOM event — not something a socket could serve.' },
    ],
  },
  {
    module: 'resources',
    file: 'src/Services/Resources/ResourceService.js',
    aliases: [],
    summary: 'Resources: the record, its URLs, its thumbnails.',
    functions: [
      { fn: 'getResource', arg: '{resourceId, forceUpdate?}', does: 'The resource record itself, from the host cache or the server.', sdk: null, via: null },
      { fn: 'invalidateResource', arg: 'resourceId', does: "Drop the host's cached copy.", sdk: null, via: null },
      { fn: 'getResourcePath', arg: '{resourceId}', does: 'The storage path of a resource.', sdk: null, via: null },
      { fn: 'getThumbnailUrl', arg: '{resourceId, thumbnailSize?}', does: 'A thumbnail URL, with the decryption metadata an encrypted resource needs.', sdk: 'Resources.get-thumbnail-url', via: 'close', note: 'The declared function BUILDS the URL locally (as the server does) and therefore has no decryption metadata — a known delta, recorded in parity.md. For an encrypted resource the pointer is still the only complete answer.' },
      { fn: 'getResourceUrl', arg: '{resourceId}', does: 'The public URL of a resource.', sdk: 'Resources.generate-public-url', via: 'close', note: 'The declared function builds the URL from `config.webBase`; this one goes through the host service.' },
      { fn: 'listBotAvatars', arg: '{limit?}', does: "The network's allowed bot avatars.", sdk: 'Resources.list-bot-avatars', via: 'same' },
    ],
  },
  {
    module: 'network',
    file: 'src/Stores/Application/NetworksAPI.js',
    aliases: [],
    summary: 'Which network the session is in, and moving between them.',
    functions: [
      { fn: 'id', arg: '()', does: 'The current network id, straight from the store.', sdk: 'Networks.get-current-network', via: 'close', note: 'The declared function answers `{networkId, name}` — the id is a fact of the connection, and only the name costs an RPC.' },
      { fn: 'get', arg: 'networkId', does: "Network info for the current user (`network:getNetworkInfoForUser`).", sdk: 'Networks.get-current-network', via: 'close', note: 'Same RPC, but the declared function only ever asks about the CURRENT network.' },
      { fn: 'switch', arg: 'networkId', does: 'Switch the session to another network.', sdk: null, via: null, note: 'Changes the session every other call is scoped by. Nothing in the declared surface can do this, deliberately.' },
      { fn: 'switchForRoom', arg: 'roomId', does: "Switch to whichever network a room belongs to, if it is not the current one.", sdk: null, via: null },
      { fn: 'overrideNetworkSwitch', arg: '()', does: 'Take over the network-switch flow.', sdk: null, via: null },
      { fn: 'startNewNetworkSession', arg: '{oldNetworkId, networkId, sessionId}', does: 'Adopt a session an external system created after switching networks.', sdk: null, via: null },
    ],
  },
  {
    module: 'text-chat',
    file: 'src/Applications/TextChatApplication/Stores/TextChatAPI.js',
    aliases: ['chat'],
    summary: 'Resolving a chat channel, and the encryption scope around it.',
    functions: [
      { fn: 'getChannel', arg: 'channelId', does: 'One channel by id.', sdk: null, via: null, note: 'The declared TextChat functions read and write MESSAGES and take a channelId; resolving the channel itself is only here.' },
      { fn: 'getChannelByRoomId', arg: 'roomId', does: "A room's default channel.", sdk: null, via: null },
      { fn: 'getRoomOpenAIChannel', arg: 'roomId', does: "The room's AI channel.", sdk: null, via: null },
      { fn: 'crypto', arg: '()', does: 'Run the cryptography self-test.', sdk: null, via: null },
      { fn: 'cryptoClearScope', arg: '()', does: 'Clear the encryption scope.', sdk: null, via: null },
    ],
  },
  {
    module: 'ux',
    file: 'src/Stores/UX/UXAPI.js',
    aliases: [],
    summary: 'Theme and layout of the surface your iframe is drawn on.',
    functions: [
      { fn: 'colorScheme', arg: '()', does: "The host's current colour scheme, so an embedded page can match it.", sdk: null, via: null },
      { fn: 'toggleColorScheme', arg: '()', does: 'Toggle light/dark.', sdk: null, via: null },
      { fn: 'triggerResize', arg: 'data', does: 'Ask the host to re-measure and resize the frame.', sdk: null, via: null, note: 'Nothing in the declared surface resizes a frame; an embedded page that grows has no other way to say so.' },
    ],
  },
  {
    module: 'dialog',
    file: 'src/Stores/Modal/ModalStoreAPI.js',
    aliases: ['d'],
    summary: "The host's modal stack.",
    functions: [
      { fn: 'open', arg: '{modalName, modalData}', does: 'Open a named host modal and, for the prompt modals, resolve its result.', sdk: null, via: null, note: 'Not the same as `DataProvider.pick-single`: that is a declared picker with declared params, this opens any modal the host knows by name.' },
      { fn: 'close', arg: 'modalName', does: 'Close one.', sdk: null, via: null },
    ],
  },
  {
    module: 'auth',
    file: 'src/Stores/Auth/AuthApi.js',
    aliases: ['chat'],
    summary: 'The one authentication action exposed to an app.',
    functions: [
      { fn: 'logout', arg: '()', does: 'Log the user out of the platform.', sdk: null, via: null, note: 'Nothing in the declared surface ends a session, and nothing should — but this is how it is done today.' },
    ],
  },
  {
    module: 'crypto',
    file: 'src/Applications/TextChatApplication/Cryptography/CryptographyAPI.js',
    aliases: [],
    summary: 'The text-chat encryption seed.',
    functions: [
      { fn: 'setSeed', arg: '{seed}', does: 'Hand the host the seed its message encryption derives keys from.', sdk: null, via: null, note: 'Key material. It is browser-only on purpose, and it is why the SDK neither encrypts nor decrypts TextChat bodies (parity.md).' },
    ],
  },
  {
    module: 'videochat',
    file: 'src/Applications/VideochatApplication/Stores/VideochatApi.js',
    aliases: ['v'],
    summary: 'Whether a call is running.',
    functions: [
      { fn: 'getStatus', arg: '{videochatId, roomId, propId, playgroundId, groupId}', does: 'The state of a video call, addressed by any of five ids.', sdk: null, via: null },
    ],
  },
];

/**
 * A second module declares the SAME `dialog` name and the same two functions:
 * `src/Services/UnityDialog/UnityDialogApi.js`, over `UnityDialogService`.
 * `APIBridge.createAPi` throws on a duplicate name, so at most one of the two
 * is ever live — which one depends on how the app is composed, and the
 * inventory above counts the pair once.
 */
export const DUPLICATE_DECLARATIONS = [
  {
    module: 'dialog',
    file: 'src/Services/UnityDialog/UnityDialogApi.js',
    aliases: ['d'],
    functions: ['open', 'close'],
  },
];

/** Every pointer function, flat. */
export const API_POINTER_FUNCTIONS = API_POINTER_MODULES.flatMap(
  (m) => m.functions.map((f) => ({ ...f, module: m.module })),
);

/** Counted, not estimated — the doc quotes these. */
export const pointerSummary = () => {
  const fns = API_POINTER_FUNCTIONS;
  return {
    modules: API_POINTER_MODULES.length,
    functions: fns.length,
    declarations: fns.length + DUPLICATE_DECLARATIONS.reduce((n, d) => n + d.functions.length, 0),
    same: fns.filter((f) => f.via === 'same').length,
    close: fns.filter((f) => f.via === 'close').length,
    only: fns.filter((f) => !f.via).length,
  };
};
