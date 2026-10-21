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
  window may bind the bridge with `api:ready`. Nothing changes for a page that
  passes no `target`.
