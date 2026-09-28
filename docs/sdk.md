# The Valu Service SDK — Phase 1

What Phase 1 built, and what Phase 2 is written against. Nothing in the
consumer-facing behaviour of `ValuApi` changed: the bridge traffic is byte for
byte what it was, and the package now also knows how to open a socket.

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

## Adding a function (Phase 2)

Per the plan's definition of done — descriptor · implementation · param
validation · conformance test green on both adapters · generated docs entry ·
server binding · app service delegating to it:

1. **Descriptor** — it already exists if the app declares the intent. Fill in
   `returns`, and correct `cache` / `mutates` in `scripts/bindings.js` if the
   derived default is wrong for this function. `npm run build`.
2. **Implementation** — `serviceRegistry.define('Service.action', async (params, ctx) => ctx.socket.emit(ns, payload, ctx.timeoutMs))`.
   Pass the RPC's OWN payload: the transport adds the `{data}` envelope.
   Resolve an ack; do not throw, do not retry.
3. **Test** — extend `test/conformance/suite.js`. It runs against both
   adapters already; a function that needs its own case adds one there, not in
   an adapter-specific file.

Things a handler must not do, because the layers above already do them:
validate params, check scopes, read or write the cache, retry, or time itself
out.

## What Phase 1 deliberately did not do

- **No function is implemented.** The registry ships empty; an unimplemented
  declared function answers 501 naming itself. Phase 2a ports the 32 the
  server already has, 2c writes the other 45.
- **`returns` is `unknown` everywhere.** The manifest does not declare return
  shapes; each function fills its own in Phase 2.
- **Scope enforcement is client-side and advisory.** See
  [authorization.md](authorization.md) — no third-party app gets a socket
  before Phase 3.3.
- **The 15 host-bound intents stay on the bridge.** Phase 2d gives them a named
  frame-command API; until then they are reachable through
  `api.services.call(...)` over the bridge transport, which is where they
  already were.

## The two frozen decisions

[1.3, the descriptor format](../src/services/descriptors.js) and
[1.4, the callbacks policy](callbacks-policy.md). Changing either after Phase
2c starts means touching 84 call sites.
