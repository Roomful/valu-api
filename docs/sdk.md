# The Valu Service SDK

A library of **78 service functions** over the Valu sockets — the same functions
from a Valu Social build, a frame application and the Valu Guru server — and
**one dynamic call** for everything only the Valu Social application can serve.

| read this | for |
|---|---|
| [sdk-structure.md](sdk-structure.md) | **what this package is, and why `close` is not a function** — start here |
| [service-api.md](service-api.md) | every function, as the call you would write |
| [postmessage-vs-socket.md](postmessage-vs-socket.md) | what `postmessage` and `socket` actually mean here |
| [socket-functions.md](socket-functions.md) | the 65 functions that travel over a socket, and the feature each one provides |
| [api-pointers.md](api-pointers.md) | the older generic path over the postMessage bridge, and the 41 things only it can do |
| [server-functions.md](server-functions.md) | the 78 functions this package serves, and what a runtime must supply for each |
| [services.md](services.md) | every intent the platform declares, params and all |
| [parity.md](parity.md) | who implements what, the server-only tools, the known deltas |
| [transition.md](transition.md) | parity with Valu Social and Valu Guru as they stand, and the order to move them |
| [callbacks-policy.md](callbacks-policy.md) | timeout, retry, ordering, reconnect — frozen |
| [authorization.md](authorization.md) | the app token, and why scopes are still advisory |

The bridge traffic is byte for byte what it always was. Two things on the
`ValuApi` surface did change when the two surfaces were separated:
`api.frame.*` became `api.intents.run(name, params)`, and `api.services` no
longer serves an application intent — both in
[sdk-structure.md](sdk-structure.md), with a row per method.

## The shape of it

```
                       ServiceClient
       descriptor → validate → scope → cache → transport → retry
                             │
              ┌──────────────┴──────────────┐
      PostMessageTransport            SocketTransport
     (the postMessage bridge)      (browser | node adapter)
```

| piece | file | what it decides |
|---|---|---|
| Transport | `src/transport/Transport.js` | what carries a call |
| Bridge | `src/transport/PostMessageTransport.js` | today's postMessage traffic, unchanged |
| Socket | `src/transport/SocketTransport.js` | declared functions over a `ValuSocket` |
| Socket contract | `src/socket/ValuSocket.js` | the ack envelope, and what a socket must offer |
| Adapters | `src/socket/{Browser,Node}SocketAdapter.js` | the app's WebSocket service / `RoomfulConnectionManager` |
| Descriptors | `src/services/catalog.generated.js` | every declared function, generated from the manifest |
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
| Application intents | `src/intents/ApplicationIntents.js` | the dynamic call for what only the app can serve |
| SDK-declared | `scripts/extensions.js` | functions this package declares where the manifest has a gap |

## Using it

Over the bridge — every existing app already has this, it is just typed now:

```javascript
const api = new ValuApi();
const ack = await api.services.Users.get({ userId });
if (ack.error) console.warn(ack.error.message);
else console.log(ack.data);
```

Over a socket, in the browser:

```javascript
const socket = new BrowserSocketAdapter({ socket: webSocketService, userId, networkId });
const valu = createValuServices({ socket });
const user = await valu.data.Users.get({ userId }); // the payload, throws on failure
```

Over a socket, headless:

```javascript
const socket = new NodeSocketAdapter({ connection: roomfulConnection });
const valu = createValuServices({ socket });
```

A function resolves by any name the platform already writes: `Users.get`,
`Users.get_user`, `Users.getUser`, `service__Users__get`.

## Three channels, not one

Phase 1 recorded `binding: socket | local | postmessage`. Writing the functions showed
that **"socket" is three different things**, and a function written for the
wrong one fails in a way the ack envelope cannot explain. Every descriptor now
also carries a `channel`:

| channel | count | what serves it | what a handler gets |
|---|---|---|---|
| `roomful` | 54 | the platform socket | `ctx.socket.emit(ns, payload)` |
| `valuguru` | 11 | the Valu Guru server's `data_request` channel | `ctx.guru.request(op, params)` |
| `app-state` | 5 | nothing — the answer is in the Valu Social app's memory | `ctx.appState.<capability>()` |
| `local` | 8 | the SDK itself | `ctx.config`, `ctx.fetchImpl`, `ctx.now` |
| `postmessage` | 15 | the Valu Social app, over the postMessage bridge | not a service function — see below |

70 socket / 8 local / 15 postMessage: the 77 of the parity matrix, plus the one
function this package declares itself ([sdk-structure.md](sdk-structure.md)).
`channel` says *which*, which is what a handler needs to know.

A transport that lacks a channel refuses the functions that need it **by
name**, before the handler runs:

```javascript
const transport = new SocketTransport({ socket });      // no guru, no appState
await client.call('Commerce.get-cart');
// → 503 "Commerce.get-cart needs the Valu Guru socket, and none was supplied"
```

Supplying them:

```javascript
const transport = new SocketTransport({
  socket,                                 // the Roomful socket — always
  guru: guruAdapter(aiGuruService),       // for the 11 valuguru functions
  appState: { getAgentWallet, getChatHistory }, // for the 5 app-state ones
  applicationId: 'my-app',                // Commerce + ApplicationStorage scope
  config: { webBase, apiGate },           // the local resource-URL builders
});
```

`applicationId` is stamped by the **runtime** — in a frame, by the Valu Social
application — and never read from a caller's params: Commerce scopes every
catalogue read and write to it, and a framed app must not be able to sell as
another app. A transport without one answers those functions
403.

## The fifteen application intents

They are not service functions, and a socket answers all fifteen with the same
501. They are asked for by name instead, over the same bridge traffic:

```javascript
const api = new ValuApi();
await api.intents.run('AiGuru.open', { applicationId: 'cart' });
const picked = await api.intents.run('DataProvider.pick-single', { providers: ['contacts'] });
```

No method per intent: the application registers its intents at runtime, so
`run()` takes any `Service.action` — including one newer than this package.
`ApplicationIntents` refuses a socket transport at construction, because there
is no application behind a socket to ask. Why this replaced `FrameCommands`,
and the full migration table, is [sdk-structure.md](sdk-structure.md).

## The catalogue

```javascript
catalogSummary();
// { total: 93, socket: 70, local: 8, postmessage: 15, implemented: 32,
//   declared: 92, sdkDeclared: 1, sdkable: 78, serviceFunctions: 78,
//   applicationIntents: 15, remaining: 46, serverOnly: 7 }
```

`declared` is what the application's manifest says and does not move when this
package adds a function; `sdkDeclared` is what this package adds. Counted from
`manifests/service-manifests.snapshot.json` rather than estimated, and
asserted in `test/catalog.test.js` — a drift fails the build.

Regenerating:

```bash
npm run sync:manifests -- --from ../valusocial-web   # re-snapshot the app manifest
npm run build                                        # catalogue + types + docs
npm test                                             # includes a staleness check
```

The snapshot is vendored on purpose: this package must not depend on the app
repo to build.

## Adding a function

Per the plan's definition of done — descriptor · implementation · param
validation · conformance test green on both adapters · generated docs entry:

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

## What Phase 2 deliberately did not do

- **No consumer changed.** The app still runs its own services and the server
  still runs its own tools; making them delegate is Phase 3. What exists now is
  one implementation both can move to.
- **Scope enforcement is still client-side and advisory.** See
  [authorization.md](authorization.md) — no third-party app gets a socket
  before Phase 3.3.
- **Two known behaviour deltas**, both recorded in [parity.md](parity.md)
  rather than hidden: `Resources.get-thumbnail-url` builds the public URL (as
  the server does) instead of emitting the app's RPC, which also returns
  decryption metadata for an encrypted resource; and `TextChat` neither
  encrypts what it sends nor decrypts what it reads, because that key material
  is the browser's — an encrypted body comes back flagged `encrypted: true`
  rather than as noise that reads like a message.

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

[1.3, the descriptor format](../src/services/descriptors.js) and
[1.4, the callbacks policy](callbacks-policy.md). Changing either after Phase
2c starts means touching 84 call sites.
