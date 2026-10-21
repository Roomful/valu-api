# Authorization

Phase 1.6. Implemented in `src/auth/`.

## The rule

**A third-party application never receives the user's `sessionId`.** It gets an
application token: scoped, expiring, revocable, bound to one application. The
session credential is none of those — whatever holds it can do everything the
user can do, for as long as the session lives.

`assertNoCredentialLeak()` enforces it mechanically. It walks anything the SDK
is about to put on the wire on an application's behalf and throws on
`sessionId`, `session_id`, `session`, `cookie`, `authorization`, `password` and
the refresh-token spellings. A leak is not a bug that shows up as a wrong
answer; it is one that never shows up at all, so it is checked rather than
intended.

### `ValuSocketConnection` takes a `sessionId`. That is not an exception to it.

`openValuSocket({ sessionId })` ([connecting.md](connecting.md)) opens a socket
with the user's session — because the runtimes that use that door are the ones
**already holding** it: the Valu Social application itself, and a process the
user ran. It is not a way to give a third-party application a session, and
nothing about it relaxes the rule above:

- The credential goes into the handshake and nowhere else. No getter reads it
  back, `describe()` redacts it, and every message leaving the connection passes
  through a redactor in both raw and percent-encoded form.
- `assertNoCredentialLeak` is unchanged and still refuses a params object
  carrying one, so a session cannot travel as a call parameter.
- A framed application reaching services over this package still gets an
  application token, and still gets no socket until 3.3 (below).

### Service functions run over a connection, or over the host bridge

A service function is one a *connection* answers, and the connection is where its
caller is checked. Two transports serve them:

- `SocketTransport`, over a Roomful socket that something authorized (the session
  or application token above);
- `HostTransport`, the page's side of the host bridge in dedicated mode
  (`createValuApp`, [connecting.md](connecting.md#dedicated-mode--createvaluapp)).
  The page holds no session and no socket: each call is an `api:call` to a host
  iframe on a Valu origin, and that host **checks the app's grants before every
  call**. That check is the host's, not the page's, so it is not advisory in the
  sense of the scope check below.

`PostMessageTransport`, the bare bridge to the Valu Social application around a
framed app, serves none, because nothing on it enforces anything: a framed app
asks for the application's intents by name (`ValuApi.callService`), and its
service tree answers `501`.

## Acquisition

`AuthProvider({acquire})`. The SDK never mints a token:

- **Browser** — `acquire` asks the Valu Social application over the postMessage
  bridge (`Application.get-identity-token`, which stays postMessage-bound
  precisely because minting the token is that application's job).
- **Headless** — `acquire` is whatever the caller already authenticates with.

Concurrent callers share one acquisition. A reconnect that wakes fifty pending
calls asks for one token, not fifty.

## Handshake

`await auth.handshake({applicationId, networkId})` returns exactly
`{token, applicationId, networkId}` for the socket's connect payload.

## Refresh

A token is refreshed when it is within 60s of expiry (`skewMs`), on the next
call that needs it. There is no background timer: an idle SDK should not keep a
token warm, and the first call after a gap pays a single acquisition.

## Revocation

`await auth.revoke()` clears the token locally and calls the issuer's `revoke`
hook when one was supplied. The next call acquires a fresh token.

## Scope checking — advisory until Phase 3.3

Every descriptor carries the scopes a caller needs (`users:read`,
`commerce:write`, …). `AuthProvider.scopeAck()` refuses a call whose token
lacks them, with a 403 envelope, before it reaches the wire. `service:write`
implies `service:read`; nothing else implies anything.

This is a **client-side** check. It catches an application calling something it
never asked for; it does not stop one that skips the SDK. Until Phase 3.3 puts
the manifest-enforced check on the dispatch side, an app token grants whatever
the user can do — which is why **no third-party app gets a socket before 3.3
lands**.

When there is no token at all the check passes: there is no claim to check
against and the remote is still the authority. Which means an SDK wired without
an `AuthProvider` behaves exactly as it does today.
