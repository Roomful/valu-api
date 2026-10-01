# Getting a socket

All 65 functions in this package run over one connection, the Roomful platform
socket. There are exactly **two** ways to get one, and everything above them is
the same code either way:

```javascript
// 1. The runtime already has an authorized connection, and shares the instance.
const valu = await connectValuServices({ socket: webSocketService, userId });

// 2. The runtime has a session and nothing else, so the package opens one.
const valu = await connectValuServices({ sessionId, io });
```

`createValuServices({ socket })` is still there and still synchronous — use it
when you already hold a `ValuSocket`. `connectValuServices` is the same thing
plus the three things door 2 needs: resolving either door, wiring reconnect, and
owning what it opened.

```
   ┌─ door 1 ─ a connection somebody else authorized ───────────────┐
   │                                                                │
   │  the app's WebSocket service ──▶ BrowserSocketAdapter          │
   │  a socket.io socket ───────────▶ SocketIoSocketAdapter         │
   │  a RoomfulConnectionManager ──▶ NodeSocketAdapter              │
   │  a ValuSocket ─────────────────▶ (used as it is)               │
   └──────────────────────────────┬─────────────────────────────────┘
                                  │
   ┌─ door 2 ─ sessionId ─────────┤
   │                              │
   │  ValuSocketConnection        │
   │    init.client               ▼
   │    socket.io handshake    ValuSocket ──▶ SocketTransport ──▶ ServiceClient
   │    wait for user_info        ▲                                   │
   └──────────────────────────────┘                        valu.Users.current()
```

## Door 1 — a socket that is already authorized

This is the Valu Social application's case, and it is why the package exists in
this shape: the app has **one** socket, shared by every store and service in it,
and a library that opened a second one would double the connection count per tab
for no gain. So the app opens the socket, authorizes it, and hands the instance
over.

`adoptValuSocket(socket, options)` is the whole of it — synchronous, and what
`openValuSocket({ socket })` and `connectValuServices({ socket })` call. It takes
any of the four things a runtime might actually be holding and sorts them out
itself. You do not have to know our class names to answer a question we can
answer from the object:

| what you pass | how it is recognised | what it becomes |
|---|---|---|
| a `ValuSocket` from this package | the `VALU_SOCKET` brand | **itself** — never wrapped twice |
| the application's `WebSocket` service | it has `emitAsync` | `BrowserSocketAdapter` |
| a `socket.io` socket | it has `emit` + `on` and a Manager | `SocketIoSocketAdapter` |
| a `RoomfulConnectionManager`, or any other promise-`emit` socket | it has a promise-returning `emit` | `NodeSocketAdapter` |

Three of those rows carry a decision worth stating.

**A socket of ours is returned by identity.** Consumers key per-connection state
on the socket object — this package's cache, the Valu Guru server's
`WeakMap<ValuSocket, ValuServiceApi>` — so wrapping an already-adapted socket a
second time would give one connection two identities, and a cache keyed on the
second one would never see an invalidation aimed at the first.

**The brand, not a shape.** A `RoomfulConnectionManager` satisfies the
`ValuSocket` interface structurally, and so does a third-party adapter written
against [socket-adapters.md](socket-adapters.md) — so "looks like a ValuSocket"
cannot tell a socket that needs no adapter from one that does, and guessing
wrong is silent (the raw connection works for most calls and differs exactly
where its adapter helps). An unbranded socket therefore takes the last row.
That costs nothing: `NodeSocketAdapter` forwards every member live and
republishes the original as `underlying`, the member that exists so wrapping
does not cost a consumer its identity keying.

**A socket.io socket is checked before the generic `emit` case**, because
socket.io's `emit` is fire-and-forget with an ack *callback*: handed to
`NodeSocketAdapter`, which awaits what `emit` returns, every call would resolve
`undefined` and every function would answer "no data" without failing.

Nothing is opened, authorized or closed on this path. `valu.close()` drops this
package's caches and subscriptions and leaves the connection alone — it is the
owner's, and the owner is still using it.

## Door 2 — a session id

`ValuSocketConnection` opens the socket and authorizes it, performing the same
handshake, in the same order, against the same endpoints as the two clients that
already do this (`valusocial-web src/Services/WebSocket/WebSocket.js`,
`valu-guru-server src/server-agents/roomful-connection.ts`):

```
POST https://{host}/api/v0/publicRpc/init.client   X-Session-Id: {sessionId}
      → the network this session belongs to, and possibly another host to use
io(`wss://{host}?sessionId={sessionId}`, { path: '/socket', transports: ['websocket'] })
      → the platform pushes `user_info`
            → authorized. connect() resolves.
```

```javascript
import io from 'socket.io-client';
import { connectValuServices } from '@arkeytyp/valu-api';

const valu = await connectValuServices({ sessionId, io });

const me = await valu.data.Users.current();
await valu.close();           // this one it opened, so this one it closes
```

The platform mounts socket.io at `/socket`, not at the client default, and it
speaks websocket only — the polling fallback would put the session id on every
XHR rather than once on the handshake. Both are in `SOCKET_IO_OPTIONS`, with the
rest of the options each existing client already sets.

Three things about that handshake:

- **`user_info` is the end of it**, not `connect`. A socket.io socket connects
  happily with a dead session and simply never hears back, so a connection is
  `ready` when the platform says who you are and not before. `connect()` rejects
  after `readyTimeoutMs` (20s) with what it knows — the host, the network, the
  transport error count, and the one plain sentence that a connected socket
  with no `user_info` is what a rejected session looks like.
- **`user_info` is also authoritative.** It names the user and the network, it
  arrives again after every reconnect, and what it says overrides whatever
  `init.client` resolved. A connection that comes back in a different network
  must not keep answering with the old one.
- **The bootstrap is best-effort.** The credential rides the handshake, so an
  `init.client` that 401s costs the resolved network id and nothing else — but it
  is recorded (`describe().lastError`), because a 401 there is the clearest
  "this session is dead" signal available, and it arrives seconds before a
  socket that just goes quiet.

### socket.io is not a dependency, and must not become one

Pass `io`. This package has no socket.io dependency on purpose: every runtime
with a Roomful connection already has one — the Valu Social build pins 2.5.0,
the Valu Guru server requires the same major — and a second copy in a bundle is
a second connection pool. There is a dynamic `import('socket.io-client')`
fallback for scripts, and `loadSocketIo` says exactly this when it fails.

### The session id

The credential on this door is the user's Roomful `sessionId` — the same one the
web client holds. It is **not** an application token: it carries everything the
user can do, it is not scoped, and it does not expire on a schedule this package
controls. Hence:

1. **It is never readable back.** No getter; `describe()` prints
   `session: 'present (redacted)'`; every message that leaves the connection
   passes through a redactor, in both the raw and percent-encoded forms, so a
   transport error quoting the handshake URL cannot put a credential in a log.
2. **It never becomes a call parameter.** `assertNoCredentialLeak`
   (`src/auth/TokenStore.js`) already refuses a params object carrying one.
3. **This door is for first-party runtimes** — the ones that already hold the
   session: the application itself, and a process the user ran. A **third-party**
   framed application gets a socket when it can be handed a scoped, revocable
   token that the dispatch side enforces (Phase 3.3,
   [authorization.md](authorization.md)) — scope checks here are still advisory,
   and this constructor existing does not change that. When that day comes,
   nothing in the catalogue changes and `SocketIoSocketAdapter` is where the
   app-issued socket plugs in.

## What `connectValuServices` adds

| | `createValuServices` | `connectValuServices` |
|---|---|---|
| takes | a `ValuSocket` | either door |
| is | synchronous | `async` |
| reconnect | the caller calls `transport.handleReconnect()` | wired, for a connection it opened |
| `close()` | caches and subscriptions | …and the connection, **if it opened it** |
| `valu.connection` | `null` | the connection it owns |

Reconnect is the one worth spelling out. When a connection this package opened
drops and re-authorizes, it tells the transport, which clears the caches —
because everything in them predates the gap and nothing says what changed
during it. A socket **adopted** from the application is deliberately left alone:
the app has its own reconnect path, and two handlers racing to clear one cache
is worse than neither.

## Reading it back

```javascript
const valu = await connectValuServices({ sessionId, io });

valu.socket            // the ValuSocket every function runs over — share this
valu.connection        // the connection it owns, or null when adopted
valu.transport.supportsPush   // true over socket.io: resource:updated is live
valu.connection.describe()    // safe to print: host, state, ids, never the session
```

`valu.socket` is how one connection is shared. The Valu Social application opens
the socket once, builds this once, and hands the same instance to anything else
that needs the platform — which is the whole of requirement 1 and the reason the
app does not end up with two sockets per tab.

See also: [socket-adapters.md](socket-adapters.md) for what a socket *is* here
and how to write a third adapter, [socket-functions.md](socket-functions.md) for
the functions themselves, and [authorization.md](authorization.md) for what is
still advisory.
