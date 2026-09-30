# Adoption: where Valu Social and the Valu Guru server stand

Measured, not estimated. Every number below comes from reading the three
checkouts, and `node scripts/measure-consumers.mjs` re-derives all of them —
it exits non-zero the moment one of the three has moved, so this report can be
checked rather than believed.

| repository | commit measured | role |
|---|---|---|
| `valu-api` | `48331f7` | this package — one implementation of the platform's service surface |
| `valusocial-web` | `a4407df8` | declares the manifest, serves all 92 intents in the browser, hosts framed apps |
| `valu-guru-server` | `898d699` | runs headless agents over the Roomful socket; **owns** the `valuguru.*` API |

**The Valu Guru server has adopted this package** (2026-09-30): its eight
hand-written socket-wrapper modules are deleted and its registry builds those
tools from these descriptors. Valu Social has not moved yet.

## Headline

| | count |
|---|---|
| intents the platform declares | **92** |
| functions in this package | **78** — 77 of the declared 92 + 1 it declares itself |
| declared intents excluded | **15** — only the Valu Social application can serve them, and it is asked by name |
| server tools in valu-guru-server | **39** — the same 39 as before the adoption |
| … now served by this package | **31** |
| … still the server's own | **8** — 3 TextChat, curl, Torah ×2, timezone, image |
| intents the app exposes to the AI | **60** — this package serves **58** (the 2 pickers need a frame) |
| server-adoptable functions not yet offered there | **31** |

The vendored manifest snapshot is byte-identical to the app's live
`SERVICE_MANIFESTS`, and every tool the server's registry holds is accounted
for here. There is no drift.

## The finding that decides the order of work

`valu-guru-server` is not just a consumer of the Valu Guru socket — it **is**
that socket's server. It registers `valuguru.commerce.*`, `valuguru.sessions.*`
and `rag_search` itself.

So the 11 functions this package routes down the `valuguru` channel are, from
inside that repo, its own handlers. Delegating them through a `ValuGuruSocket`
would be the server calling itself over a socket it is serving. **They are not
adopted there** — `sdk.ts` refuses one at import. On the browser side they are
exactly right: the app is a client of that server.

That splits the package cleanly by consumer:

| channel | n | valu-guru-server | valusocial-web |
|---|---|---|---|
| `roomful` | 54 | **adopted** — 28 offered today, 26 available | adopt |
| `local` | 8 | **adopted** — 3 offered today, 5 available | adopt |
| `valuguru` | 11 | **never** — it is the provider | adopt |
| `app-state` | 5 | the 2 Verus ones are wired to an honest refusal | adopt, supplying `AppState` |

Server-adoptable: **62** (`roomful` + `local`). It offers **31** of them.

One of the 62 is declared by this package rather than by the app's manifest:
`Users.list-connection-requests`, over `request:listRequests`. The rule that
allows it, and the three candidates it deliberately leaves out, are in
[parity.md](parity.md).

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

## Valu Social — next

The app is not a consumer of a missing capability — it is where every one of
these functions came from. Its transition is the inverse of the server's: not
"gain functions" but "stop having two implementations".

- All 92 intents are served today: 87 through a service's `onNewIntent`, and
  the five `AiGuru` dock intents (`open`, `close`, `has-application`,
  `get-applications`, `is-application-loaded`) as `builtin` tools in
  `AiGuruTools.js`, dispatched to `ApplicationCenterStore` rather than through
  a service at all. This package excludes exactly those five from its
  catalogue, which matches.
- **Nothing about the app's intent registry changes.** The 15 it keeps are the
  15 this package never declares, so there is no list here to keep in step with
  it and no method to remove when the app adds an intent.
- 60 intents carry `availability: ['ai']`. This package serves 58 of them; the
  two it does not are `DataProvider.pick-single` and `pick-multiple`, which
  render the application's own UI and return the user's choice.
- The delegation point is each service's `onNewIntent`: build one
  `ServiceClient` over `BrowserSocketAdapter`, and have the service return
  `client.call(...)` instead of its own socket work. `Time` and `Resources` are
  the two-line cases; `Rooms` is the one with real orchestration behind it
  (storyline ordering, the paste pipeline, prop grouping) and should go last.

### The six places behaviour differs

These are decisions, recorded in [parity.md](parity.md), and each one has to be
settled **before** the app delegates that function — the app is the runtime
where the difference is visible to a user.

| function | the difference | what it needs |
|---|---|---|
| `Resources.get-thumbnail-url` | the SDK builds the public URL; the app's RPC also returns decryption metadata, so an encrypted resource gets a URL it cannot decrypt with | reclassify to `socket` and emit `resource:getThumbnailUrl`. Moves the frozen 8/69 local/socket split, so it is a Phase 3 change, not a quiet one |
| `TextChat.get-channel-history` | the SDK does not decrypt | the app already has the key material — pass `appState.decryptMessage`, which the `AppState` interface already declares |
| `TextChat.send-message` | the SDK does not encrypt outbound bodies | needs the mirror of the above: an outbound `appState.encryptMessage`. Not yet declared |
| `Events.create-meeting` | a `direct` meeting with more than one participant is refused; the app silently creates a Group for it | keep the group creation in the app's service, above the SDK call. It is a UI decision with a second write and no undo |
| `Commerce.create-product` | with no `title` the app opens the platform's form; the SDK answers 501 naming that surface | keep the form in the app: check for a title, open the modal if absent, call the SDK if present |
| `Rooms.create-room-from-template` | the app also reloads the Rooms data provider's cached lists | keep the reload in the app's service, after the SDK call |

Four of the six resolve by leaving a thin layer of app-specific behaviour
*above* the SDK call, which is where it belongs. Two need something added to
this package first.

## What is left, in order

1. **Publish the package.** The server currently depends on a COMMIT
   (`github:Roomful/valu-api#<sha>`), because the npm release (1.1.3) predates
   this SDK. That works and needs no credentials — the repository is public —
   but a published `2.0.0` is what the app should depend on. The version is
   breaking: `api.services`, `api.intents` and `ApplicationIntents` are gone,
   and the postMessage bridge no longer serves service functions.
2. **Turn on some of the 31** the server can already reach — minus the two
   `ApplicationStorage` ones until question 2 above has an answer, and with an
   eye on how many tools an agent's prompt can carry.
3. **Settle the `Http` trio** so the AI-facing surface has one shape.
4. **Then the app**, service by service, cheapest first, with the six deltas
   handled as the table says. Its `onNewIntent` is the delegation point and
   `BrowserSocketAdapter` is the socket; nothing about the app's own intent
   registry changes, because this package no longer declares any of it.

## What is still advisory

Scope checking is **client-side and advisory** until Phase 3.3 —
[authorization.md](authorization.md) says so plainly. A scope string on a
descriptor documents what a caller ought to hold; nothing enforces it. Both
consumers above are trusted runtimes, so this is fine for them. **No
third-party framed app gets a socket before that lands**, and neither of these
transitions should be read as permission to hand one out.
