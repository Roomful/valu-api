# The socket, and what an adapter is

The 65 functions in this package all run over **one** connection: the Roomful
platform socket. This package never opens it. The runtime that already has a
connection hands it in, and an **adapter** is the thin piece that makes that
particular connection look like the one thing every function here depends on.

Two adapters ship:

| adapter | you give it | the runtime |
|---|---|---|
| `BrowserSocketAdapter` | the Valu Social application's WebSocket service | a browser tab — the app itself, or an iframe app that has been handed a socket |
| `NodeSocketAdapter` | a `RoomfulConnectionManager` | a server process, a script, a CLI |

They exist because those two connections are **not** interchangeable as they
are, and the difference is not cosmetic: one rejects when a call fails, the
other resolves an error object with no code on it. A library of 65 functions
cannot have two error paths, so each adapter converts its connection into one
shape and nothing above them ever learns which is underneath.

## What a socket is here

The Roomful platform speaks socket.io. A call is an event named
`<namespace>:<action>`, whose payload is wrapped in a `{data}` envelope, and
whose answer comes back in the ack callback as `{data}` or `{error}`:

```
socket.emit('social:getUsersSimpleInfo', { data: { ids: ['u-1'] } }, ack => …)
                     ↑ the RPC name              ↑ the envelope        ↑ {data} | {error}
```

That is the whole protocol this package needs, and `ValuSocket`
(`src/socket/ValuSocket.js`) is it, written down:

| member | required | what it is |
|---|---|---|
| `emit(ns, data, timeoutMs)` | **yes** | one RPC, resolving an ack. **Never rejects** |
| `userId` | yes | the Roomful user id the connection is credentialed as |
| `networkId` | yes | the active network — `'roomful'` unless told otherwise |
| `selfUserId` | yes | the resolved "me" id; may be `null` until the connection is ready |
| `onResourceUpdated(handler)` | no | a `resource:updated` push subscription, returning an unsubscribe |
| `underlying` | no | the real connection, when this socket is a wrapper around one |

Two things in that table carry most of the weight.

**`emit` never rejects.** It resolves `{data}` or `{error: {status, code,
message}}`. Every handler in `src/services/impl/` is written against that, so a
`try`/`catch` around a service call is never the way failures are handled here —
you read `ack.error`, or you use `valu.data.X.y()`, which throws for you.

**`data` is the RPC's own payload, not the envelope.** `emit('room:get', {
roomId })` — never `{ data: { roomId } }`. Double-wrapping is the one mistake
that does not look like a mistake: the server answers a plausible
"Resource not found" for a room that exists. Both shipped adapters hand the
payload to a connection that adds the envelope itself.

## `BrowserSocketAdapter` — the one you asked about

In the Valu Social application, the socket already exists: it is the app's own
`WebSocket` service (`valusocial-web src/Services/WebSocket/WebSocket.js`) —
a `socket.io-client` connection to `wss://…/socket`, shared by every store and
service in the app, authenticated as the signed-in user. The app's services
call it like this:

```javascript
const response = await webSocket.emitAsync('channel:getChannelById', { channelId });
```

`emitAsync(endpoint, data, timeout = 30000)` wraps `data` in the `{data}`
envelope, emits, and resolves the ack. `BrowserSocketAdapter` wraps **that
service** — it does not open a connection, authenticate, reconnect or own any
state of its own:

```javascript
import { BrowserSocketAdapter, createValuServices } from '@arkeytyp/valu-api';

const socket = new BrowserSocketAdapter({
  socket: webSocket,              // the app's WebSocket service — required
  userId,                         // who it is credentialed as
  networkId,                      // optional, defaults to 'roomful'
  // optional; omit it and consumers expire by age instead of subscribing
  onResourceUpdated: (handler) => {
    webSocket.addEventListener('resource:updated', handler);
    return () => webSocket.removeEventListener('resource:updated', handler);
  },
});

const valu = createValuServices({ socket });
const me = await valu.data.Users.current();
```

All it adds is the one conversion that makes the app's service a `ValuSocket`:

- **`emitAsync` rejects; `ValuSocket.emit` must not.** The app's service rejects
  on timeout, and rejects *immediately* when the socket is down rather than
  making the caller wait out 30 seconds for an ack that was never sent. The
  adapter catches that and returns an ack instead — `408` when the message
  looks like a timeout, `503` otherwise, with the RPC named in it.
- **A missing or partial ack is completed** by `normalizeAck`, so
  `ack.error.code` is always there to switch on.
- **The push hook is attached only if you pass one.** With no
  `onResourceUpdated`, `transport.supportsPush` is `false` and a cached read is
  invalidated only by its own TTL and by writes made through this client — never
  by somebody else's edit. That is a fact the consumer can read; a hook that
  never fires would not be.
- **`transport` republishes the app's service**, so a consumer that keys
  per-connection state (a cache, a dedupe map) keys it on the real connection.

Nothing else. It is ~75 lines, it holds no connection of its own, and if the
app's socket drops and reconnects, the adapter keeps working because the object
it wraps is the same object.

### Where a framed application stands

An iframe application **does not have a socket today**. It has the postMessage
bridge to the Valu Social application, and that bridge does not serve service
functions — `ServiceClient` refuses a postMessage transport rather than
pretending. So a framed app today asks the application for intents by name
(`api.callService`, [api-pointers.md](api-pointers.md)), and the day it is
handed a socket of its own, `BrowserSocketAdapter` is where it plugs in and all
65 functions arrive at once. Nothing in the catalogue changes for that to
happen.

Scope checking is still client-side and advisory ([authorization.md](authorization.md)),
which is the reason a third-party framed app does not get one yet.

## `NodeSocketAdapter` — the headless twin

Outside a browser the connection is a `RoomfulConnectionManager`
(`valu-guru-server src/server-agents/roomful-connection.ts`): the same
socket.io protocol, opened by the process itself, with its own reconnect and
its own `user_info` handshake.

```javascript
const socket = new NodeSocketAdapter({ connection: roomfulConnection });
const valu = createValuServices({ socket });
const ack = await valu.Users.get({ userId });   // { data } | { error }
```

That connection already satisfies most of the contract — it wraps `{data}`,
resolves an error ack on timeout instead of rejecting, and has a
`resource:updated` subscription — so this adapter is deliberately thinner than
the browser one. It normalizes a missing ack, forwards the push hook only when
the connection really has one, catches the throw a half-torn-down connection
can still produce, and republishes `underlying` so a wrapper (the Guru server's
recording socket) and the adapter key the same per-connection state.

## Where the two differ

| | `BrowserSocketAdapter` | `NodeSocketAdapter` |
|---|---|---|
| wraps | the app's `WebSocket` service | `RoomfulConnectionManager` |
| who opens the connection | the application | the process |
| failure arrives as | a **rejection** → converted to an ack | an error ack, usually without a `code` → completed |
| timeout code | `408`, inferred from the message | `408`, filled in by `normalizeAck` |
| `selfUserId` | the `userId` you passed | `null` until the connection resolves it |
| push | only if you pass `onResourceUpdated` | present when the connection has it |
| the real connection | `.transport` | `.underlying` |

Both answer every one of the 65 functions identically, and that is tested
rather than asserted in prose: `test/conformance.test.js` runs the same suite
and the same 86-case per-function table against both adapters, with no
adapter-specific expectations anywhere in it. A function that behaves
differently in a browser than in Node fails the build.

## Writing a third adapter

A different runtime — a mobile shell, a test harness, a connection pool — needs
no change here. Implement `ValuSocket`:

1. `emit(ns, data, timeoutMs)` resolves `{data}` or `{error}` and **never
   rejects**. Catch everything; `errorAck(503, …)` is the honest answer.
2. If your transport does not add the Roomful `{data}` envelope, add it in the
   adapter. The payload handed to `emit` is the RPC's own.
3. `userId`, `networkId`, `selfUserId` — `null` is allowed for the last one.
4. Add `onResourceUpdated` **only** if you can really push. Omitting it is a
   supported answer and `supportsPush` reports it; a hook that never fires is a
   cache that looks fresher than it is.
5. Run the conformance suite against it. It is parameterized by adapter
   (`runConformanceSuite`, `runPushSuite`, `runFunctionSuite`), so a third
   entry in `test/conformance.test.js` is the whole of the work.

## What an adapter is not

- **Not a transport.** `SocketTransport` is the transport: it takes a socket,
  validates params, applies the cache and the retry policy, and dispatches to a
  handler. The adapter only makes the connection speak `ValuSocket`.
- **Not a client.** `ServiceClient` and `createValuServices` sit above the
  transport and give you `valu.Users.current()`.
- **Not the postMessage bridge.** That is `PostMessageTransport`, a different
  mechanism for a different job — iframe ↔ application traffic: intents by
  name, API pointers, console, routes. It carries no service functions
  ([api-pointers.md](api-pointers.md), [sdk.md](sdk.md)).
- **Not a second server.** There is one socket in this package. The Valu Guru
  server's own channel — the Commerce catalogue, the knowledge-base search —
  was removed on purpose; those are the Valu Social application's intents to
  serve, and a user-facing platform library holds the platform's connection and
  nothing else.
