# The Valu Service SDK

A library of **78 socket functions**: one implementation of every Valu service
call, reusable from the Valu Social application, from the Valu Guru server, from
a Node script, and from an iframe application once it has a socket.

That is the whole of it. There is no second surface, no per-intent method for
things only the application can do, and nothing in the catalogue that behaves
differently depending on where it runs.

| read this | for |
|---|---|
| [socket-functions.md](socket-functions.md) | **every function, the feature it provides and what it needs** — start here |
| [service-api.md](service-api.md) | the same functions as the call you would write, one line each |
| [api-pointers.md](api-pointers.md) | the postMessage bridge: API pointers, and any application intent by name |
| [parity.md](parity.md) | who implements what, the server-only tools, the known deltas |
| [transition.md](transition.md) | how the two consumers adopt this, and in what order |
| [callbacks-policy.md](callbacks-policy.md) | timeout, retry, ordering, reconnect — frozen |
| [authorization.md](authorization.md) | the app token, and why scopes are still advisory |

## The one rule

**Can this package run it itself, given a connection?**

If yes it is a function here, with a descriptor, params that are validated, a
cache policy and a handler. If no — a dock that opens, a picker that renders, a
log buffer only the application holds — it is not here at all. The iframe
application asks the Valu Social application for it **by name**, over the
postMessage bridge, and nothing has to be declared on this side for that to
work:

```javascript
const api = new ValuApi();
await api.callService(new Intent('AiGuru', 'open', { applicationId: 'cart' }));
await api.sendIntent(new Intent('chatApp', Intent.ACTION_OPEN, { roomId }));
const usersApi = await api.getApi('users');   // an API pointer
```

The application registers its intents at runtime, so a method per intent here
would be a copy of a list that moves without us. The manifest declares 92
intents; 77 of them are functions in this package, and the other 15 are named
in [parity.md](parity.md) with the reason each one cannot be.

## The shape of it

```
   your runtime            createValuServices({ socket, guru, appState })
        │                                     │
        └── ValuSocket ──▶ SocketTransport ──▶ ServiceClient ──▶ valu.Users.get()
            (browser or      (the only             │
             node adapter)    service transport)   descriptor → validate →
                                                   scope → cache → retry
```

| piece | file | what it decides |
|---|---|---|
| Transport | `src/transport/Transport.js` | what carries a call |
| Socket | `src/transport/SocketTransport.js` | declared functions over a `ValuSocket` — the only transport that serves them |
| Bridge | `src/transport/PostMessageTransport.js` | the iframe ↔ application traffic: pointers, intents, console, routes |
| Socket contract | `src/socket/ValuSocket.js` | the ack envelope, and what a socket must offer |
| Adapters | `src/socket/{Browser,Node}SocketAdapter.js` | the app's WebSocket service / `RoomfulConnectionManager` |
| Descriptors | `src/services/catalog.generated.js` | every function, generated from the manifest |
| Registry | `src/services/registry.js` | where a function's implementation is registered |
| Validation | `src/services/validate.js` | whether a call is well-formed |
| Policy | `src/CallPolicy.js` | timeout, retry, ordering, reconnect — **frozen** |
| Cache | `src/cache/ServiceCache.js` | what replaces the store for data services |
| Auth | `src/auth/` | the app token, and never the session |
| Guru socket | `src/socket/ValuGuruSocket.js` | the SECOND socket — `valuguru.*` ops |
| Application state | `src/app-state/AppState.js` | the five functions no RPC can answer |
| Upload | `src/upload/ResourceUpload.js` | register → link → PUT → complete |
| Implementations | `src/services/impl/` | the 78 functions themselves |
| Function surface | `src/services/api.js` | `valu.Users.current()` — the tree, and `createValuServices` |
| SDK-declared | `scripts/extensions.js` | functions this package declares where the manifest has a gap |

## Using it

In a browser — the Valu Social application, or an iframe app with a socket:

```javascript
const socket = new BrowserSocketAdapter({ socket: webSocketService, userId, networkId });
const valu = createValuServices({ socket });
const user = await valu.data.Users.get({ userId }); // the payload, throws on failure
```

Headless — the Valu Guru server, or any Node process:

```javascript
const socket = new NodeSocketAdapter({ connection: roomfulConnection });
const valu = createValuServices({ socket });

const ack = await valu.Users.get({ userId });          // { data } | { error }
const byName = await valu.call('Users.get', { userId }); // what an LLM tool call has
```

A function resolves by any name the platform already writes: `Users.get`,
`Users.get_user`, `Users.getUser`, `service__Users__get`.

## Four channels

`channel` is the only axis on a descriptor, and it says which connection
answers — which is what a handler needs and what a caller has to supply:

| channel | count | what serves it | what a handler gets |
|---|---|---|---|
| `roomful` | 54 | the platform socket | `ctx.socket.emit(ns, payload)` |
| `valuguru` | 11 | the Valu Guru server's `data_request` channel | `ctx.guru.request(op, params)` |
| `app-state` | 5 | nothing — the runtime holds the answer | `ctx.appState.<capability>()` |
| `local` | 8 | the SDK itself | `ctx.config`, `ctx.fetchImpl`, `ctx.now` |

A transport that lacks a channel refuses the functions that need it **by
name**, before the handler runs:

```javascript
const valu = createValuServices({ socket });      // no guru, no appState
await valu.call('Commerce.get-cart');
// → 503 "Commerce.get-cart needs the Valu Guru socket, and none was supplied"
```

Supplying them:

```javascript
const valu = createValuServices({
  socket,                                       // the Roomful socket — always
  guru: guruAdapter(aiGuruService),             // for the 11 valuguru functions
  appState: { getAgentWallet, getChatHistory }, // for the 5 app-state ones
  applicationId: 'my-app',                      // Commerce + ApplicationStorage scope
  config: { webBase, apiGate },                 // the local resource-URL builders
});
```

`applicationId` is stamped by the **runtime** and never read from a caller's
params: Commerce scopes every catalogue read and write to it, and a framed app
must not be able to sell as another app. A transport without one answers those
functions 403.

The Valu Guru server must **not** route the 11 `valuguru` functions through
this package: that server *is* the other end of that channel.

## The catalogue

```javascript
catalogSummary();
// { total: 78, roomful: 54, valuguru: 11, 'app-state': 5, local: 8, socket: 65,
//   implemented: 32, declared: 77, sdkDeclared: 1, serviceFunctions: 78,
//   applicationOnly: 15, remaining: 46, serverOnly: 7 }
```

`declared` is what the application's manifest says and does not move when this
package adds a function; `sdkDeclared` is what this package adds;
`applicationOnly` is the intents the manifest declares that only the
application can serve, which are deliberately not descriptors. Counted from
`manifests/service-manifests.snapshot.json` rather than estimated, and asserted
in `test/catalog.test.js` — a drift fails the build, and a NEW intent in the app
fails it too until somebody classifies it.

Regenerating:

```bash
npm run sync:manifests -- --from ../valusocial-web   # re-snapshot the app manifest
npm run build                                        # catalogue + types + docs
npm test                                             # includes a staleness check
```

The snapshot is vendored on purpose: this package must not depend on the app
repo to build.

## Adding a function

Descriptor · implementation · param validation · conformance test green on both
adapters · generated docs entry:

1. **Descriptor** — it already exists if the app declares the intent. Add its
   `channel` and `returns` in `scripts/functions.js`, and correct `cache` /
   `mutates` in `scripts/bindings.js` if the derived default is wrong for this
   function. `npm run build`.
2. **Implementation** — a module in `src/services/impl/`, registered from
   `impl/index.js`:
   ```javascript
   registry.define('Service.action', (params, ctx) =>
     rpc(ctx, 'ns:rpcName', { ...payload }, (data) => ({ shaped: data.thing })));
   ```
   Pass the RPC's OWN payload: the transport adds the `{data}` envelope.
   Resolve an ack; do not throw, do not retry.
3. **Test** — add a case to the table in `test/conformance/functions.js`. It
   runs against both adapters already, and the suite fails if a registered
   function has no case, so this is not optional.

Things a handler must not do, because the layers above already do them:
validate params, check scopes, read or write the cache, retry, or time itself
out.

An intent that only the application can serve is added to `APPLICATION_ONLY`
in `scripts/bindings.js` instead, with a line saying why — that is the list the
generator excludes by, and the list a reader of [parity.md](parity.md) sees.

## Known behaviour deltas

Recorded in [parity.md](parity.md) rather than hidden. The two worth knowing
before you delegate a call: `Resources.get-thumbnail-url` builds the public URL
(as the server does) instead of emitting the app's RPC, which also returns
decryption metadata for an encrypted resource; and `TextChat` neither encrypts
what it sends nor decrypts what it reads, because that key material is the
browser's — an encrypted body comes back flagged `encrypted: true` rather than
as noise that reads like a message.

## Running the checks

```bash
npm test         # the staleness check + the per-function conformance table,
                 # run against BOTH adapters
npm run build    # catalogue, types, docs and the parity matrix
npm run typecheck
npm run measure:consumers   # re-measure transition.md against the two consumer
                            # repos; non-zero the moment one has moved
npm run measure:api-pointers # re-measure the API-pointer inventory against the
                             # app; non-zero the moment a module or function moves
```

## The two frozen decisions

[The descriptor format](../src/services/descriptors.js) and [the callbacks
policy](callbacks-policy.md). Changing either means touching every call site.
