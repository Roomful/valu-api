// ===========================================================================
// Per-function metadata — the channel that serves a function, and the shape it
// answers with.
//
// Phase 1 recorded `binding: socket | local | postmessage`. Writing the
// handlers against the real sources showed that what a handler actually needs
// is WHICH connection answers, and this package now has exactly one:
//
//   roomful     `ValuSocket.emit(ns, payload)` — the Roomful platform socket.
//               54 functions: Users, Rooms, Community, Events, Groups,
//               Networks, TextChat, Cbac, Profile, CMS, ApplicationStorage,
//               Resources.list-bot-avatars, VerusWallet.transfer.
//   app-state   served from state only the process running the application
//               holds — no RPC exists. 3 functions: the two Developer Portal
//               reads/writes (DeveloperPortalStore) and VerusWallet.get-balance
//               (the store's cached balance, which is exactly the case the
//               implementation plan warned about).
//   local       computed by the SDK from configuration, the clock or `fetch`.
//               8 functions.
//
// There is no fourth channel. There used to be `valuguru`, for the Commerce
// catalogue and the knowledge-base search — a SECOND socket, to the Valu Guru
// server, with its own envelope and auth. It is gone: this is the user-facing
// library for the Valu platform, it holds one connection, and it carries no
// knowledge of the Valu Guru server. Those 13 intents are served by the Valu
// Social application over the bridge and are listed in scripts/bindings.js
// under the `valu-guru` reason.
//
// `returns` completes the descriptor: Phase 1 shipped every function with
// `{type: 'unknown'}` and the definition-of-done requires a declared return
// shape per function.
// ===========================================================================

/**
 * Declared functions that no RPC serves: the answer lives in application state.
 *
 * The manifest declares them like any other intent — but a socket cannot
 * answer them, so the handler reads `ctx.appState` and says plainly what is
 * missing when the runtime did not provide it. Phase 3.1 (invert the store
 * relationship) is what turns these into real functions; until then the SDK
 * must not pretend.
 */
export const APP_STATE_CHANNEL = [
  // DeveloperService goes through DeveloperPortalStore + ApplicationCenter.
  'Developer.create-application',
  'Developer.list-applications',
  // verus.ts: "reads the store cache and does not hit the network". The SDK
  // serves it from the seeded cache; there is no ack-returning balance RPC.
  'VerusWallet.get-balance',
];

/**
 * The shape each function resolves in `ack.data`.
 *
 * Written from the function's own implementation, not guessed: a caller reads
 * this instead of the source, and `types/valu-services.d.ts` is generated from
 * it. A `void` return means the function answers `{}` on success.
 */
export const RETURNS = {
  // --- AiGuru --------------------------------------------------------------
  'AiGuru.open': { type: 'void', description: 'The application was opened.' },
  'AiGuru.close': { type: 'void', description: 'The application was closed.' },
  'AiGuru.has-application': { type: '{hasApplication: boolean}', description: 'Whether the dock knows this application.' },
  'AiGuru.get-applications': { type: '{applications: object[]}', description: 'Applications the dock can open.' },
  'AiGuru.is-application-loaded': { type: '{loaded: boolean}', description: 'Whether the application is loaded in the dock.' },
  'AiGuru.get-chat-history': { type: '{session: object, messages: object[]}', description: 'The session header and its in-memory messages.' },
  'AiGuru.get-agent-history': { type: '{agent: object, messages: object[]}', description: 'The agent header and its in-memory messages.' },
  'AiGuru.query-knowledge-base': { type: '{toolName: string, result: string}', description: 'The RAG tool that answered and its raw result text.' },

  // --- Application ---------------------------------------------------------
  'Application.get-identity-token': { type: '{token: string}', description: 'A short-lived identity token for the calling application.' },
  'Application.close_all': { type: 'void', description: 'Every open application was closed.' },
  'Application.expand-application': { type: 'void', description: 'The calling application was expanded.' },
  'Application.close-application': { type: 'void', description: 'The calling application was closed.' },

  // --- ApplicationStorage --------------------------------------------------
  'ApplicationStorage.resource-upload': { type: '{resolved: object[], failed: object[]}', description: 'Resources created in the application\'s own storage, and the files that failed.' },
  'ApplicationStorage.resource-search': { type: '{resources: object[], hasMore: boolean, cursor: string}', description: 'A page of the application\'s stored resources.' },
  'ApplicationStorage.resource-delete': { type: 'void', description: 'The resource was deleted.' },

  // --- Cbac ----------------------------------------------------------------
  'Cbac.list-policies': { type: '{policies: object[]}', description: 'Every badge policy on the target entity.' },
  'Cbac.create-policy': { type: '{policy: object}', description: 'The policy that was created.' },
  'Cbac.delete-policy': { type: 'void', description: 'The policy was deleted.' },
  'Cbac.list-badges': { type: '{badges: object[]}', description: 'Badges visible to the caller, network-scoped and global.' },
  'Cbac.search-users-by-badge-id': { type: '{users: object[], total: number}', description: 'A page of badge holders; total is the full match count.' },

  // --- CMS -----------------------------------------------------------------
  'CMS.resource-upload': { type: '{resolved: object[], failed: object[], placed?: string}', description: 'Resources created, and where they were placed (prop or post) when a scope was given.' },
  'CMS.resource-search': { type: '{resources: object[], hasMore: boolean, cursor: string}', description: 'A page of resources in the addressed scope.' },
  'CMS.resource-delete': { type: 'void', description: 'The resource was deleted, or detached from the prop/post that held it.' },

  // --- Commerce ------------------------------------------------------------
  'Commerce.list-products': { type: '{products: object[], total: number}', description: 'The buyer-facing catalogue page for the calling application.' },
  'Commerce.get-product': { type: '{product: object}', description: 'One catalogue product.' },
  'Commerce.list-categories': { type: '{categories: object[]}', description: 'The platform category list.' },
  'Commerce.add-to-cart': { type: '{items: object[]}', description: 'The cart after the addition.' },
  'Commerce.check-entitlements': { type: '{entitlements: object[]}', description: 'What the buyer owns of the products asked about.' },
  'Commerce.get-cart': { type: '{items: object[], count: number}', description: 'The whole cart; count excludes saved-for-later rows.' },
  'Commerce.create-product': { type: '{product: object}', description: 'The DRAFT product that was created. Publishing stays with the seller.' },
  'Commerce.list-my-products': { type: '{hasStore: boolean, products: object[]}', description: 'The seller\'s own catalogue, drafts included.' },
  'Commerce.get-my-product': { type: '{product: object, items: object[]}', description: 'One of the seller\'s products with its content tree.' },
  'Commerce.update-product': { type: '{product: object}', description: 'The updated draft.' },
  'Commerce.open-cart': { type: 'void', description: 'The cart surface was opened.' },
  'Commerce.open-purchases': { type: 'void', description: 'The purchases surface was opened.' },
  'Commerce.open-products': { type: 'void', description: 'The merchant console was opened.' },

  // --- Community -----------------------------------------------------------
  'Community.search-communities': { type: '{communities: object[]}', description: 'Open communities matching the query.' },
  'Community.get-community-info': { type: '{community: object}', description: 'The community record; subscribes the caller as a side effect.' },
  'Community.get-channels': { type: '{communityId: string, channels: object[]}', description: 'The community\'s channels, each stamped with rootChannelId.' },
  'Community.get-posts': { type: '{rootChannelId: string, messages: object[]}', description: 'A page of channel posts with engagement counts.' },

  // --- DataProvider --------------------------------------------------------
  'DataProvider.pick-single': { type: '{picked: object|null}', description: 'What the user chose, or null when they cancelled.' },
  'DataProvider.pick-multiple': { type: '{picked: object[]}', description: 'What the user chose; empty when they cancelled.' },

  // --- Developer -----------------------------------------------------------
  'Developer.create-application': { type: '{appId: string, devId: string, name: string, slug: string, url: string}', description: 'The application that was registered in the Developer Portal.' },
  'Developer.list-applications': { type: '{applications: object[]}', description: 'The caller\'s own Developer Portal applications.' },

  // --- Events --------------------------------------------------------------
  'Events.list-events': { type: '{events: object[]}', description: 'Meeting occurrences in the computed window, earliest first.' },
  'Events.create-meeting': { type: '{meetingId: string, meeting: object}', description: 'The meeting (or recurring series) that was created.' },
  'Events.edit-meeting': { type: '{meetingId: string, meeting: object}', description: 'The meeting after the update.' },

  // --- Groups --------------------------------------------------------------
  'Groups.list-groups': { type: '{groups: object[], hasMore: boolean, cursor: string}', description: 'A page of the caller\'s own groups.' },
  'Groups.list-group-participants': { type: '{participants: object[], hasMore: boolean, cursor: string}', description: 'A page of a group\'s members.' },
  'Groups.discover-groups': { type: '{groups: object[], hasMore: boolean, cursor: string}', description: 'Groups the caller\'s badges let them join; joined ones are flagged.' },
  'Groups.join-group': { type: 'void', description: 'The caller joined the group.' },

  // --- Http ----------------------------------------------------------------
  'Http.ping': { type: '{up: boolean, latency: number, status: number}', description: 'Reachability of the URL, by HEAD.' },
  'Http.get': { type: '{ok: boolean, status: number, statusText: string, headers: object, body: any, bodyType: string, latency: number}', description: 'The response, with the body parsed per responseType.' },
  'Http.post': { type: '{ok: boolean, status: number, statusText: string, headers: object, body: any, bodyType: string, latency: number}', description: 'The response, with the body parsed per responseType.' },

  // --- Logging -------------------------------------------------------------
  'Logging.get-logs': { type: '{logs: string|object[]}', description: 'The Valu Social application\'s captured log buffer, in the requested format.' },

  // --- Networks ------------------------------------------------------------
  'Networks.get-current-network': { type: '{networkId: string, name: string|null}', description: 'The active network id and its human-readable name.' },

  // --- Profile -------------------------------------------------------------
  'Profile.get-user-credentials': { type: '{credentials: object[]}', description: 'Verus credentials published on the user\'s profile.' },
  'Profile.get-user-badges': { type: '{badges: object[]}', description: 'Badges assigned to the user in the requested network scope.' },

  // --- Resources -----------------------------------------------------------
  'Resources.get-thumbnail-url': { type: '{url: string}', description: 'The public downscaled URL for the resource.' },
  'Resources.generate-public-url': { type: '{url: string}', description: 'The web-app preview page URL.' },
  'Resources.generate-best-view-url': { type: '{url: string}', description: 'The web-app "best view" URL.' },
  'Resources.generate-direct-public-url': { type: '{url: string}', description: 'The API URL that serves the raw bytes.' },
  'Resources.list-bot-avatars': { type: '{avatars: object[]}', description: 'Network-allowed bot avatars ({id, name, tags}).' },

  // --- Rooms ---------------------------------------------------------------
  'Rooms.search-rooms': { type: '{rooms: object[]}', description: 'Public/discoverable rooms in the network.' },
  'Rooms.search-my-rooms': { type: '{rooms: object[]}', description: 'Rooms the caller belongs to, or their invitations.' },
  'Rooms.get-room': { type: '{room: object}', description: 'The room\'s basic model.' },
  'Rooms.get-permissions': { type: '{permissions: object}', description: 'The caller\'s permission set for the room.' },
  'Rooms.get-room-props': { type: '{props: object[], propOrder: object}', description: 'The room\'s props in navigation order, and where that order came from.' },
  'Rooms.get-prop': { type: '{prop: object|null, propOrder: object}', description: 'One prop, read from the same ordered list.' },
  'Rooms.get-room-prop-groups': { type: '{roomId: string, networkId: string, propOrder: object, groupIds: string[], groups: object[]}', description: 'Props grouped by their whole tag set, in navigation order.' },
  'Rooms.list-prop-team-members': { type: '{invitations: object[]}', description: 'The prop\'s invitations.' },
  'Rooms.invite-to-prop': { type: '{invitation: object|null}', description: 'The invitation that was created.' },
  'Rooms.delete-prop-invitation': { type: 'void', description: 'The invitation was revoked.' },
  'Rooms.list-room-templates': { type: '{templates: object[], hasMore: boolean, filteredOutCount: number}', description: 'AI-approved room templates, with the group count each declares.' },
  'Rooms.create-room-from-template': { type: '{roomId: string, name: string, networkId: string, price: number, isFree: boolean, paymentRequired: boolean}', description: 'The new room; paymentRequired says a paid template still has to be settled.' },
  'Rooms.paste-resources-into-prop': { type: '{roomId: string, propId: string, name: string, addedResourceIds: string[], failed: object[], removedTemplateStubs: string[], skippedAlreadyPresent: string[], sliderEnabled: boolean}', description: 'What landed on the prop, and what it cost to put it there.' },
  'Rooms.paste-resources-into-prop-group': { type: '{roomId: string, groupIds: string[], distribution: string, placements: object[], unplacedResourceIds: string[], eligiblePropCount: number, skippedProps: object[]}', description: 'One placement per prop that took content, plus what was turned away.' },
  'Rooms.rename-prop-group': { type: '{roomId: string, groupId: string, name: string, hasLabels: boolean, renamedLabelPropIds: string[], failed: object[]}', description: 'The section signs that were retitled.' },

  // --- TextChat ------------------------------------------------------------
  'TextChat.get-channel-history': { type: '{channelId: string, messages: object[], hasPrevious: boolean, hasNext: boolean}', description: 'A page of a channel\'s messages.' },
  'TextChat.send-message': { type: '{channelId: string, messageId: string, createdAt: string}', description: 'The message that was posted, authored by the current user.' },
  'TextChat.message-owner': { type: '{channelId: string, messageId: string, createdAt: string}', description: 'The message that was posted into the owner\'s agent channel, authored by the agent.' },

  // --- Time ----------------------------------------------------------------
  'Time.get-local-time': { type: '{iso: string, utcIso: string, timezone: string, offsetMinutes: number, dayOfWeek: string, localDate: string, localTime: string, locale: string}', description: 'The caller\'s local clock, one instant in several forms.' },

  // --- Users ---------------------------------------------------------------
  'Users.current': { type: '{user: object}', description: 'The authenticated user.' },
  'Users.get': { type: '{user: object}', description: 'One user\'s basic profile.' },
  'Users.search-users': { type: '{users: object[]}', description: 'Matches WITHIN the caller\'s own connections.' },
  'Users.find-user': { type: '{users: object[]}', description: 'Suggested people across the network.' },
  'Users.send-connection-request': { type: 'void', description: 'The request was sent.' },
  'Users.accept-connection-request': { type: 'void', description: 'The request was accepted.' },
  'Users.decline-connection-request': { type: 'void', description: 'The request was declined.' },
  'Users.cancel-connection-request': { type: 'void', description: 'The outgoing request was cancelled.' },
  'Users.list-connection-requests': {
    type: '{requests: object[], users: object[], hasMore: boolean}',
    description: 'Connection requests, with the other party of each resolved into `users`.',
  },

  // --- VerusWallet ---------------------------------------------------------
  'VerusWallet.get-balance': { type: '{identityName: string, iAddress: string, balance: number|null}', description: 'The agent wallet\'s last known balance. Read from application state, never the network.' },
  'VerusWallet.transfer': { type: '{txid: string}', description: 'The transaction that moved the funds.' },
};

/**
 * Phase 2b — the seven server tools with no declared intent, and what happens
 * to each. Three decisions, recorded here so the catalogue reports the gap
 * rather than hiding it, and so `docs/parity.md` is generated and not written
 * twice.
 *
 * `disposition`:
 *   'binding'  — it is a SHAPE of declared functions, not a function of its
 *                own. It stays a server binding and compiles to the declared
 *                ones named in `declared`.
 *   'declared' — it is the same function under another name; the declared one
 *                is canonical and the server tool becomes an alias.
 *   'internal' — it is genuinely server-only (no browser equivalent, no
 *                manifest entry) and stays outside the SDK catalogue.
 */
export const SERVER_ONLY_RECONCILIATION = [
  {
    tool: 'service__Http__curl',
    disposition: 'binding',
    declared: ['Http.get', 'Http.post', 'Http.ping'],
    decision:
      'A curl command line is an INPUT FORMAT, not a capability: http.ts parses it '
      + '(curl-parse.ts) and then performs exactly what Http.get / Http.post / Http.ping '
      + 'already declare — `curl -I` IS the ping. It stays a server-side binding that '
      + 'parses the command and calls the declared function; the SDK gains nothing by '
      + 'declaring a fourth way to say GET.',
  },
  {
    tool: 'system__get_user_timezone',
    disposition: 'declared',
    declared: ['Time.get-local-time'],
    decision:
      'Both answer the same question — what time is it where the user is — and differ only '
      + 'in WHOSE clock: in the browser the caller IS the user, so Time.get-local-time reads '
      + 'the local one; headless the user is somebody else, so system.ts asks '
      + '`user:getTimezone`. Time.get-local-time is canonical for the caller\'s own clock and '
      + 'the SDK implements exactly that. Asking about ANOTHER user is not declared anywhere: '
      + 'the intent takes no params, and widening it is the app\'s manifest to change, not '
      + 'this package\'s. So the server tool stays a binding over `user:getTimezone` until '
      + 'the manifest grows an optional userId — noted for Phase 3, not smuggled in here.',
  },
  {
    tool: 'service__TextChat__message_user',
    disposition: 'internal',
    declared: [],
    decision:
      'AGENT-AUTHORED, and that is the whole difference. TextChat.send-message posts as '
      + 'the current USER; message_user resolves (or spawns) the agent\'s own thread off a '
      + 'direct channel and posts as the AGENT. Only a runtime that HAS an agent identity '
      + 'can call it — an embedded third-party app has none — so declaring it would put a '
      + 'function in the manifest that no manifest caller can satisfy. Stays server-only '
      + 'until an agent identity is part of the SDK context.',
  },
  {
    tool: 'service__TextChat__send_card',
    disposition: 'internal',
    declared: [],
    decision: 'Agent-authored, for the same reason as message_user, and additionally '
      + 'server-resolved (meeting occurrences are looked up backend-side). Stays server-only.',
  },
  {
    tool: 'service__Torah__corpora',
    disposition: 'internal',
    declared: [],
    decision:
      'A corpus-specific retrieval index that lives in the Valu Guru server and has no '
      + 'platform surface: no manifest entry, no browser path, no socket RPC. Declaring it '
      + 'would make the platform catalogue carry one deployment\'s content. Stays server-only.',
  },
  {
    tool: 'service__Torah__search',
    disposition: 'internal',
    declared: [],
    decision: 'Same index as Torah.corpora, same reason. Stays server-only.',
  },
  {
    tool: 'service__generate_image',
    disposition: 'internal',
    declared: [],
    decision:
      'Image generation is a MODEL capability, not a platform service: it needs the '
      + 'server\'s provider credentials, and its result is written into the caller\'s CMS '
      + 'session folder. A declared intent would hand a third-party app the server\'s '
      + 'inference budget. Stays server-only.',
  },
];

/**
 * Where this package's behaviour is knowingly not the app's.
 *
 * "Parity is not identical behaviour" — the plan says so, and these are the
 * places it bites. Each one is a decision, not an oversight, and each is
 * rendered into docs/parity.md so nobody has to find it in QA.
 */
export const KNOWN_DELTAS = [
  {
    key: 'Resources.get-thumbnail-url',
    delta:
      'The app emits `resource:getThumbnailUrl`, which answers a URL PLUS decryption '
      + 'metadata; the server builds the public `/api/v0/resource/thumbnail/{size}/{id}` '
      + 'URL with no call, and Phase 1 classed the function `local` on that basis. The SDK '
      + 'builds it. A caller holding an ENCRYPTED resource therefore gets a URL it cannot '
      + 'decrypt with. Reclassifying it `socket` would change the frozen parity counts, so '
      + 'the decision is recorded here instead and belongs to Phase 3.',
  },
  {
    key: 'TextChat.get-channel-history',
    delta:
      'The app decrypts an encrypted body with the user\'s key material, which lives in the '
      + 'browser; the server\'s tools do not decrypt at all. The SDK returns bodies as the '
      + 'platform stored them and flags an encrypted one `encrypted: true` — saying so beats '
      + 'handing back ciphertext that reads like a message. A runtime that CAN decrypt '
      + 'supplies `appState.decryptMessage`.',
  },
  {
    key: 'TextChat.send-message',
    delta:
      'Outbound bodies are not encrypted, for the same reason — the app encrypts through '
      + '`tryCreateEncryptionContext`, the server does not. Sending into an encrypted channel '
      + 'from the SDK posts a plaintext body.',
  },
  {
    key: 'Events.create-meeting',
    delta:
      'A `direct` meeting with more than one participant is REFUSED. The app silently creates '
      + 'a new Group for it (GroupBuilder + GroupsStore.createGroupAux) — a second write, with '
      + 'its own failure modes and no undo. Creating a group as a side effect of booking a '
      + 'meeting is a UI decision, not a service one; the caller is told to create the group '
      + 'and meet in it.',
  },
  {
    key: 'Rooms.create-room-from-template',
    delta:
      'The app also reloads the Rooms data provider\'s cached lists so a new room appears '
      + 'without a refresh. That is a UI cache in the app\'s own store; the SDK has none and '
      + 'does not reach into one.',
  },
];

// ---------------------------------------------------------------------------
// What a RUNTIME must supply, per function — the server-functions reference.
//
// `channel` already says which socket answers, and SocketTransport refuses a
// missing channel by name before the handler runs. But four functions in ten
// want something MORE than their channel: an application identity the Valu
// Social app stamps, a `fetch`, an origin to build a URL against, or a piece of
// state only that application holds. A server integrator has to know that BEFORE the first call,
// because "403 the calling application could not be identified" arrives at run
// time and reads like an auth problem.
//
// So every extra requirement is listed here, and test/server-functions.test.js
// asserts each one against the real handler — a requirement that stopped being
// true, or a new one nobody wrote down, fails the build rather than the docs.
//
// Tags:
//   applicationId          the caller identity the app stamps; 403 without it
//   applicationId?         used when present (a belonging fallback), not required
//   fetch                  outbound HTTP; `ctx.fetchImpl ?? globalThis.fetch`
//   config                 { webBase, apiGate } — the origin a URL is built on
//   appState.<capability>  state only the application holds
//                          (src/app-state/AppState.js)
//   appState.<capability>? optional; the function degrades rather than refusing
// ---------------------------------------------------------------------------
export const REQUIREMENTS = {
  // The shelf IS `app:{applicationId}:userSortingTable:{userId}` — without the
  // app id there is no address to read or write. `resource-delete` takes a
  // resource id and is enforced by the platform, so it needs none.
  'ApplicationStorage.resource-upload': ['applicationId', 'fetch'],
  'ApplicationStorage.resource-search': ['applicationId'],
  // CMS addresses a room/prop/directory/community when the caller names one,
  // and falls back to the app's own shelf when it does not.
  'CMS.resource-upload': ['applicationId?', 'fetch'],
  'CMS.resource-search': ['applicationId?'],
  'Http.get': ['fetch'],
  'Http.post': ['fetch'],
  'Http.ping': ['fetch'],
  'Resources.generate-public-url': ['config'],
  'Resources.generate-best-view-url': ['config'],
  'Resources.generate-direct-public-url': ['config'],
  'Resources.get-thumbnail-url': ['config'],
  'Developer.list-applications': ['appState.listDeveloperApplications'],
  'Developer.create-application': ['appState.createDeveloperApplication'],
  'VerusWallet.get-balance': ['appState.getAgentWallet'],
  // `transfer` emits on the Roomful socket, but it cannot START there: the
  // declared param is an AGENT id and the RPC wants the wallet's identity and
  // i-address, which only the application can resolve. A headless runtime with no
  // wallet state cannot transfer, and says so instead of guessing an address.
  'VerusWallet.transfer': ['appState.getAgentWallet'],
  // Key material for an encrypted channel lives in the browser. Without it an
  // encrypted body comes back flagged rather than as ciphertext that reads
  // like a message (docs/parity.md).
  'TextChat.get-channel-history': ['appState.decryptMessage?'],
};
