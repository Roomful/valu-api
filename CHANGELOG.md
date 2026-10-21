# Changelog

## Unreleased

### Added

- `createValuApp(options)`: the one entry point an app uses. It returns one
  object with the bridge (`callService`, `sendIntent`, `onCommerceEvent`,
  `addEventListener`), the service tree (`valu.Users.current()`,
  `valu.data.Users.current()`) and `auth`, `network` and `connection`. A
  top-level page (or `?valu-mode=dedicated`) is **dedicated**: the page runs on a
  hidden host iframe, signs the user in through a popup (`valu.auth.signIn()`,
  from a click) and has its calls checked against the app's grants, with the
  consent dialog opened on `consent_required` when the call came from a click. A
  framed page stays **embedded**, as it always was. See
  [docs/connecting.md](docs/connecting.md#dedicated-mode--createvaluapp).
- `HostTransport`, exported from the package entry: the page's side of the host
  bridge, used by `createValuApp`.
- Types for both, and for the auth and connection state and the error codes
  (`types/valu-api.d.ts`).

### Changed

- `SocketTransport.socket` is now `ValuSocket | null`. `socket: null` builds a
  transport with no socket: it serves the `local` functions (`Http.*`, `Time.*`,
  the resource-URL builders) and answers every other one `503`. Code that read
  `transport.socket` must handle `null`. `SocketTransport.connected` is `false`
  without a socket even though the `local` functions work, so it is not a
  readiness gate for such a transport; `createValuApp` does not use it as one
  (`valu.ready` and `valu.connection.state` are the gates).
- `PostMessageTransport` takes the embedding window from its `target` (the
  constructor option) rather than from `globalThis.parent`, when it decides which
  window may bind the bridge with `api:ready`. A custom `target` without a
  `parent` property now skips the parent pin (the first `api:ready` binds, subject
  to `hostOrigins`); it used to fall back to `globalThis.parent`. The default
  target (`globalThis`) is unchanged.

### Host

- A stored session no longer holds `api:ready` back: the host waits at most
  `readyWaitMs` (5 s) for the session check and the master together, and the
  user is signed in from storage meanwhile. `api:ready` now says the state of
  the link (`host.connection`): `ready`, or `connecting` while the master still
  opens, followed by `auth` and `connection ready` when it does. `HostTransport`
  takes that state.
- A stored session whose check or master cannot be reached is no longer
  signed out: the app hears `auth {signedIn: true, reason: 'unavailable'}` and
  `connection reconnecting` (or `offline`), and the host retries (1 s doubling
  to 30 s, +-20 %, at once on `online`) until the master opens it or refuses it
  (`session_expired`, a sign-out as before).
- Signing in again in one tab replaces the shared stored session instead of
  clearing it first, so the other tabs move to the new session rather than to
  `signed_out_elsewhere`; a signed-out tab adopts a session another tab signs
  in with; a storage change that arrives while the host starts is no longer
  lost; a `valu-host:token` message without a token is ignored.
- After a sign-in that ends `not_a_member`, calls answer 401 `not_a_member`
  (intents and consent `not_a_member` too) instead of `sign_in_required`, until
  the next sign-in attempt starts.
- `app-state` functions (`Developer.*`, `VerusWallet.get-balance`) answer 501
  `not_available` before their scope is weighed, so no consent is ever asked
  for them (`Developer.*` answered 403 before). A service function sent as a
  raw `api:service-intent` names the SDK method to call (`use
  valu.Users.current()`).
- A redeem that takes longer than 15 s answers `timeout` (pushed as the `auth`
  reason) and stores nothing.
- The consent popup's Allow and Don't allow stay disabled until the window has
  been visible and focused for 600 ms, and again after every return to it.
- `HostTransport` keeps recovering a host that died: a failed recovery
  handshake is tried again (1 s doubling to 30 s, +-20 %, at once on `online`)
  with calls held and the state `reconnecting`; only `unknown_app`, `nested` and
  `protocol_unsupported` end it with `connection offline`. An iframe the page
  removed starts a recovery instead of failing the call with 503.
- Removed: the unused `brandOrigins` host config and `HOST_ERRORS.BAD_ORIGIN`.
