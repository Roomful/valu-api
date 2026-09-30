# Parity with Valu Social and Valu Guru, and how to transition

Measured, not estimated. Every number below comes from reading the three
checkouts, and `node scripts/measure-consumers.mjs` re-derives all of them —
it exits non-zero the moment one of the three has moved, so this report can be
checked rather than believed.

| repository | commit measured | role |
|---|---|---|
| `valu-api` | `ef28001` | this package — one implementation of the platform's service surface |
| `valusocial-web` | `a4407df8` | declares the manifest, serves all 92 intents in the browser, hosts framed apps |
| `valu-guru-server` | `898d699` | runs headless agents over the Roomful socket; **owns** the `valuguru.*` API |

Nothing in either consumer has changed yet. Phase 2 deliberately left both
alone — what exists now is one implementation they can move to, and this is the
report on what moving costs.

## Headline

| | count |
|---|---|
| intents the platform declares | **92** |
| served by this package | **77** (the other 15 need a frame) |
| server tools in valu-guru-server today | **39** |
| … that map to a declared intent | **32** — all 32 implemented here |
| … that do not | **7** — each one decided, all 7 stay server-side |
| intents the app exposes to the AI | **60** — this package serves **58** (the 2 pickers need a frame) |
| net new functions a server agent gains | **+30** |

The vendored manifest snapshot is byte-identical to the app's live
`SERVICE_MANIFESTS`, and the 39 tool names in `scripts/bindings.js` are exactly
the 39 the server's registry holds. There is no drift to reconcile before
starting.

## The finding that decides the order of work

`valu-guru-server` is not just a consumer of the Valu Guru socket — it **is**
that socket's server. It registers `valuguru.commerce.*`, `valuguru.sessions.*`
and `rag_search` itself.

So the 11 functions this package routes down the `valuguru` channel are, from
inside that repo, its own handlers. Delegating them through a `ValuGuruSocket`
would be the server calling itself over a socket it is serving. **They must not
be adopted there.** On the browser side they are exactly right: the app is a
client of that server.

That splits the package cleanly by consumer:

| channel | n | valu-guru-server | valusocial-web |
|---|---|---|---|
| `roomful` | 53 | **adopt** — this is what its tools already do | adopt |
| `local` | 8 | **adopt** — no socket involved | adopt |
| `valuguru` | 11 | **no** — it is the provider | adopt |
| `host-state` | 5 | no — browser store state (it already stubs 2 honestly) | adopt, supplying `HostState` |
| `host` | 15 | no — there is no frame | already the frame |

Server-adoptable: **61**. It has **31** of them today. That is the +30.

## Valu Guru server

### What it already has, and what lands

| service | tools today | served here | net new |
|---|---|---|---|
| Users | 8 | 8 | — |
| Rooms | 8 | 15 | +7 |
| Community | 4 | 4 | — |
| Events | 3 | 3 | — |
| Resources | 3 | 5 | +2 |
| Groups | 2 | 4 | +2 |
| VerusWallet | 2 | 2 | — |
| Networks | 1 | 1 | — |
| TextChat | 1 | 3 | +2 |
| Cbac | 0 | 5 | +5 |
| CMS | 0 | 3 | +3 |
| ApplicationStorage | 0 | 3 | +3 |
| Profile | 0 | 2 | +2 |
| Http | 0 | 3 | +3 |
| Time | 0 | 1 | +1 |
| Commerce | 0 | 10 | not here — the server provides them |
| AiGuru | 0 | 3 | not here — 2 host-state, 1 is its own RAG |
| Developer | 0 | 2 | not here — Developer Portal is browser state |

The 30, by name:

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
| Time | `get-local-time` |

### The delegation point

One place, and it is small. `valuToolRegistry.dispatch(name, args, ctx)` returns
a JSON string; `ServiceClient.call(key, params)` resolves an ack. The adapter
between them is the whole change:

```ts
const client = new ServiceClient({
  transport: new SocketTransport({
    socket: new NodeSocketAdapter({ connection: ctx.socket }),
    fetchImpl: fetch,
    config: { webBase: process.env.ROOMFUL_WEB_BASE, apiGate: `https://${process.env.ROOMFUL_API_HOST}` },
  }),
});

const ack = await client.call(name, args);          // name is already `service__Users__get`
return JSON.stringify(ack.error ? { success: false, error: ack.error.message } : ack.data);
```

`ServiceClient` resolves `service__Users__get` as readily as `Users.get`, so the
tool names on the wire do not change — which matters, because
`withGenericServerTools`, `isWorkerSocketTool` and the browser-twin de-duping
all key on those names, and none of that logic needs touching.

`ValuToolContext.socket` already satisfies `ValuSocket` structurally: identical
`emit(ns, data, timeoutMs)`, identical ack envelope, same optional
`onResourceUpdated`, same `underlying`. The contract was lifted out of
`src/valu-tools/types.ts` in Phase 1 and this package is now canonical; the
server's local copy can be replaced with an import, which is the smallest
possible first commit.

### Five things to settle in that repo

1. **The `Http` trio is currently blocked on the wire.** `http.ts` collapsed
   `service__Http__ping|get|post` into `service__Http__curl`, and
   `LEGACY_HTTP_TOOL_NAMES` actively strips the three names from any tool list
   so a stale frontend cannot advertise them. This package implements all
   three. Decide which is the AI-facing form: keep `curl` and have it call the
   three declared functions (that was the Phase 2b decision, and it needs no
   manifest change), or stop stripping and expose all four. Do not do both by
   accident — the strip list would silently win.

2. **Commerce and ApplicationStorage need an application identity, and a server
   agent has none.** Five functions refuse with 403 without it —
   `Commerce.list-products`, `Commerce.get-product`, `Commerce.add-to-cart`,
   `ApplicationStorage.resource-upload`, `ApplicationStorage.resource-search`.
   `ValuToolContext` carries `userId`, `agentId` and `sessionId` but no
   `applicationId`, and the id is deliberately never read from a caller's
   params. Commerce is not adoptable there anyway, so this reduces to: what
   application does an agent's own storage belong to? Until that is answered,
   the two `ApplicationStorage` reads/writes stay out and CMS (which addresses
   a room/prop/community instead) carries the load.

3. **VerusWallet stays as it is.** Both functions need
   `host.getAgentWallet` — `get-balance` because there is no ack-returning
   balance RPC at all, `transfer` because the declared param is an agent id and
   the RPC wants the wallet's identity and i-address. That is the same honest
   gap the server's own stubs record, and the reason the pair is excluded from
   the worker socket lane. Adopting this package does not close it; keep the
   browser twins for chat-spawned workers exactly as today.

4. **The TextChat pair stays server-only.** `message_user` and `send_card` post
   as the **agent**, and the server already guards them behind
   `AGENT_IDENTITY_TOOL_NAMES`. This package's three TextChat functions post as
   the user. Nothing changes; the guard keeps working because the names do.

5. **`get-channel-history` will not decrypt.** Headless has no key material, so
   an encrypted body comes back flagged `encrypted: true` rather than as
   ciphertext that reads like a message. That is strictly better than the
   server's tools, which do not decrypt either and do not say so — but an agent
   prompt that assumes readable history needs to expect the flag.

## Valu Social

The app is not a consumer of a missing capability — it is where every one of
these functions came from. Its transition is the inverse of the server's: not
"gain functions" but "stop having two implementations".

- All 92 intents are served today: 87 through a service's `onNewIntent`, and
  the five `AiGuru` dock intents (`open`, `close`, `has-application`,
  `get-applications`, `is-application-loaded`) as `builtin` tools in
  `AiGuruTools.js`, dispatched to `ApplicationCenterStore` rather than through
  a service at all. This package classifies exactly those five as frame
  commands, which matches.
- 60 intents carry `availability: ['ai']`. This package serves 58 of them; the
  two it does not are `DataProvider.pick-single` and `pick-multiple`, which
  render host UI and return the user's choice.
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
| `TextChat.get-channel-history` | the SDK does not decrypt | the app already has the key material — pass `host.decryptMessage`, which the `HostState` interface already declares |
| `TextChat.send-message` | the SDK does not encrypt outbound bodies | needs the mirror of the above: an outbound `host.encryptMessage`. Not yet declared |
| `Events.create-meeting` | a `direct` meeting with more than one participant is refused; the app silently creates a Group for it | keep the group creation in the app's service, above the SDK call. It is a UI decision with a second write and no undo |
| `Commerce.create-product` | with no `title` the app opens the platform's form; the SDK answers 501 naming that surface | keep the form in the app: check for a title, open the modal if absent, call the SDK if present |
| `Rooms.create-room-from-template` | the app also reloads the Rooms data provider's cached lists | keep the reload in the app's service, after the SDK call |

Four of the six resolve by leaving a thin layer of app-specific behaviour
*above* the SDK call, which is where it belongs. Two need something added to
this package first.

## Prerequisites, in order

1. **Make the package importable.** `package.json` has `main` and no `exports`
   map, so a consumer reaches `ServiceClient` through a deep path
   (`@arkeytyp/valu-api/src/services/ServiceClient.js`) that no version
   guarantees. Add an `exports` map naming the entry points a consumer needs —
   `ServiceClient`, the transports, both socket adapters, `FrameCommands`, the
   catalogue and `toolDefinitions` — and publish. Everything else waits on
   this.
2. **Replace the server's `ValuSocket` copy with an import.** No behaviour
   change, and it proves the dependency in one commit.
3. **Delegate the 32 exact-name server tools.** They are already socket-only
   and already carry the same service/function split; the adapter above is the
   change. The per-function conformance table in this package covers them
   against both adapters, so a regression surfaces here rather than in an agent
   run.
4. **Turn on the 30 net-new ones** — minus the two `ApplicationStorage` reads
   until question 2 above has an answer.
5. **Settle the `Http` trio** so the AI-facing surface has one shape.
6. **Then the app**, service by service, cheapest first, with the six deltas
   handled as the table says.

## What is still advisory

Scope checking is **client-side and advisory** until Phase 3.3 —
[authorization.md](authorization.md) says so plainly. A scope string on a
descriptor documents what a caller ought to hold; nothing enforces it. Both
consumers above are trusted runtimes, so this is fine for them. **No
third-party framed app gets a socket before that lands**, and neither of these
transitions should be read as permission to hand one out.
