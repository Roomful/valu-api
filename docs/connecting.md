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

## Dedicated mode — `createValuApp`

A page that is not inside Valu Social — its own domain, `*.valuguru.app`, a
`localhost` dev server — has no Roomful socket and must not hold a Valu session.
Dedicated mode gives it the same functions anyway, through a **host**: a hidden
iframe on a Valu origin (`<hostOrigin>/host/`) that keeps the session and the
socket, signs the user in through a popup, and checks the app's grants before
every call. The page only ever sees answers; no credential crosses the iframe
boundary.

```javascript
import { createValuApp } from '@arkeytyp/valu-api';

const valu = await createValuApp();            // a top-level page is dedicated

valu.auth.on('change', ({ signedIn, user }) => render(signedIn, user));
signInButton.onclick = () => valu.auth.signIn().catch(showWhy);   // from a click

const me = await valu.data.Users.current();    // the same tree as everywhere
```

`createValuApp` is the one entry point an app uses, in either mode. The object it
returns carries the bridge (`callService`, `sendIntent`, `onCommerceEvent`,
`addEventListener`, and the whole `ValuApi` as `valu.bridge`) and the service
tree (`valu.Users.current()` answers an ack, `valu.data.Users.current()` the
payload), next to `mode`, `ready`, `auth`, `network` and `connection`.
`removeEventListener(name, handler)` removes every registration of that handler
for `name`; without a handler it clears every listener of `name` (the bridge's
emitter, as in `ValuApi`).

### Which mode

| the page is | mode |
|---|---|
| top-level (`window.parent === window`) | `dedicated` |
| framed, loaded with `?valu-mode=dedicated` | `dedicated` |
| framed | `embedded` |
| given `mode` in the options | whatever it says |

A framed page waits for the parent's `api:ready` as it always did, with no
timeout and no fallback: `valu.ready` resolves on it. There is no timed switch
to dedicated, because a framed page could not use the host anyway (the host
refuses to run nested).

### Options

| option | default | |
|---|---|---|
| `hostOrigin` | `https://valuguru.texpo.io` | Where the host is served: a bare origin. The iframe's origin, and the only origin it is heard from. |
| `signInOrigin` | `https://live.valuverse.io` | The Valu brand users sign in through. A Chabad-network app passes `https://chabaduniverse.com`. The host accepts a sign-in only from its four known brand origins. |
| `mode` | from the page | `'dedicated'` or `'embedded'`. |
| `window`, `document` | the globals | Where messages arrive, and where the iframe goes. |
| `popup` | `window.open` | `(url, name, features)`, returning the window or `null`: for a page that opens windows its own way. |
| `setTimeout`, `clearTimeout` | the globals | The timers the client uses: the popup poll, the five-minute sign-in deadline, and the host handshake and ping. For a test that turns the clock itself. |
| `fetchImpl`, `localTransport` | | Dedicated only. The functions on the `local` channel (`Http.*`, `Time.*`, the resource-URL builders) run in the page, not through the host; these are what they run with. |

The popup URLs are built from the two origins and a random nonce, and from nothing
the host says.

`createValuApp` resolves once the host has answered. When it cannot, it rejects
with an `Error` whose `code` says why: `host_unreachable` (no answer in 10 s, or
the iframe failed), or the host's own `unknown_app`, `nested`, `bad_origin`,
`protocol_unsupported`, `resolve_unavailable`. Nothing is left behind: no iframe,
no listener, no timer.

### Sign-in: call `signIn()` from a click

```javascript
button.onclick = async () => {
  try {
    const { user } = await valu.auth.signIn();     // the popup opens right here
  } catch (error) {
    // error.code: popup_blocked | cancelled | timeout | master_mismatch | not_a_member | invalid_token | unavailable
  }
};
```

A browser opens a window only from a user gesture, so `signIn()` opens the popup
before it does anything else — before any `await` of its own, and so before
yours: do not `await` anything between the click and the call. A `null` from the
browser is `popup_blocked`; there is no redirect fallback, because a redirect
would route the token through the app page.

| `signIn()` rejects | when |
|---|---|
| `popup_blocked` | the browser refused the window |
| `cancelled` | the user pressed Cancel, or closed the window and nothing came of it |
| `timeout` | five minutes passed (the window is closed) |
| `master_mismatch` | the sign-in page talks to another Valu backend than the host does |
| `not_a_member` | the user is not a member of the app's network |
| `invalid_token` | the one-time token was refused |
| `unavailable` | the host could not reach the platform |
| `session_expired` | the session the host held ended while the window was open |
| `not_available` | the page is embedded |
| `closed` | `valu.close()` ran meanwhile |

It resolves with the new `auth.state`. A second call while one is waiting shares
it and opens nothing. A closed window is `cancelled` only after ten seconds with
no result: the sign-in page closes itself the moment it has handed the token over,
and the host then takes a few seconds to redeem it.

`valu.auth` in full:

| | |
|---|---|
| `state` | `{signedIn, user, network, reason?}`, a copy. `reason` is that of the last push (`session_expired`, `signed_out_elsewhere`, a failed sign-in's) until the next. |
| `signIn()` | above |
| `signOut()` | Resolves when the host has finished. The user's Valu Social sign-in is untouched. |
| `requestConsent(scopes)` | Resolves whether the user approved. Below. |
| `on('change', handler)` | Every auth push, with the new state. Returns the way to stop. |

`valu.network` is `{id, name}` for the network the host runs in (the app's home
network), or `null`. The session is the browser's, shared by every Workspaces app
in it; grants are per app.

### Consent

Some functions need the user's say-so the first time an app uses them (the tier
is the scope's: `rooms:read`, `commerce:write` …). The host answers such a call
`{error: {status: true, code: 403, message: 'consent_required', scope}}`.

- **From a click.** If the call was made inside a user gesture
  (`navigator.userActivation.isActive`), the client opens the consent dialog at
  once and, when the user allows it, repeats the call **once**. The app only sees
  the final answer. Calls that wait on the same scope share one dialog; the
  dialog never opens beside another.
- **Otherwise** the ack is the answer, and the app asks from its own click:
  `button.onclick = () => valu.auth.requestConsent(['rooms:read'])`, then calls again.

`requestConsent` opens `<hostOrigin>/host/consent.html?nonce=…` (the page names
the app and the scopes from the host itself, never from the app page), and
rejects `popup_blocked` when the browser refuses it. A window closed without a
decision resolves `false` after ten seconds.

### Connection

`valu.connection.state` is one of:

| state | |
|---|---|
| `connecting` | before the host has answered (never seen in dedicated mode: `createValuApp` waits) |
| `ready` | signed in, link up |
| `reconnecting` | the host's link to the platform dropped and is coming back; calls are held, not failed |
| `offline` | the browser is offline (no `lastError`), or the host could not be restarted (`lastError.code`) |
| `signed_out` | no user |

`on('change', ({ state, reconnected, lastError }) => …)` fires for every push;
`reconnected: true` is the notice that a dropped link is back, and what the app
cached about the platform predates it (the SDK's own cache is already cleared).
A host that stops answering is replaced once, silently; calls that were on the
wire answer `503 host_restarted`, and a write among them is `retryable: false`
(it may have been applied). If the replacement fails too, the state is `offline`
with `lastError.code` the host's code (`host_unreachable`, `unknown_app`, …), and
the app should reload.

### Embedded mode

Inside Valu Social nothing changes: the bridge is `ValuApi` as it was, `valu.ready`
follows `api:ready`, `auth.signIn()`, `signOut()` and `requestConsent()` reject
`not_available`, `auth.state` is always signed out (the embedding application owns
the session), and every service function answers `501`. Use `valu.mode` to tell.

See also: [socket-adapters.md](socket-adapters.md) for what a socket *is* here
and how to write a third adapter, [socket-functions.md](socket-functions.md) for
the functions themselves, and [authorization.md](authorization.md) for what is
still advisory.
