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

## Acquisition

`AuthProvider({acquire})`. The SDK never mints a token:

- **Browser** — `acquire` asks the host over the bridge
  (`Application.get-identity-token`, which stays host-bound precisely because
  minting is the host's job).
- **Headless** — `acquire` is whatever the caller already authenticates with.

Concurrent callers share one acquisition. A reconnect that wakes fifty pending
calls asks the host for one token, not fifty.

## Handshake

`await auth.handshake({applicationId, networkId})` returns exactly
`{token, applicationId, networkId}` for the socket's connect payload.

## Refresh

A token is refreshed when it is within 60s of expiry (`skewMs`), on the next
call that needs it. There is no background timer: an idle SDK should not keep a
token warm, and the first call after a gap pays a single acquisition.

## Revocation

`await auth.revoke()` clears the token locally and calls the host's `revoke`
hook when one was supplied. The next call acquires a fresh token.

## Scope checking — advisory in Phase 1

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
