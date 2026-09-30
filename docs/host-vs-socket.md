# Host and socket

The word **host** names four different things in this package, and the docs use
it for all four. That is the reason it stopped making sense, and this file is
the fix.

Start with the two words on their own:

- A **socket** is a connection *this package holds to a server* and speaks
  itself. There are two of them, to two different servers.
- The **host** is the *Valu Social application your app is embedded in*. It is
  not a server. It is a browser tab, and you reach it by `postMessage` through
  the iframe that contains you.

So a socket points **away** from the browser, at a server. The host is the thing
**around** you. And — this is what Phase 1 was for — you do not need the host to
reach a socket: a Node agent with a connection calls the socket functions with
no browser anywhere.

```
  your app (an iframe)                         a Node agent (no browser)
        │                                             │
        │  postMessage bridge                         │
        │  ── "the host" ──►  Valu Social (a tab)     │
        │                       │   dock, modals,     │
        │                       │   pickers, stores   │
        │                       │   ← only it can     │
        │                       │     do these        │
        │                       │                     │
        │                       └── its socket ──┐    └── its own sockets ──┐
        │                                        ▼                         ▼
        └───────────────────────────────►  Roomful server  ·  Valu Guru server
                     (only via the host)        ▲                         ▲
                                                └── the same RPCs, either way
```

## The four meanings of "host", disambiguated

| where you meet it | what it means there |
|---|---|
| "the host", `PostMessageTransport`, `supportsBridge` | the Valu Social application embedding your iframe — the other end of the bridge |
| `binding: 'host'` — 15 intents | an intent **only that application can serve**: it opens a dock, renders a picker, mints an identity token. No RPC exists for it anywhere |
| `channel: 'host-state'` — 5 intents | declared socket-bound, but the answer is **in the host's memory**. Also no RPC — see below, this is the confusing one |
| the `host` option of `SocketTransport`, and the `requires: host` column in [server-functions.md](server-functions.md) | the object a **non-browser** runtime passes in so it can serve those 5 itself |

There is a fifth meaning the package deliberately never uses: *host* never
means a hostname or an origin here. Origins are `config.webBase` and
`config.apiGate` ([`src/Config.js`](../src/Config.js)).

## Where each kind of function can run

This is the practical version of the same table. A framed app and a headless
agent do not have the same surface, and `binding`/`channel` is how the
catalogue says so.

| | framed browser app (bridge) | headless agent (socket) |
|---|---|---|
| `roomful` — 53 | the host serves it, over its socket | you serve it, over yours |
| `valuguru` — 11 | the host serves it | you serve it, if you passed `guru` |
| `local` — 8 | the host serves it | the SDK answers it; no connection needed |
| `host-state` — 5 | the host serves it from memory | only if you passed a `host` object that holds the state |
| `host` — 15 | the host serves it | **501, always** — there is no frame to command |

The one thing to take from it: **inside a frame, `channel` does not matter to
you.** `ServiceClient` over a `PostMessageTransport` sends every call as one
bridge message (`api:service-intent`) and the host decides how to answer it, so
all 92 are available and none of them needs a socket from you. `channel` starts
to matter the moment there is no host — which is exactly the case this package
was built for.

## Why the 15 cannot become socket functions

Not a missing feature. There is no RPC to write down. "Open the cart drawer",
"expand my pane", "show a contact picker and wait for the user" are things that
happen to a rendered page; a server has nothing to say about them. So they are
not service functions at all, and a socket answers all fifteen with the same
501 rather than pretending:

```javascript
await client.call('DataProvider.pick-single', { providers: ['contacts'] });
// → 501 "DataProvider.pick-single is host-bound — call it through the frame
//        bridge, not the socket"
```

They get a named API instead —
[`FrameCommands`](../src/frame/FrameCommands.js), one method each, the same
bridge traffic:

```javascript
const api = new ValuApi();
await api.frame.openApplication('cart');
const picked = await api.frame.pickSingle({ providers: ['contacts'] });
```

`FrameCommands` refuses a socket transport **at construction**, because
discovering it per call would be fifteen identical surprises.

## Why the 5 are the confusing ones

`AiGuru.get-chat-history`, `AiGuru.get-agent-history`,
`Developer.list-applications`, `Developer.create-application`,
`VerusWallet.get-balance`.

The manifest declares them like any other data intent, so Phase 1 recorded
`binding: 'socket'` — that is what the manifest implies. Phase 2 went looking
for the RPC and there is none: the answer is a list the host is already holding
in memory, or a balance it cached off a push. The SDK does **not** invent a
network call for them. A runtime that holds the state implements
[`HostState`](../src/host/HostState.js) and passes it in; one that does not gets
an ack naming the single capability it wanted:

```javascript
await client.call('AiGuru.get-chat-history', {});
// → 501 "AiGuru.get-chat-history needs host state (getChatHistory), and this
//        runtime has none"
```

`binding` says *the kind of thing that answers*; `channel` says *which thing*.
These five are the only place the two disagree, and inverting that coupling is
what Phase 3.1 exists for.

## The bridge carries five kinds of traffic, not one

"Going through the host" is not one mechanism. These are the messages
`IFrameStore` in valusocial-web actually answers, and what this package puts in
front of each:

| bridge message | what it is | typed API here |
|---|---|---|
| `api:service-intent` | one of the 92 declared intents | `api.services.call(...)` and `api.frame.*` |
| `api:create-pointer` + `api:run` | an **API pointer** call — the older, generic path | none: `api.getApi(name).run(fn, params)` |
| `api:run-intent` | an intent aimed at another application | `api.sendIntent(intent)` |
| `api:run-console` | a console command (`/chat -h`) | `api.runConsoleCommand(cmd)` |
| `api:run-command` | `pushRoute` / `replaceRoute` | `api.pushRoute(path)` |

(A quirk worth knowing if you ever read the wire: the host answers *both*
`api:service-intent` and `api:run-console` with `api:run-console-completed`.
`PostMessageTransport` correlates on `requestId`, so it does not care, but the
reply names are not one-to-one with the request names.)

## API pointers, and what still needs them

An API pointer goes through the host, like a frame command does, but it is a
**different mechanism from either** of the two above — older, and generic. You
ask the host for a pointer to a named API module, then call functions on it by
string:

```javascript
const usersApi = await valuApi.getApi('users');   // api:create-pointer
const me = await usersApi.run('current');         // api:run
```

There is no catalogue of those functions in this package and no per-function
method, which is the observation behind the question this doc answers: the
service SDK has a function per service *because* it carries the
implementations, and the pointer surface has none *because* it carries nothing
but the string you pass.

Two facts about the relationship, both worth stating plainly:

1. **Nothing in the service SDK uses an API pointer.** `ServiceClient` and
   `FrameCommands` both send `api:service-intent`. `ValuApi.getApi()` is the
   only pointer entry point in the package, and Phases 1 and 2 did not touch
   it — it works exactly as it did.
2. **The pointer surface is not a subset of the declared one.** 41 of its 63
   functions have no declared intent, so they are reachable *only* that way:
   theming, resize, network switching, modals, logout, chat-channel
   resolution, removing a connection, the crypto seed.

The inventory — every module, every function, which ones now have an SDK
equivalent and which ones do not — is [api-pointers.md](api-pointers.md).

## Which to use for what

- **A declared function, from an iframe** → `api.services.call(...)`. Validated,
  cached, one ack shape.
- **A declared function, from a Node service or an agent** →
  `ServiceClient` over `SocketTransport`. The list is
  [socket-functions.md](socket-functions.md); what your runtime must supply is
  [server-functions.md](server-functions.md).
- **Something that happens to the page** (open, close, expand, pick, logs,
  identity token) → `api.frame.*`. Only from an iframe.
- **Something the platform does not declare as an intent** → an API pointer.
  Untyped and unvalidated, and the honest answer for now
  ([api-pointers.md](api-pointers.md)).
- **Talking to another application** → `api.sendIntent(intent)`.

## The counts, in one place

| | n | served by |
|---|---|---|
| declared intents | 92 | — |
| on the Roomful socket | 53 | a server, over the platform socket |
| on the Valu Guru socket | 11 | a different server, `data_request` channel |
| local to the SDK | 8 | this package, from config / clock / `fetch` |
| host state | 5 | whoever holds the state; no RPC exists |
| host-bound (frame commands) | 15 | the Valu Social app only; no RPC exists |
| API pointer functions | 63 | the host's own API modules, by string |

Every row above is asserted against the thing it describes — this file is prose
rather than generated output, and prose with numbers in it rots, so
`test/host-vs-socket.test.js` reads them back out of the catalogue and the
pointer inventory and fails the build if one has moved. The pointer row is
re-measured against a real app checkout by `npm run measure:api-pointers`.
