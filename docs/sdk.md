# The Valu Service SDK

Phase 1 built the foundation; Phase 2 implemented the parity matrix — all 77
SDK-able functions, plus a named API for the 15 that stay on the frame. The
function-by-function table is [parity.md](parity.md), generated from the
catalogue and from the registry the SDK actually loads.

Nothing in the consumer-facing behaviour of `ValuApi` changed: the bridge
traffic is byte for byte what it was.

## The shape of it

```
                       ServiceClient
       descriptor → validate → scope → cache → transport → retry
                             │
              ┌──────────────┴──────────────┐
      PostMessageTransport            SocketTransport
        (the host bridge)          (browser | node adapter)
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
| Host state | `src/host/HostState.js` | the five functions no RPC can answer |
| Upload | `src/upload/ResourceUpload.js` | register → link → PUT → complete |
| Implementations | `src/services/impl/` | the 77 functions themselves |
| Frame commands | `src/frame/FrameCommands.js` | the 15 host-bound intents, named |

## Using it

Over the bridge — every existing app already has this, it is just typed now:

```javascript
const api = new ValuApi();
const ack = await api.services.call('Users.get', { userId });
if (ack.error) console.warn(ack.error.message);
else console.log(ack.data);
```

Over a socket, in the browser:

```javascript
const socket = new BrowserSocketAdapter({ socket: webSocketService, userId, networkId });
const client = new ServiceClient({ transport: new SocketTransport({ socket }) });
const user = await client.invoke('Users.get', { userId }); // throws on failure
```

Over a socket, headless:

```javascript
const socket = new NodeSocketAdapter({ connection: roomfulConnection });
const client = new ServiceClient({ transport: new SocketTransport({ socket }) });
```

A function resolves by any name the platform already writes: `Users.get`,
`Users.get_user`, `Users.getUser`, `service__Users__get`.

## Three channels, not one

Phase 1 recorded `binding: socket | local | host`. Writing the functions showed
that **"socket" is three different things**, and a function written for the
wrong one fails in a way the ack envelope cannot explain. Every descriptor now
also carries a `channel`:

| channel | count | what serves it | what a handler gets |
|---|---|---|---|
| `roomful` | 53 | the platform socket | `ctx.socket.emit(ns, payload)` |
| `valuguru` | 11 | the Valu Guru server's `data_request` channel | `ctx.guru.request(op, params)` |
| `host-state` | 5 | nothing — the answer is in the host's memory | `ctx.host.<capability>()` |
| `local` | 8 | the SDK itself | `ctx.config`, `ctx.fetchImpl`, `ctx.now` |
| `host` | 15 | the frame bridge | not a service function — see below |

The binding counts are unchanged (69 / 8 / 15), so the parity target still
holds; `channel` says *which*, which is what a handler needs to know.

A transport that lacks a channel refuses the functions that need it **by
name**, before the handler runs:

```javascript
const transport = new SocketTransport({ socket });          // no guru, no host
await client.call('Commerce.get-cart');
// → 503 "Commerce.get-cart needs the Valu Guru socket, and none was supplied"
```

Supplying them:

```javascript
const transport = new SocketTransport({
  socket,                                 // the Roomful socket — always
  guru: guruAdapter(aiGuruService),       // for the 11 valuguru functions
  host: { getAgentWallet, getChatHistory }, // for the 5 host-state ones
  applicationId: 'my-app',                // Commerce + ApplicationStorage scope
  config: { webBase, apiGate },           // the local resource-URL builders
});
```

`applicationId` is stamped by the **host**, never read from a caller's params:
Commerce scopes every catalogue read and write to it, and a framed app must not
be able to sell as another app. A transport without one answers those functions
403.

## The fifteen frame commands

They are not service functions, and a socket answers all fifteen with the same
501. Phase 2d gives them their own API over the same bridge traffic:

```javascript
const api = new ValuApi();
await api.frame.openApplication('cart');
const picked = await api.frame.pickSingle({ providers: ['contacts'] });
```

`FrameCommands` refuses a socket transport at construction — there is no frame
behind a socket, and finding that out per call would be fifteen identical
surprises. It also refuses a *service* function, which is the mirror of the
socket refusing a host intent.

## The catalogue

```javascript
catalogSummary();
// { total: 92, socket: 69, local: 8, host: 15,
//   implemented: 32, sdkable: 77, remaining: 45, serverOnly: 7 }
```

Those are the plan's parity numbers, counted from
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
npm test         # the staleness check + 388 tests, including the per-function
                 # conformance table run against BOTH adapters
npm run build    # catalogue, types, docs and the parity matrix
npm run typecheck
```

## The two frozen decisions

[1.3, the descriptor format](../src/services/descriptors.js) and
[1.4, the callbacks policy](callbacks-policy.md). Changing either after Phase
2c starts means touching 84 call sites.
