# Adoption: where Valu Social and the Valu Guru server stand

Measured, not estimated. Every number below comes from reading the three
checkouts, and `node scripts/measure-consumers.mjs` re-derives all of them —
it exits non-zero the moment one of the three has moved, so this report can be
checked rather than believed.

| repository | commit measured | role |
|---|---|---|
| `valu-api` | `0d10df8` + this change | this package — one implementation of the platform's **socket** service surface |
| `valusocial-web` | `a76546c6` + this change | declares the manifest, serves all 92 intents in the browser, hosts framed apps |
| `valu-guru-server` | `7a7f985` | runs headless agents over the Roomful socket; **owns** the `valuguru.*` API |

**The Valu Guru server has adopted this package** (2026-09-30): its eight
hand-written socket-wrapper modules are deleted and its registry builds those
tools from these descriptors.

**Valu Social has started** (2026-10-01): 24 of its service intents are now
served by this package over the socket the app already had, through one wrapper
at one registration point. The section below is what it did and what it left.

## Headline

| | count |
|---|---|
| intents the platform declares | **92** |
| functions in this package | **65** — 64 of the declared 92 + 1 it declares itself |
| declared intents excluded | **28** — 15 only the application process can answer, 13 the Valu Guru server answers |
| server tools in valu-guru-server | **39** — the same 39 as before the adoption |
| … now served by this package | **31** |
| … still the server's own | **8** — 3 TextChat, curl, Torah ×2, timezone, image |
| intents the app exposes to the AI | **60** — this package serves **48** |
| server-adoptable functions not yet offered there | **31** |

The vendored manifest snapshot is byte-identical to the app's live
`SERVICE_MANIFESTS`, and every tool the server's registry holds is accounted
for here. There is no drift.

## One connection, and what that excluded

This package holds the **Roomful platform socket** and nothing else. The
earlier catalogue also carried a `valuguru` channel: a second socket, to the
Valu Guru server's `data_request` endpoint, for the ten Commerce intents, the
knowledge-base search and the two chat-history reads. Those **13 intents are no
longer in the catalogue** — no descriptor, no method, no tool definition.

The reason is what this package is for. It is the user-facing platform library,
installed by the Valu Social build and by framed applications; a second
server's API, with its own envelope and its own auth, does not belong in it.
And the Valu Guru server *is* the other end of that socket, so it could never
have adopted those functions anyway.

What it changes per consumer:

- **`valu-guru-server`** — nothing. It never offered one of the 13: `sdk.ts`
  refused them at import, and its own `valuguru.commerce.*` and `rag_search`
  handlers are untouched. It is still pinned to a commit that predates this
  removal; bumping the pin changes none of its 39 tools.
- **`valusocial-web`** — it keeps serving all 13 itself, as it does today
  (`src/Services/Commerce/CommerceDataService.js`, the AiGuru socket service).
  There is no SDK function to delegate them to and there will not be one.
- **A framed application** — unchanged: it asks for them by name over the
  bridge, exactly as it asks for a dock to open. The 13 are listed with their
  params in [api-pointers.md](api-pointers.md).

## The split by consumer

| channel | n | valu-guru-server | valusocial-web |
|---|---|---|---|
| `roomful` | 54 | **adopted** — 28 offered today, 26 available | adopt |
| `local` | 8 | **adopted** — 3 offered today, 5 available | adopt |
| `app-state` | 3 | the 2 Verus ones are wired to an honest refusal | adopt, supplying `AppState` |

Server-adoptable: **62** (`roomful` + `local`). It offers **31** of them.

One of the 62 is declared by this package rather than by the app's manifest:
`Users.list-connection-requests`, over `request:listRequests`. The rule that
allows it, and the three candidates it deliberately leaves out, are in
[parity.md](parity.md).

Either consumer supplies the socket through an adapter — the app's WebSocket
service through `BrowserSocketAdapter`, `RoomfulConnectionManager` through
`NodeSocketAdapter`. What those do, and what a third runtime would have to
implement, is [socket-adapters.md](socket-adapters.md).

## Valu Guru server — done

`src/valu-tools/sdk.ts` is the whole of it. Eight modules (~2,500 lines) that
emitted the same RPCs as this package are deleted; the registry's 39 tool names,
its `{def, handler}` shape and its `{success, …}` result shape are unchanged, so
`withGenericServerTools`, `withWorkerSocketTools` and every skill loadout were
untouched. `valu-guru-server/docs/valu-api-migration.md` is that repo's own
account of it.

What the adapter owns, and why each piece is there rather than here:

- **WHICH functions it offers** (`SDK_TOOLS`) — 31, exactly the ones its
  hand-written tools offered, so no agent's tool list changed shape in the same
  commit that changed what is behind it.
- **Identity** — `agentId` is stripped from the tool definition the model sees
  and stamped from the run context. The rule the old Verus tools stated in prose
  ("supplied by the runtime; do not pass it"), now in one place.
- **The result shape** — `{data} | {error}` mapped to `{success, …}`. It comes
  out even because this package's handlers were ported FROM those tools.
- **`cache: null`** — the hand-written tools never cached, and an agent reading
  back what it just wrote through another path must not see a 30-second-old
  answer.

### What changed for an agent

**15 of the 31 tools changed their param schema**, because the params now come
from the application's manifest rather than from a hand-written tool. The
per-tool table is in `valu-guru-server/docs/valu-api-migration.md`; the renames
worth knowing are `start`/`end` → `startDate`/`endDate` (all three Events
tools), `userId` → `invitedUser` (the two prop-invitation writes),
`rootChannelId` → `channelId` (`Community.get-posts`), `to` → `destination`
(`VerusWallet.transfer`), and `filter` becoming required on
`Users.search-users` and `Rooms.search-my-rooms`. An agent prompt or a skill
that spells out an old param needs updating.

One capability moved in each direction: `Events.list-events` lost `meetingId`
(a client-side filter over the same list — every event still carries its
`meetingId`), and gained `startDate` + `endDate` as an explicit window, which is
a param this package adds beyond the manifest precisely so the server lost
nothing (`scripts/extensions.js`).

### The 31 available and not yet offered

Widening an agent's tool surface changes how it behaves, so it is a separate
decision. `SDK_TOOLS` is the one list to edit.

| service | functions |
|---|---|
| ApplicationStorage | `resource-delete`, `resource-search`, `resource-upload` |
| Cbac | `create-policy`, `delete-policy`, `list-badges`, `list-policies`, `search-users-by-badge-id` |
| CMS | `resource-delete`, `resource-search`, `resource-upload` |
| Groups | `discover-groups`, `join-group` |
| Http | `get`, `ping`, `post` |
| Profile | `get-user-badges`, `get-user-credentials` |
| Resources | `get-thumbnail-url`, `list-bot-avatars` |
| Rooms | `create-room-from-template`, `get-room`, `get-room-prop-groups`, `list-room-templates`, `paste-resources-into-prop`, `paste-resources-into-prop-group`, `rename-prop-group` |
| TextChat | `get-channel-history`, `send-message` |
| Users | `list-connection-requests` (declared by this package) |
| Time | `get-local-time` |

### Four things still open in that repo

1. **The `Http` trio is blocked on the wire.** `http.ts` collapsed
   `service__Http__ping|get|post` into `service__Http__curl`, and
   `LEGACY_HTTP_TOOL_NAMES` actively strips the three names from any tool list
   so a stale frontend cannot advertise them. This package implements all
   three. Decide which is the AI-facing form: keep `curl` and have it call the
   three declared functions, or stop stripping and expose all four. Do not do
   both by accident — the strip list would silently win.

2. **ApplicationStorage needs an application identity, and a server agent has
   none.** `resource-upload` and `resource-search` refuse with 403 without one;
   `ValuToolContext` carries `userId`, `agentId` and `sessionId` but no
   `applicationId`, and the id is deliberately never read from a caller's
   params. Until "what application does an agent's own storage belong to" has
   an answer, those two stay out and CMS (which addresses a room, prop or
   community instead) carries the load.

3. **VerusWallet still refuses, and that is correct.** Both functions need
   `appState.getAgentWallet` — `get-balance` because there is no ack-returning
   balance RPC at all, `transfer` because spending needs the wallet seed. The
   adapter supplies a capability that throws with those reasons, so the refusal
   reads the way the hand-written stubs read. The pair stays excluded from the
   worker socket lane; chat-spawned workers keep the browser twins.

4. **`get-channel-history` will not decrypt.** Headless has no key material, so
   an encrypted body comes back flagged `encrypted: true` rather than as
   ciphertext that reads like a message. Strictly better than the server's own
   tools, which do not decrypt either and do not say so — but an agent prompt
   that assumes readable history needs to expect the flag. It is one of the 31
   not yet offered.

## Valu Social — started

The app is not a consumer of a missing capability — it is where every one of
these functions came from. Its transition is the inverse of the server's: not
"gain functions" but "stop having two implementations".

**What landed (2026-10-01).** Three files and two edits, in `valusocial-web`:

| | |
|---|---|
| `src/Services/ValuApi/ValuApiService.js` | holds the client over the app's own socket, and **shares the socket instance** |
| `src/Services/ValuApi/serviceIntents.js` | the table: which intents the package serves, and how its answer becomes the app's |
| `…/serviceIntents.parity.test.js` | every delegated intent, package vs the service's own code, same fake socket, asserted equal |
| `ApplicationStore.#registerServices` | installs the wrapper at registration |
| `MultipleApplication` / `SingleApplication` | register the new service |

- **The socket is the app's.** `adoptValuSocket(webSocketService, …)` wraps the
  `WebSocket` service the whole tab already shares. The package opens nothing,
  authenticates nothing and reconnects nothing. Its other door — `sessionId` —
  exists for runtimes that do not have what this one has
  ([connecting.md](connecting.md)).
- **One wrapper, three callers.** `installSdkIntents` replaces a service's
  `onNewIntent` with one that delegates the intents in the table. All three
  intent paths end there — the iframe bridge (`ApplicationCenterStore`), the
  native shell (`ApplicationCenterStoreAPI.run`) and the AI (`AiGuruTools`) — so
  none of them changed and none of them can go around it.
- **24 intents, 7 services**: `Time` (1), `Networks` (1), `Profile` (2), `Cbac`
  (5), `Groups` (4), `Community` (4), `Users` (7 of 9). Each service keeps its
  own methods, its socket event subscriptions and its stores; what moved is the
  RPC behind an intent, and only that.
- **`cache: null`**, for the reason the server chose it: the app writes through
  its stores, not through this package, so a 30-second read-through cache would
  serve an answer the app has already invalidated.
- **The app's answer shapes did not change.** They are not the package's —
  `Cbac.list-policies` answers a bare array, `Groups.join-group` answers
  `{success}`, a Cbac failure answers a human sentence — and framed apps and AI
  prompts read them today. The table maps each one, and the parity test proves
  the mapping by running both implementations against the same scripted socket.
- **The fallback is the old code.** An intent not in the table, or any intent at
  all before there is a connection to delegate over, runs the service's own
  implementation. Delegation is additive; it is not a new way for a screen to go
  blank.

**What it did not take, and why** — each one is a line in that table away:
`Rooms` (orchestration above the RPCs), `TextChat` (the package neither encrypts
nor decrypts; needs `appState.encryptMessage` / `decryptMessage`), `Events`
(`create-meeting` creates a Group as a side effect), `ApplicationStorage` + `CMS`
(scoped to the CALLING application, and one shared client cannot carry a
per-caller id), `Resources` (three of five build URLs from a configured origin,
and `get-thumbnail-url` has a known delta), `Http` (same call, different CORS
story), and `Users.current` (the app has the answer in `baseUser`; the package
spends an RPC on it because headless has no `baseUser`).

- All 92 intents are served today: 87 through a service's `onNewIntent`, and
  the five `AiGuru` dock intents (`open`, `close`, `has-application`,
  `get-applications`, `is-application-loaded`) as `builtin` tools in
  `AiGuruTools.js`, dispatched to `ApplicationCenterStore` rather than through
  a service at all.
- **Nothing about the app's intent registry changes.** The 28 it keeps serving
  itself are the 28 this package never declares, so there is no list here to
  keep in step with it and no method to remove when the app adds an intent.
- 60 intents carry `availability: ['ai']`. This package serves **48**. The 12 it
  does not are the ten Commerce intents — the Valu Guru server's own catalogue,
  which the app reaches over that server's socket — and
  `DataProvider.pick-single` / `pick-multiple`, which render the application's
  own UI and return the user's choice.
- The delegation point is each service's `onNewIntent`, and it now has one
  wrapper rather than an edit per service — `installSdkIntents`, installed at
  service registration. Taking another service is a line in
  `DELEGATED_INTENTS` plus a parity case; `Rooms` is the one with real
  orchestration behind it (storyline ordering, the paste pipeline, prop
  grouping) and still goes last.
- **The one thing a reader of this document should expect to find in the app
  that is NOT here**: a per-intent answer-shape map. The package's shapes are
  uniform by design (`{users}`, `{policies}`, `{user}`); the app's grew per
  intent and are what framed apps and AI prompts read today. The app maps
  between them in one table and tests the mapping against its own old code.
  Collapsing that table means changing a published contract, which is a
  decision, not a refactor.
- `Commerce` and `AiGuru` are not on that list at all. They keep their own
  services, because the socket they speak to is not the one this package holds.

### The five places behaviour differs

These are decisions, recorded in [parity.md](parity.md), and each one has to be
settled **before** the app delegates that function — the app is the runtime
where the difference is visible to a user.

| function | the difference | what it needs |
|---|---|---|
| `Resources.get-thumbnail-url` | the SDK builds the public URL; the app's RPC also returns decryption metadata, so an encrypted resource gets a URL it cannot decrypt with | reclassify to `roomful` and emit `resource:getThumbnailUrl`. Moves the frozen local/socket split, so it is a Phase 3 change, not a quiet one |
| `TextChat.get-channel-history` | the SDK does not decrypt | the app already has the key material — pass `appState.decryptMessage`, which the `AppState` interface already declares |
| `TextChat.send-message` | the SDK does not encrypt outbound bodies | needs the mirror of the above: an outbound `appState.encryptMessage`. Not yet declared |
| `Events.create-meeting` | a `direct` meeting with more than one participant is refused; the app silently creates a Group for it | keep the group creation in the app's service, above the SDK call. It is a UI decision with a second write and no undo |
| `Rooms.create-room-from-template` | the app also reloads the Rooms data provider's cached lists | keep the reload in the app's service, after the SDK call |

Three of the five resolve by leaving a thin layer of app-specific behaviour
*above* the SDK call, which is where it belongs. Two need something added to
this package first.

(The sixth, `Commerce.create-product` — where the app opens its own listing form
and the SDK answered 501 — is no longer a delta, because the function is no
longer here.)

## Do we need a release?

**No — and yes.** Nothing is blocked on one, and one should still happen.

A consumer can depend on a **commit** (`github:Roomful/valu-api#<sha>`), which
needs no npm credentials because the repository is public, and which the Valu
Guru server has done since its own adoption. That is how `valusocial-web` takes
this package today: the pin is in its `package.json`, it resolves on a clean
`npm ci`, and no release stood between the work and a working build.

What a release buys, and why it is still wanted:

- A **version** instead of a hash in three repositories' lockfiles. A pin is
  precise and unreadable; `^2.0.0` tells a reader which API they are on.
- One place to **say what changed**. Two consumers already read the docs in this
  repository; a third-party app developer reads npm.
- `npm install @arkeytyp/valu-api` is the first line of the README, and it
  currently installs a package that predates everything in these docs.

The version in `package.json` is now **2.0.0**, and it is a major for reasons
that predate this change: `api.services`, `api.intents` and
`ApplicationIntents` are gone, the postMessage bridge no longer serves service
functions, and the Commerce and knowledge-base functions went with the second
socket. The published `1.1.3` predates the SDK entirely.

Publishing is one command by whoever holds the npm token, and it changes nothing
in either consumer until somebody edits a dependency line:

```bash
npm test && npm run build && npm publish --access public
```

After that, `valusocial-web` swaps its commit pin for `^2.0.0` and the server
bumps its own. Both are one line, and neither is urgent.

## What is left, in order

1. **Publish `2.0.0`** — see above. Optional, and still worth doing.
2. **Bump the server's pin** to a commit of this package that has one socket, so
   the two repositories agree about what a service function is. Nothing in its
   39 tools changes.
3. **Turn on some of the 31** the server can already reach — minus the two
   `ApplicationStorage` ones until question 2 above has an answer, and with an
   eye on how many tools an agent's prompt can carry.
4. **Settle the `Http` trio** so the AI-facing surface has one shape.
5. **The app, service by service.** Seven services are in (above). The rest, in
   the order their blockers clear: `Resources` and `Http` need a look at
   configuration and CORS; `Events` needs a decision about the Group it creates;
   `TextChat` needs `appState.encryptMessage` / `decryptMessage`;
   `ApplicationStorage` and `CMS` need per-caller application identity — the same
   question that blocks them on the server; `Rooms` last.
6. **Then decide whether the two sides' answer shapes should converge**, and
   delete the app's mapping table if they do. That is a published-contract
   change for framed apps and AI prompts, so it is its own piece of work with
   its own announcement — not a tidy-up.

## What is still advisory

Scope checking is **client-side and advisory** until Phase 3.3 —
[authorization.md](authorization.md) says so plainly. A scope string on a
descriptor documents what a caller ought to hold; nothing enforces it. Both
consumers above are trusted runtimes, so this is fine for them. **No
third-party framed app gets a socket before that lands**, and neither of these
transitions should be read as permission to hand one out.
