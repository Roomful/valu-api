// ===========================================================================
// Service functions this package declares itself.
//
// SERVICE_MANIFESTS is the Valu Social application's declaration of what a
// FRAME may ask it for. It is not a declaration of what the Roomful socket can
// do, and the two are not the same list: `request:listRequests` has served the
// Contacts screen for as long as there has been one, and no manifest intent
// names it — so "list my connection requests", which is the second thing
// anybody asks an agent about their network, had no function.
//
// A function here is a service function like any other: same descriptor, same
// validation, same cache, same ack. What differs is provenance, and every
// descriptor carries it — `declaredBy: 'manifest' | 'sdk'`. That keeps two
// facts separate:
//
//   the app declares 92 intents          (a fact about valusocial-web)
//   the SDK offers 78 service functions  (a fact about this package)
//
// The bar for adding one, all four:
//   1. the RPC already exists and the app already calls it — cite where;
//   2. the socket serves it for any authenticated caller, so a headless agent
//      and a frame both reach it;
//   3. no declared intent covers it (`docs/parity.md` would be lying if one
//      did);
//   4. the app SHOULD declare it, and `docs/parity.md` says so — an
//      entry here is a gap being carried, not a fork.
// ===========================================================================

/**
 * @typedef {object} SdkDeclaredFunction
 * @property {string} service Must already exist in the manifest snapshot: the
 *   service's title, description and source come from there, so this cannot
 *   invent a service.
 * @property {object} intent Same shape a manifest intent has.
 * @property {string} rpc The socket namespace behind it, for the docs.
 * @property {string} source `repo/path:lines` — where the app calls that RPC.
 * @property {string} why One sentence: what was unreachable without it.
 */

/** @type {SdkDeclaredFunction[]} */
export const SDK_DECLARED = [
  {
    service: 'Users',
    rpc: 'request:listRequests',
    source: 'valusocial-web/src/Applications/ContactsApplication/DataProviders/ContactsDataProvider.js:331-375',
    why: 'The manifest declares all four connection-request transitions — send, '
      + 'accept, decline, cancel — and no way to SEE a request. An agent could '
      + 'accept a request it had no way to learn about.',
    intent: {
      action: 'list-connection-requests',
      description: 'List connection (friend) requests involving the current user, newest first. '
        + 'Use this to answer "who wants to connect with me" before accepting or declining: '
        + 'the ids this returns are what accept-connection-request and decline-connection-request take. '
        + 'Resolves each request\'s other party into a user object in the same call.',
      availability: ['ai', 'developer'],
      permissions: [],
      params: {
        required: [],
        optional: [
          {
            name: 'category',
            type: 'string',
            description: 'Which side of the request to list. "received" — requests other people sent to the current user (the default, and the one that needs answering); "sent" — requests the current user sent and can still cancel.',
            options: ['received', 'sent'],
          },
          {
            name: 'status',
            type: 'string',
            description: 'Request status. Defaults to "pending" — the only status with anything to do about it.',
            options: ['pending', 'accepted', 'declined'],
          },
          {
            name: 'offset',
            type: 'number',
            description: 'Pagination offset. Defaults to 0.',
          },
          {
            name: 'size',
            type: 'number',
            description: 'Number of requests to return. Defaults to 20.',
          },
        ],
      },
    },
  },
];

/**
 * Functions this file deliberately does NOT declare, and what each would take.
 *
 * They meet the first three tests above and not the fourth: each is a decision
 * about what an agent may do, not a gap in what it can see. `docs/parity.md`
 * puts them in front of whoever makes that call.
 */
export const SDK_DECLARED_CANDIDATES = [
  {
    name: 'Users.remove-connection',
    rpc: 'social:deleteFriend',
    reads: false,
    note: 'The symmetric gap to list-connection-requests, and a write: an agent '
      + 'that can connect people cannot disconnect them. Declaring it gives an '
      + 'agent the power to sever a relationship, which is why it is not here.',
  },
  {
    name: 'Users.follow / Users.unfollow',
    rpc: 'social:followUser / social:unfollowUser',
    reads: false,
    note: 'Following is public and one-sided — cheaper to grant than a connection, '
      + 'and still a visible act performed as the user.',
  },
  {
    name: 'Community.list-invitations',
    rpc: 'request:listRequests (type: "Community")',
    reads: true,
    note: 'The SAME RPC as list-connection-requests with a different `type`, and the '
      + 'same shape of gap: Community declares four reads and no way to see an '
      + 'invitation. It belongs on Community rather than Users, and Community has '
      + 'no join/accept function to pair it with yet — declaring the read alone '
      + 'would let an agent report an invitation it cannot act on.',
  },
];
