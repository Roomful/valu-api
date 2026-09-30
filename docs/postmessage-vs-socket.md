# postMessage and socket

Every call this package makes leaves on one of two paths. The catalogue's
`binding` names which:

- **`socket`** — a connection *this package holds to a server* and speaks
  itself. There are two such servers, so `channel` says which one.
- **`postmessage`** — a `postMessage` to the **Valu Social application** that
  embedded your app in an iframe. Not a server; a browser tab, on the other side
  of the frame boundary.
- **`local`** — neither. The SDK answers it from config, the clock or `fetch`.

A socket points **away** from the browser, at a server. postMessage points at
the page **around** you. And — this is what Phase 1 was for — you do not need
the page around you in order to reach a socket: a Node agent with a connection
calls the socket functions with no browser anywhere.

```
  your app (an iframe)                         a Node agent (no browser)
        │                                             │
        │  postMessage bridge                         │
        │  ──────────────────►  Valu Social (a tab)   │
        │                       │   dock, modals,     │
        │                       │   pickers, stores   │
        │                       │   ← only it can     │
        │                       │     do these        │
        │                       │                     │
        │                       └── its socket ──┐    └── its own sockets ──┐
        │                                        ▼                         ▼
        └───────────────────────────────►  Roomful server  ·  Valu Guru server
              (over postMessage only)           ▲                         ▲
                                                └── the same RPCs, either way
```

## This used to be called "host"

It was one word doing four jobs, which is why it stopped making sense. The word
is gone; these are the names now, and the transport is what each one is named
after.

| was | is | what it means |
|---|---|---|
| "the host" | **the Valu Social application** | the app embedding your iframe — the other end of the bridge. Named, not nicknamed |
| `binding: 'host'` | `binding: 'postmessage'` | an intent only that application can serve: it opens a dock, renders a picker, mints an identity token. No RPC exists for it anywhere |
| `channel: 'host-state'` | `channel: 'app-state'` | declared socket-bound, but the answer is in the application's **memory**. Also no RPC — see below, this is the one that still needs explaining |
| `SocketTransport({ host })` | `SocketTransport({ appState })` | the object a **non-browser** runtime passes in so it can serve those five itself |
| `transport.supportsBridge` | `transport.supportsPostMessage` | whether there is a Valu Social application on the other end at all |

Two names deliberately did **not** become `postmessage`:

- **`app-state`** is named after the *source* of the answer, not a transport,
  because a headless runtime serves those five functions with no bridge in
  sight. `binding` still says how you reach it; `app-state` says where the
  answer comes from.
- **`ApplicationIntents`** is named after what it asks for, not how it travels.
  It is the one dynamic call that runs *any* intent the Valu Social application
  declares — the fifteen below, and the ones it registers after this release.
  (It replaced `FrameCommands`, which had a method per intent; see
  [sdk-structure.md](sdk-structure.md) for why that was the wrong shape.)

And a fifth meaning the package never had: `postmessage` has nothing to do with
a hostname or an origin. Origins are `config.webBase` and `config.apiGate`
([`src/Config.js`](../src/Config.js)).

## Where each kind of function can run

A framed app and a headless agent do not have the same surface, and
`binding`/`channel` is how the catalogue says so.

| | framed browser app (bridge) | headless agent (socket) |
|---|---|---|
| `roomful` — 54 | Valu Social serves it, over its socket | you serve it, over yours |
| `valuguru` — 11 | Valu Social serves it | you serve it, if you passed `guru` |
| `local` — 8 | Valu Social serves it | the SDK answers it; no connection needed |
| `app-state` — 5 | Valu Social serves it from memory | only if you passed an `appState` object that holds the state |
| `postmessage` — 15 | Valu Social serves it | **501, always** — there is no frame to command |

The one thing to take from it: **inside a frame, `channel` does not matter to
you.** Every call leaves as one bridge message (`api:service-intent`) and the
application decides how to answer it, so all 92 of its intents are reachable
from an iframe and none of them needs a socket from you. `channel` starts to
matter the moment there is no application around you — which is exactly the
case this package was built for.

Reachable is not the same as "on the function surface", and the difference is
deliberate. `api.services` offers the 78 **service functions** — the ones this
package can run itself, here or in Node. The other 15 are **application
intents**: `api.intents.run(name, params)` asks for one by name, on the same
wire. [sdk-structure.md](sdk-structure.md) is why those are two things.

## Why the 15 cannot become socket functions

Not a missing feature. There is no RPC to write down. "Open the cart drawer",
"expand my pane", "show a contact picker and wait for the user" are things that
happen to a rendered page; a server has nothing to say about them. So they are
not service functions at all, and a socket answers all fifteen with the same
501 rather than pretending:

```javascript
await client.call('DataProvider.pick-single', { providers: ['contacts'] });
// → 501 "DataProvider.pick-single is postMessage-bound — call it over the
//        postMessage bridge, not the socket"
```

They are asked for by name instead —
[`ApplicationIntents`](../src/intents/ApplicationIntents.js), one dynamic call,
the same bridge traffic:

```javascript
const api = new ValuApi();
await api.intents.run('AiGuru.open', { applicationId: 'cart' });
const picked = await api.intents.run('DataProvider.pick-single', { providers: ['contacts'] });
```

There is no method per intent on purpose: the application registers its intents
at runtime, so a method here would be a copy of a list that moves without this
package — `run()` posts any `Service.action` it is given, including names newer
than this release.

`ApplicationIntents` refuses a socket transport **at construction**
(`supportsPostMessage` is false there), because discovering it per call would be
fifteen identical surprises.

## Why the 5 are the confusing ones

`AiGuru.get-chat-history`, `AiGuru.get-agent-history`,
`Developer.list-applications`, `Developer.create-application`,
`VerusWallet.get-balance`.

The manifest declares them like any other data intent, so Phase 1 recorded
`binding: 'socket'` — that is what the manifest implies. Phase 2 went looking
for the RPC and there is none: the answer is a list the Valu Social application
is already holding in memory, or a balance it cached off a push. The SDK does
**not** invent a network call for them. A runtime that holds the state
implements [`AppState`](../src/app-state/AppState.js) and passes it in; one that
does not gets an ack naming the single capability it wanted:

```javascript
await client.call('AiGuru.get-chat-history', {});
// → 501 "AiGuru.get-chat-history needs application state (getChatHistory),
//        and this runtime has none"
```

`binding` says *how you reach it*; `channel` says *what answers*. These five are
the only place the two disagree — reached over postMessage in a frame, answered
from memory either way — and inverting that coupling is what Phase 3.1 exists
for.

## The bridge carries five kinds of traffic, not one

"Going over the bridge" is not one mechanism. These are the messages
`IFrameStore` in valusocial-web actually answers, and what this package puts in
front of each:

| bridge message | what it is | typed API here |
|---|---|---|
| `api:service-intent` | one of the 92 declared intents | `api.services.*` (the 78) and `api.intents.run(...)` (any of them) |
| `api:create-pointer` + `api:run` | an **API pointer** call — the older, generic path | none: `api.getApi(name).run(fn, params)` |
| `api:run-intent` | an intent aimed at another application | `api.sendIntent(intent)` |
| `api:run-console` | a console command (`/chat -h`) | `api.runConsoleCommand(cmd)` |
| `api:run-command` | `pushRoute` / `replaceRoute` | `api.pushRoute(path)` |

(A quirk worth knowing if you ever read the wire: the application answers *both*
`api:service-intent` and `api:run-console` with `api:run-console-completed`.
`PostMessageTransport` correlates on `requestId`, so it does not care, but the
reply names are not one-to-one with the request names.)

## API pointers, and what still needs them

An API pointer travels over postMessage, like an application intent does, but it
is a **different mechanism from either** of the two above — older, and generic. You
ask the application for a pointer to one of its named API modules, then call
functions on it by string:

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
   `ApplicationIntents` both send `api:service-intent`. `ValuApi.getApi()` is the
   only pointer entry point in the package, and Phases 1 and 2 did not touch
   it — it works exactly as it did.
2. **The pointer surface is not a subset of the declared one.** 41 of its 63
   functions have no declared intent, so they are reachable *only* that way:
   theming, resize, network switching, modals, logout, chat-channel
   resolution, removing a connection, the crypto seed.

The inventory — every module, every function, which ones now have an SDK
equivalent and which ones do not — is [api-pointers.md](api-pointers.md).

## Which to use for what

- **A service function, from an iframe** → `api.services.Users.current()`, or
  `api.services.call('Users.current')` if you have the name as a string.
  Validated, cached, one ack shape.
- **A service function, from a Node service or an agent** →
  `createValuServices({ socket })`. The same 78 functions, the same names. The
  list is [service-api.md](service-api.md) and
  [socket-functions.md](socket-functions.md); what your runtime must supply is
  [server-functions.md](server-functions.md).
- **Something that happens to the page** (open, close, expand, pick, logs,
  identity token) → `api.intents.run('...')`. Only from an iframe.
- **Something the platform does not declare as an intent** → an API pointer.
  Untyped and unvalidated, and the honest answer for now
  ([api-pointers.md](api-pointers.md)).
- **Talking to another application** → `api.sendIntent(intent)`.

## The counts, in one place

| | n | served by |
|---|---|---|
| declared intents | 92 | — |
| SDK-declared functions | 1 | this package, where the manifest has a gap ([sdk-structure.md](sdk-structure.md)) |
| service functions | 78 | this package, over whatever transport it has |
| on the Roomful socket | 54 | a server, over the platform socket |
| on the Valu Guru socket | 11 | a different server, `data_request` channel |
| local to the SDK | 8 | this package, from config / clock / `fetch` |
| application state | 5 | whoever holds the state; no RPC exists |
| postMessage-bound (application intents) | 15 | the Valu Social application only; no RPC exists |
| API pointer functions | 63 | that application's own API modules, by string |

Every row above is asserted against the thing it describes — this file is prose
rather than generated output, and prose with numbers in it rots, so
`test/postmessage-vs-socket.test.js` reads them back out of the catalogue and
the pointer inventory and fails the build if one has moved. The pointer row is
re-measured against a real app checkout by `npm run measure:api-pointers`.
