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
iframe on a Valu origin (`<hostOrigin><hostPath>`) that keeps the session and the
socket, signs the user in through a popup, and checks the app's grants before
every call. The page only ever sees answers; no credential crosses the iframe
boundary.

Two hosts serve the same engine. `hostPath` says where on the origin the host
page is, and the consent page is `consent.html` beside it:

| host | options |
|---|---|
| valu-guru-server (the default) | `hostOrigin: 'https://valuguru.texpo.io'`, `hostPath: '/host/'` |
| valusocial-web's web host | `hostOrigin: 'https://api.valuguru.app'`, `hostPath: '/'` |

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
for `name`. Pass the handler: the bridge's emitter reads a call without one as
"clear every listener of `name`" (and without a name, all of them), which also
drops the ones other code registered, `onCommerceEvent`'s among them.

`valu.bridge` is the `ValuApi` underneath, and in dedicated mode it is for the
lifecycle only: `setApplication(app)` gets `onCreate` with the launch intent of
`api:ready`. Its pointer, console and run-intent methods (`getApi`,
`runConsoleCommand`, `sendIntent`) belong to Valu Social, and the host answers them
`not_available`; `pushRoute` and `replaceRoute` are not answered at all (the app
owns its URL).

For a caller that holds a string (an LLM tool call, say) the same object has the
by-name surface of the services tree: `valu.call(name, params, options)` resolves
the ack and never rejects, `valu.invoke(name, params, options)` resolves the
payload and throws `ValuServiceError`, and `valu.toolDefinitions(filter)` lists the
functions as LLM tool definitions (by default the ones an AI caller may reach). A
name resolves in any spelling the tree's methods accept (`Rooms.searchMyRooms`,
`Rooms.search-my-rooms`). They run through the same client and transport as
`valu.Rooms.searchMyRooms()`, so the consent retry below is under them too, and in
embedded mode they go to Valu Social like the tree ([Inside Valu
Social](#inside-valu-social)).

### Which mode

| the page is | mode |
|---|---|
| top-level (`window.parent === window`) | `dedicated` |
| framed, loaded with `?valu-mode=dedicated` | `dedicated` |
| framed | `embedded` |
| given `mode` in the options | whatever it says |

A framed page waits for the parent's `api:ready`: `valu.ready` resolves on it, and
rejects `host_unreachable` when none comes within `readyTimeoutMs` (10 s), so a
parent that never answers (a preview, say) fails fast instead of waiting forever. A
parent that does answer but is not Valu Social is the other case: any page can frame
an app and send `api:ready`, so the bridge binds to it as it always did, but what it
says of the service functions and the user is taken only from a trusted origin
([whom an embedded app trusts](#whom-an-embedded-app-trusts)). There is no switch to
dedicated, because a framed page could not use the host anyway (the host refuses
to run nested).

### Options

| option | default | |
|---|---|---|
| `hostOrigin` | `https://valuguru.texpo.io` | Where the host is served: a bare origin. The iframe's origin, and the only origin it is heard from. |
| `signInOrigin` | `https://live.valuverse.io` | The Valu brand users sign in through. A Chabad-network app passes `https://chabaduniverse.com`. The host accepts a sign-in only from its four known brand origins. It belongs with `hostOrigin`: see [The two origins](#the-two-origins-belong-together). |
| `app` | none | The app's address `<workspace>/<slug>`, sent in `host:hello` (dedicated only). A dev host serves a localhost page under it; a production host ignores it. |
| `hostOrigins` | none | Embedded only: the origins the embedding application's `api:ready` may come from, an array such as `['https://live.valuverse.io']`, and the only ones trusted with its `valuApi` (the service calls and the user). The sender must be `window.parent` regardless; the origin of the first `api:ready` is then the only one replies go to and messages are taken from. Omitted, any origin binds the bridge, and only the Valu origins the host trusts for sign-in are trusted with `valuApi` ([whom an embedded app trusts](#whom-an-embedded-app-trusts)). A local Valu Social needs it: `['http://localhost:3005']`. Dedicated mode ignores it. |
| `mode` | from the page | `'dedicated'` or `'embedded'`. |
| `readyTimeoutMs` | `10000` | How long to wait for `api:ready`. Dedicated: from the host, and `createValuApp` rejects `host_unreachable` after it. Embedded: from Valu Social, and `valu.ready` rejects `host_unreachable` after it (see [Inside Valu Social](#inside-valu-social)). A positive number of milliseconds, or a `TypeError`. |
| `window`, `document` | the globals | Where messages arrive, and where the iframe goes. |
| `popup` | `window.open` | `(url, name, features)`, returning the window or `null`: for a page that opens windows its own way. |
| `setTimeout`, `clearTimeout` | the globals | The timers the client uses: the popup poll, the five-minute sign-in deadline, the host handshake and ping, and (embedded) the wait for `api:ready` and the calls' timeouts. For a test that turns the clock itself. |
| `fetchImpl`, `localTransport` | | The functions on the `local` channel (`Http.*`, `Time.*`, the resource-URL builders) run in the page, in either mode, never through the host or Valu Social; these are what they run with. |

The popup URLs are built from the two origins and a random nonce, and from nothing
the host says.

`createValuApp` resolves once the host has answered `api:ready`. That does not
wait for the link to the platform: see [Connection](#connection) for a user who
is signed in from storage while the link is still `connecting`. When the host
cannot answer, it rejects with an `Error` whose `code` says why: `host_unreachable`
(no answer within `readyTimeoutMs`, 10 s, or the iframe failed), or the host's own `unknown_app`,
`nested`, `protocol_unsupported`, `resolve_unavailable`. Nothing is left behind:
no iframe, no listener, no timer.

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
| `timeout` | five minutes passed (the window is closed), or the host gave up redeeming the token after 15 s (it says so at once, by an `auth` push with `reason: 'timeout'`) |
| `master_mismatch` | the sign-in page talks to another Valu backend than the host does |
| `not_a_member` | the user is not a member of the app's network |
| `invalid_token` | the one-time token was refused |
| `unavailable` | the host could not reach the platform |
| `session_expired` | the session the host held ended while the window was open |
| `not_available` | embedded, and Valu Social has no user ([Inside Valu Social](#inside-valu-social)) |
| `closed` | `valu.close()` ran meanwhile |

It resolves with the new `auth.state`. A second call while one is waiting shares
it and opens nothing. A closed window is `cancelled` only after ten seconds with
no result: the sign-in page closes itself the moment it has handed the token over,
and the host then takes a few seconds to redeem it.

`valu.auth` in full:

| | |
|---|---|
| `state` | `{signedIn, user, network, reason?}`: a new object on every read, but its `user` and `network` are the transport's own objects, the same ones on every read and every `change`, not copies. Read them; do not mutate them. `reason` is that of the last push (`session_expired`, `signed_out_elsewhere`, a failed sign-in's, or `unavailable` on a signed-in user, see [Connection](#connection)) until the next. |
| `signIn()` | above |
| `signOut()` | Resolves when the host has finished. The user's Valu Social sign-in is untouched. Rejects as the table below says. |
| `requestConsent(scopes)` | Resolves whether the user approved. [Consent](#consent). |
| `on('change', handler)` | Every auth push, with the new state. Returns the way to stop. |

| `signOut()` rejects | when |
|---|---|
| `not_available` | the page is embedded: an app cannot sign the user out of Valu Social |
| `closed` | `valu.close()` ran before the call or while it waited |
| `host_restarted`, `host_unreachable` | the host went away meanwhile |

`valu.network` is `{id, name}` for the network the host runs in (the app's home
network), or `null`; like `auth.state.user` it is a shared object. The session is
the browser's, shared by every Workspaces app in it; grants are per app.

### Consent

Some functions need the user's say-so the first time an app uses them (the tier
is the scope's: `rooms:read`, `commerce:write` …). The host answers such a call
`{error: {status: true, code: 403, message: 'consent_required', scope}}`.

- **From a click.** If the call was made inside a user gesture
  (`navigator.userActivation.isActive`), the client opens the consent dialog at
  once and, when the user allows it, repeats the call **once**. The app only sees
  the final answer, whichever way it called: `valu.X.y()`, `valu.data.X.y()`,
  `valu.call(name)` or `valu.invoke(name)`. Calls that wait on the same scope share
  one dialog; the dialog never opens beside another.
- **Otherwise** the ack is the answer, and the app asks from its own click:
  `button.onclick = () => valu.auth.requestConsent(['rooms:read'])`, then calls again.

`requestConsent` opens `<hostOrigin><hostPath>consent.html?nonce=…` (the page names
the app and the scopes from the host itself, never from the app page). A window
closed without a decision resolves `false` after ten seconds; a user who declines,
or a request the host refuses, resolves `false` too. Like `signIn()` it must be
called from a click.

| `requestConsent(scopes)` rejects | when |
|---|---|
| `popup_blocked` | the browser refused the window |
| `closed` | `valu.close()` ran before the call or while it waited |
| `host_restarted`, `host_unreachable` | the host went away meanwhile |

`scopes` that are not a non-empty array of scope names reject with a `TypeError`
before anything opens. Only the consent tier is asked about: a basic scope needs
no asking, and a `forbidden` one is never asked about (below). Embedded, it
resolves `true` and asks nothing ([Inside Valu Social](#inside-valu-social)); the
`TypeError` is the same.

An intent refusal is not retried: `callService` for a Commerce intent resolves
`{success: false, code: 'consent_required', scope}` as it is, and the app calls
`valu.auth.requestConsent([scope])` itself, from a click, and repeats the intent
if that resolves `true`. (`examples/dedicated/` does exactly that.) Service
functions are the ones that get the dialog automatically.

### What the host serves

The host is not Valu Social. For a signed-in user it serves the service functions
(65 in the catalogue; the `local` ones run in the page and never reach it), the 30
Commerce data intents and the two Commerce event subscriptions, and
`Application.get-identity-token`. Everything else answers `not_available`: the
intents Valu Social serves itself (open a dock, a picker, `Commerce.checkout`, the
`open-*` windows, the seller's publish functions …), and, on the bridge,
`valu.sendIntent`, `valu.bridge.getApi` and `valu.bridge.runConsoleCommand`.

**Where it runs.** The production host (`https://valuguru.texpo.io/host/`) serves
a page only when the server can say which app its origin is, and it knows the
published `*.valuguru.app` origins of Workspaces apps and no others. A custom
domain gets `unknown_app`. A `localhost` page cannot use it: the production host
may be framed only from `https://*.valuguru.app`, and its lookup takes https
origins only, so the page sees `host_unreachable`, `resolve_unavailable` or
`unknown_app`, and no host. To develop on `localhost`, run a **dev host**
(`hostOrigin: 'http://localhost:3001'`; see `examples/dedicated/README.md`): a dev
build accepts a `localhost` or `127.0.0.1` page that names its app with the `app`
option (`<workspace>/<slug>`) and serves it as that app. A production host
ignores `app`.

**What a refusal looks like.** Every request is checked in this order: it is
served at all; the user is signed in; the params fit; the scope's tier. The
answers:

| the host answers | a function (`valu.X.y()`, an ack `{error: {status: true, code, message}}`) | an intent (`callService`) |
|---|---|---|
| not signed in | `401` `sign_in_required` | `{success: false, code: 'sign_in_required', error}` |
| not signed in, because the user's last sign-in was refused as `not_a_member` | `401` `not_a_member`, until the next sign-in attempt starts | `{success: false, code: 'not_a_member', error}` (a consent request is answered `{approved: false, reason: 'not_a_member'}`) |
| scope is `forbidden` | `403` `forbidden` | n/a: no intent has one |
| scope needs consent, not given | `403` `consent_required`, with `scope` | `{success: false, code: 'consent_required', error, scope}` |
| not served | `404` `unknown_function` (no such function), `501` `not_available` (a `local` function asked of the host) | `{error: {code: 'not_available', message}}` |
| an app-state function | `501` `not_available` for `Developer.*` and `VerusWallet.get-balance`, before the scope is weighed: they are answered from state only the Valu Social application holds, so nobody is asked to consent to them | n/a |
| params do not fit | `400` | n/a |
| 16 requests are running | `429` `busy`, at once; calls and intents count together | `{success: false, code: 'busy', error}` |
| a request runs past 30 s | `408` `timeout`; the late result is dropped | `{success: false, code: 'timeout', error}` |
| the grants could not be read | `503` `unavailable` | `{success: false, code: 'unavailable', error}` |

A write that was handed to the services and then ran out of time (`408`) or was
cut off (`503`) may have been applied: its ack carries `retryable: false`, and the
app decides whether to repeat it. A read is retried by the client's own policy.

**Scopes.** Every function has one scope, `<service>:<read|write>`; the intents
the host serves map to one. Each scope is in one tier:

| tier | what it means | scopes |
|---|---|---|
| `basic` | any signed-in user, no asking | `users:read`, `networks:read`, `profile:read`, `resources:read`, `time:read`, `applicationstorage:read`, `applicationstorage:write`, `application:identity` (`Application.get-identity-token`) |
| `consent` | the user's yes, once per app, kept until revoked; until then `consent_required` | `users:write`, `rooms:read`, `rooms:write`, `textchat:read`, `textchat:write`, `groups:read`, `groups:write`, `events:read`, `events:write`, `community:read`, `cbac:read`, `cms:read`, `cms:write`, `commerce:read`, `commerce:write`, `commerce:sell` |
| `forbidden` | never, whatever the user says, and never asked about | `cbac:write`, `veruswallet:read` (its one function, `VerusWallet.get-balance`, needs state only Valu Social holds and answers `501`), `veruswallet:write`, `developer:read`, `developer:write` |
| `local` | runs in the page with its own `fetch`; never reaches the host | `http:read`, `http:write` (`Http.*`; the `Time.*` and resource-URL functions also run in the page, under basic scopes) |

A scope the table does not have is refused, not allowed. The Commerce intents and
their scopes:

| scope | tier | `Commerce` intents |
|---|---|---|
| `commerce:read` | consent | `check-entitlements`, `get-cart`, `get-display`, `get-order`, `get-product`, `get-purchase-contents`, `list-categories`, `list-orders`, `list-products`, `list-purchases`, `preview-promo`, and the two subscriptions `subscribe-events`, `unsubscribe-events` |
| `commerce:write` | consent | `add-to-cart`, `clear-cart`, `remove-from-cart`, `update-cart-item` |
| `commerce:sell` | consent | `create-product`, `create-store`, `delete-discount-code`, `end-sale`, `get-analytics`, `get-my-product`, `get-my-store`, `list-my-products`, `list-network-access`, `list-promotions`, `list-seller-products`, `quote-bundle`, `remove-volume-tier`, `request-network-access`, `update-product` |

**Commerce events need the `subscribe-events` intent.** `valu.onCommerceEvent(handler)`
only listens; nothing arrives until the app subscribes:
`await valu.Commerce.subscribeEvents({ events: ['order-updated'] })`
(`commerce:read`, so the consent above). Each call replaces the set. The host holds
the subscription for the signed-in session, so it ends with a sign-out, a reload
and a revoked `commerce:read`: subscribe after every start and every sign-in. The
events and their data are in the README, "Commerce Events".

**Your CSP.** The client puts `<iframe src="<hostOrigin><hostPath>">` in the page, so an
app that sends its own `Content-Security-Policy` must allow the host origin in
`frame-src` (or in `default-src`, when there is no `frame-src`):
`frame-src https://valuguru.texpo.io`. The sign-in and consent windows are popups,
not frames.

### Typed intents: `valu.Commerce.getCart()`, `valu.Commerce.openCart()`

The intents Valu Social serves — the 49 of `Commerce`, `Application`'s four, the
`DataProvider` pickers, the room-point editor — are functions on the tree too
(2026-10-30), the same in both modes: `valu.Commerce.getCart()`,
`valu.Commerce.addToCart({ productId })`, `valu.Commerce.openCart()`,
`valu.Application.expandApplication()`. Each has its scope, so
`valu-permissions.json` declares it like any function, and the publish check
reads it. Write them this way; `valu.callService(new Intent('Commerce', 'get-cart'))`
still works, but the check cannot read a name hidden in a helper, and the mode
rule below is the typed function's.

Underneath they are still the intents they always were: the transport sends
`api:service-intent` to whoever frames or hosts the app. The reply comes back
in the ack envelope, so a refused intent reads like a refused function
(`{error: {status: true, code: 403, message: 'consent_required', scope}}`),
and a `consent_required` from a click goes through the same consent window.
An intent is never retried.

**What happens at the app's own address** depends on the function's mode
(`descriptor.mode`; the generated types say it):

| mode | functions | at the app's own address |
|---|---|---|
| `both` | the Commerce data functions (reads, cart, seller) and `Application.getIdentityToken` | served by the host, as inside Valu Social |
| `window` | `Commerce.openCart`, `openOrder`, `openProducts`, `openPurchases`, `openPurchaseInMedia`, `previewPurchase`, `checkout` | **opens Valu Social in a tab**, on the sign-in origin, showing that window; one named tab, reused. Call these from a click, or the browser blocks the tab and the answer is `501 popup_blocked`. The answer is `{data: {success: true, opened: 'tab'}}` at once; what the user does there reaches the app through the Commerce events it subscribed to. `popup` is forced off there (the window is the tab's main app); inside Valu Social it keeps its meaning |
| `embedded-only` | `Application.expandApplication`, `closeApplication`, `closeAll`, `DataProvider.pickSingle`, `pickMultiple` | nothing to do: `{data: {success: true, skipped: true, reason: 'embedded_only'}}`, and one `console.warn` per page. Hide such a control when `valu.mode === 'dedicated'` |
| `embedded-served` | the seller's publish and pricing functions (`publishProduct`, `setSale`, …), `rateProduct`, the room-point editor | only Valu Social runs them today: `501 not_available` there, as before |

A socket client (`createValuServices({ socket })`) cannot send an intent at all
and answers `501`: only an app Valu Social frames or hosts has somewhere to send it.

### Declaring permissions

An app says which scopes it needs, and why, in `valu-permissions.json`. The
Developer Portal shows the list to the app's developer and to the reviewer who
approves it, each scope with the same sentence the consent window uses.

```json
{
  "permissions": [
    { "scope": "rooms:read", "why": "Lists your rooms on the home screen." },
    { "scope": "commerce:read", "why": "Shows the products in your shop." }
  ]
}
```

- `scope` is a scope from the table above (`<service>:<access>`, lower case). `why`
  is one plain sentence a reviewer can check against what the app does, at most
  200 characters. List every scope the code uses and no other.
- **The file is binding.** An app may call only the scopes it declares, at its own
  address and inside Valu Social, every tier included (`basic` too). A call to
  any other scope is refused with `permission_not_declared` (an ack with
  `error.message === 'permission_not_declared'` and `error.scope`; the unwrapping
  paths throw `PermissionNotDeclaredError`, and `isPermissionNotDeclared(x)` tells
  it apart). The fix is a line in the file, never a retry.
- **The reason is required.** An entry without a `why` is shown but declares
  nothing.
- **Valu enforces its own copy.** For the app's workspace members it is the newest
  publish's file; for everyone else, the released version's. A new permission
  works for other people only once its version is approved.
- Declaring is not granting: a consent scope still asks the person, and a
  forbidden one is never allowed.
- **Inside Valu Social the older bridge is checked too.** `callService(new
  Intent(…))`, `run(new Intent(…))` and `getApi(…).run(…)` each need a scope
  (`scopeOfServiceIntent`, `scopeOfAppIntent`, `scopeOfApiCommand`); opening Valu
  Social's own screens is `ui:open`, a request to another framed app
  `apps:intent`. What has no scope there (the console, sign-out, the session,
  any modal by name) is refused.
- The rule is switched on in steps: `off`, then `report` (calls run and misses
  are counted), then `enforce`.
- **A Workspaces app** keeps the file at its repository root. Every publish reads
  the source (not the build) for valu-api calls and compares them with the file;
  a scope the code uses that the file does not declare is a call that will be
  refused, and the reviewer and the AI worker are told about every difference.
  A publish is never refused over it.
- **Any other app** serves the file at
  `https://<its origin>/.well-known/valu-permissions.json`, with
  `Access-Control-Allow-Origin: *` so the portal can read it.
- **Name calls with literals** so they can be read: `valu.Rooms.searchMyRooms(…)`,
  `valu.data.Users.current()`, `valu.call('Rooms.search-my-rooms', …)`,
  `new Intent('Commerce', 'get-cart')`. A name built at run time
  (`valu.call(name)`, `valu[service][fn]()`) is listed as a call that cannot be
  read, and the reviewer will ask what it does.

The same reader is in the package: `detectScopes(files)`,
`parsePermissionsFile(text)` and `comparePermissions(file, scopes)`, from the
root or from `@arkeytyp/valu-api/src/scan/index.js` (no side effects at import).

### The two origins belong together

The sign-in page hands the one-time token to the host iframe of its **own build**
(its `host.origin`) and to no other origin, and the host takes a token only from
the sign-in origins it was built with. So `hostOrigin` and `signInOrigin` are a
pair: the default host with one of the published brands (`https://live.valuverse.io`,
`https://texpo.io`, `https://valu-social.com`, `https://chabaduniverse.com`), or a
local host (`http://localhost:3001`) with the local sign-in page
(`http://localhost:3006`) that host build lists in `HOST_SIGN_IN_ORIGINS`. A
mismatch fails quietly: the token goes nowhere, the popup closes, and `signIn()`
rejects `cancelled` once the ten-second grace has passed.

### Connection

`valu.connection.state` is one of:

| state | |
|---|---|
| `connecting` | the host is up, but the master has not confirmed the user yet: `api:ready` named it while a stored session was still being checked and the master opened. `auth.state` may already say signed in |
| `ready` | signed in, link up |
| `reconnecting` | the host's link to the platform dropped, or could not be made at the start, and the host is retrying; the user stays signed in and calls are held, not failed |
| `offline` | the browser is offline (no `lastError`), or the host will never serve this page (`lastError.code` is `unknown_app`, `nested` or `protocol_unsupported`) |
| `signed_out` | no user |

`on('change', ({ state, reconnected, lastError }) => …)` fires for every push;
`reconnected: true` is the notice that a dropped link is back, and what the app
cached about the platform predates it (the SDK's own cache is already cleared).
After the host iframe itself was replaced it comes with the first `ready`, which
is later than the replacement when the new host is still `connecting`.

**Start with a stored session.** The host checks a stored session and opens the
master before it says `api:ready`, but waits at most five seconds for both.
`valu.ready` and the factory do not wait for more than `api:ready`, so the app
can start with the user **signed in from storage and the link `connecting`**:
`auth.state` is `{signedIn: true, user: {id, name: null}, network: {id, name: null}}`
(names are not known yet), `connection.state` is `connecting`. What follows:

| the master | the host pushes |
|---|---|
| opens (late) | `auth` with the full identity, then `connection` `ready` |
| cannot be reached | `auth` `{signedIn: true, reason: 'unavailable'}`, then `connection` `reconnecting` (`offline` when the browser is) |
| refuses the session | `auth` `{signedIn: false, reason: 'session_expired'}`, then `connection` `signed_out`; the stored session is forgotten. (A refusal that comes before `api:ready` is in `api:ready` itself, signed out, and only the `auth` push follows.) |

`unavailable` with `signedIn: true` is not a failed sign-in: the session is kept and
the host retries, 1 s doubling to 30 s (each ±20 %), and at once when the browser
comes `online`. When a retry opens the master the app gets `auth` (no `reason`) and
`connection` `ready`; a retry the master refuses signs the user out as above.
Calls made meanwhile are held, within their own timeouts.

**A host that dies.** A host that stops answering is replaced silently; calls that
were on the wire answer `503 host_restarted`, and a write among them is
`retryable: false` (it may have been applied). A replacement that fails is tried
again on a fresh iframe, 1 s doubling to 30 s (each ±20 %), and at once on `online`,
for as long as the page lives; the state stays `reconnecting` and calls are held
meanwhile, each within its own timeout: a service call answers `408` at its
`timeoutMs`, and a request to the host (`signOut()`, a consent, an intent) that is
still held after 30 s rejects `host_unreachable` with `retryable: true` (it never
reached a host). Only a host that says this page will never be served (`unknown_app`,
`nested`, `protocol_unsupported`) ends it: `offline` with that code as
`lastError.code`, and the app should say so.

### Inside Valu Social

The same app, framed by Valu Social, is **embedded**, and its code does not
change: `createValuApp()`, then `valu.Rooms.searchMyRooms()`, `valu.data.X.y()`,
`valu.call(name)`. The same functions give the same answers: Valu Social answers
each call with valu-api's own function over its own connection (the frame server
below), not with its intents, so a room is ids and names here as at the app's own
address, and a refusal is the same ack. What differs is what the host is there
for:

- **No permissions.** There are no tiers, no grants and no consent inside Valu
  Social: it gives a framed app the trust it gives framed apps' intents. A
  function the host refuses `forbidden` or `consent_required` runs.
  `auth.requestConsent(scopes)` resolves `true` and asks nothing (a bad `scopes`
  is still a `TypeError`), so an app that asks first works in both modes.
- **The user is Valu Social's.** `auth.state` is `{signedIn, user, network}` as
  Valu Social's `api:ready` names them (`{id, name}` each, or `null`; signed out
  until it comes), and `valu.network` is that network. `auth.signIn()` has nothing
  to do: once `api:ready` has come it resolves that state when there is a user, and
  rejects `not_available` when there is none; it opens nothing. `auth.signOut()`
  rejects `not_available`: an app cannot sign the user out of Valu Social. An
  `api:ready` that names another user is an `auth` `change`.
- **`local` functions run in the page**, as in dedicated mode, before `api:ready`
  too.
- **A call made before `api:ready` waits for it**, within its own timeout. When no
  `api:ready` comes within `readyTimeoutMs` (10 s), `valu.ready` rejects
  `host_unreachable`, the waiting calls (and every later one) answer
  `{error: {status: true, code: 503, message: 'host_unreachable', retryable: true}}`, and
  `connection` is `offline` with that `lastError`. One that comes later after all
  serves calls from then on (`connection` `ready`); `valu.ready` stays rejected.
- **An older Valu Social**, whose `api:ready` does not say it answers calls, leaves
  every service function answering `501`, by name too; intents (`callService`)
  work as they always did. So does a parent that is not trusted (below). Use
  `valu.mode` to tell the modes apart.

#### Whom an embedded app trusts

Any page can frame an app and post it an `api:ready`. One that says `valuApi.calls`
would be sent every call, params and all, and could answer them as it liked and
name any user. So `valuApi`, the calls and the identity together, is taken only
from a parent whose origin is trusted:

- by default, the Valu origins the host trusts for sign-in (`DEFAULT_SIGN_IN_ORIGINS`):
  `https://live.valuverse.io`, `https://valu-social.com`, `https://chabaduniverse.com`,
  `https://texpo.io`;
- when the app passes `hostOrigins`, that list and nothing else (it also decides
  which parent the bridge binds to at all).

A parent that is not trusted gets exactly the embedded mode of before: the bridge
binds to it (`valu.ready` resolves, intents by name work), the service tree answers
`501`, and `auth.state` is signed out, whatever its `api:ready` says. Nothing is
posted to it as `api:call`.

For local development against a Valu Social on your machine, name it:

```javascript
const valu = await createValuApp({ hostOrigins: ['http://localhost:3005'] });
```

Do not ship that list: in production either leave `hostOrigins` out or list the
Valu origins your app runs in.

On the wire, the call is the one the host gets: `api:call` with `{service, action,
params, requestId, timeoutMs}`, answered by `api:call-completed` whose `message`
is the ack. Valu Social says it answers them in `api:ready`, next to the launch
intent: `message.valuApi = {protocol: 1, calls: true, user, network}`.

The bridge is also as it was, with the hardening of the transport: the peer is the
embedding window (`window.parent`) only, bound once by its first `api:ready`, and
every later message is taken only from that window and origin. `hostOrigins`
narrows it further, and is the trust list above.

**Valu Social's side** is `createFrameServer`, **one per framed app**, each over
services of its own on the connection Valu Social already has:

```javascript
import { connectValuServices, createFrameServer } from '@arkeytyp/valu-api';
// or: import { createFrameServer } from '@arkeytyp/valu-api/src/embed/FrameServer.js';

// For each framed app: its slug as the host resolver names it (`ResolvedApp.slug`).
const services = await connectValuServices({ socket: webSocketService, userId, applicationId: app.slug, cache: null });
const frames = createFrameServer({ services });

// the api:ready posted to a frame carries one more key
post(frame, 'api:ready', { ...launchIntent, valuApi: frames.readyInfo({ user, network }) });

// an api:call, taken only from that frame (event.source === iframe.contentWindow, its origin)
const ack = await frames.handle(event.data.message);
post(frame, 'api:call-completed', ack, event.data.message.requestId);   // to the frame's origin, never '*'
```

`handle(message)` holds a call to the host's checks less the two that are the
host's alone (sign-in and the permission tiers): an unknown function is `404`
`unknown_function`; a `local` one is `501` `not_available` (the app runs those
itself), and so is an `app-state` one (`Developer.*`, `VerusWallet.get-balance`)
unless the server was given `{ appState }`, which every call then reads; params
that do not fit are the validator's `400`. Then ONE attempt (`retries: 0`: the
app's own client retries), uncached, bounded by the call's `timeoutMs` (at most
30 s); one that runs out answers `408` `timeout`, `retryable: false` for a write.
Every answer passes the host's leak guard: one that carries a credential is
replaced by `{error: {code: 'internal', message: 'blocked outbound credential'}}`
and logged by key path, never by value. It never rejects. `readyInfo({ user,
network })` keeps only `{id, name}` of each. Rebuild the services (or
`handleReconnect` them) on a reconnect, and both on a change of network or user,
so no services outlive the connection they were made on.

Per app is required, not a tuning. The functions that address the calling app's
own shelf (`ApplicationStorage.*`, and the two `CMS` functions when no room,
directory or community is named) read the services' `applicationId`, never the
call's params, and the host stamps the app's slug there. So:

- `applicationId` is the framed app's **slug**, as the host resolver names it (the
  `slug` of its `ResolvedApp`, what the host stamps), and never the full
  `<workspace>/<slug>` address. Only when the resolver does not know the frame's
  origin (`404 unknown_app`, or a non-https origin such as a local dev server) is
  the app's Valu Social application id the fallback: the host serves no calls for
  such an origin, so there is no shelf of its own address to match. Services built
  without one answer `ApplicationStorage.*` `403` and put the `CMS` default shelf at
  `app:null:…`; services shared by two apps put both on one shelf.
- `cache: null`, as the host's services have: the frame server reads nothing from
  a cache (every call is `bypassCache`), and the default one would only fill with
  entries nobody reads.

The shelf is `app:{slug}:userSortingTable:{userId}`, keyed by the slug alone, so
two workspaces whose apps have the same slug share a user's shelf. That is the
host's behaviour too; embedded mode only matches it.

See also: [socket-adapters.md](socket-adapters.md) for what a socket *is* here
and how to write a third adapter, [socket-functions.md](socket-functions.md) for
the functions themselves, and [authorization.md](authorization.md) for what is
still advisory.
