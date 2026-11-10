# Changelog

## Unreleased

### Added

- **`valu.Developer.listApplicationApis()` and `valu.Developer.listMyApplicationApis()`**:
  the REST APIs the network's published apps declare, and the caller's own
  (drafts included), as typed intents (`developer:read`, inside Valu Social
  only). They were reachable only over the older bridge.
- The scanner names old calls the way Valu counts them, and sees direct postMessage bridge use.
  Every `bridge` finding carries `message` and `name`; `call` is unchanged.
- **Old bridge → typed function table.** `BRIDGE_REPLACEMENTS` / `bridgeReplacement(kind, name)`
  name the typed function that replaces each call an app makes over the older
  postMessage bridge (`api:run` pointer calls and their aliases, `run-intent`,
  service intents, `pushRoute` / `replaceRoute`, and `api:run-intent` / `api:service-intent` /
  `api:create-pointer` posted straight to the parent window):
  `bridgeReplacement('pointer-run', 'users.current')` is `valu.Users.current()`.
  Generated from the catalogue; exported from the package root and from
  `@arkeytyp/valu-api/src/scan/index.js`.
- **Typed app intents.** Every intent an app may send to Valu Social's own apps
  is a function on the `createValuApp()` object, on a namespace named by the
  app's title, or on the service of the same name: `valu.Chats.openChannel({ userId })`,
  `valu.Calendar.openCalendar({ source })`, `valu.MyCart.openCart()`,
  `valu.Rooms.showRoom({ roomId })` — 62 of them, generated from a new snapshot
  of valusocial-web's `PREDEFINED_APPLICATIONS`
  (`manifests/application-manifests.snapshot.json`, `npm run sync:manifests`).
  Each carries the scope Valu Social's bridge gives the same intent, takes
  `route` and `pushToHistory` too, and has a mode for the app's own address
  (`docs/connecting.md`, "Typed intents"). Valu Social's own intents (sign-out,
  LLM Debug, the staging Content Studio, Metaverse 2D's `agent-*`) and the two
  with no scope (`merchant.open-moderation`, `valuguru.show-chatbots`) are not
  functions; `docs/service-api.md` lists them.
- **`valu.Apps`**: `open(appId, { route })` and `send(appId, action, params)`
  for any app by id, a framed or Developer Portal one included (scoped when they
  run; the permission scanner reads a literal id and lists a dynamic one), and
  `isLoaded(appId)`, `list()`, `has(appId)` (the `AiGuru.is-application-loaded`
  / `get-applications` / `has-application` intents, now scoped `ui:open` as the
  matching API pointer commands are; inside Valu Social only).
- **`valu.route.push(path)`, `valu.route.replace(path)`, `valu.onRoute(handler)`**:
  the app's own route inside Valu Social, without `valu.bridge`.
- **More service intents typed**: `valu.CMS.pickResource(...)` (embedded only),
  `valu.RoomZones.*`, and the `RoomPoints` reads and writes the socket could
  answer (`listRoomPoints`, `saveRoomPoint`, `deleteRoomPoint`).
- **Intents over `api:call`.** Inside Valu Social a typed intent (old and new)
  and a route are an `api:call` with `intent: {target, id}` when Valu Social's
  `api:ready` says `valuApi.intents: true`; with an older Valu Social they keep
  going over the older bridge (`api:run-intent` to an app, `api:service-intent`
  to a service, `api:run-command`). Either way the call is held for `api:ready`
  and bounded by its timeout. At the app's own address an app intent that
  opens no window answers `not_available` without asking the host.
- **`createFrameServer({ intents, toFrame })`**, Valu Social's half: it answers
  those calls through the same checks and permission gate as a function
  (catalogue → `intents` given → params → gate with the bridge's scope → one
  bounded attempt → leak guard, which lets only `Application.get-identity-token`'s
  own token through). `services` is optional now (functions then answer 501),
  and `readyInfo` says `calls` and `intents` separately.

- **Which valu-api an app runs, reported at runtime.** Inside Valu Social
  (embedded mode) every message the app posts — `api:call` and the older bridge
  messages alike (`api:run-intent`, `api:service-intent`, `api:create-pointer`,
  `api:run`, `api:run-console`, `api:run-command`) — now carries `client`, this
  package's version (`src/version.js`). Additive: a Valu Social that does not
  know the key ignores it, and no protocol version moved. At its own address the
  host already got the version in `host:hello`; it now tells Valu Guru
  (`valuguru.apps.versions.use {appKey: 'ws:<address>', version, count: 1}`) over
  its own Guru client, once per page load per (app, version), a few seconds
  after `api:ready` (`versionReportDelayMs`, default 5 s) and only while the user
  is signed in. A `client` that is not a plain version is not reported; a Guru
  that does not know the op drops it. The Developer Portal uses the counts to
  tell a developer whose app runs an older valu-api, and the superAdmins which
  apps run what.

### Changed

- `scopeOfServiceIntent` skips the application-intent descriptors, so a name
  folded onto a service (`Rooms.show-room`) stays unscoped as a service intent:
  the bridge's gating does not move.
- The README and `docs/service-api.md` teach intents as functions;
  `sendIntent`, `callService`, API pointers and console commands are marked as
  being retired (Valu Social will close that bridge to apps).

## 2.0.0 — 2026-11-06

The first version 2 on npm (`npm install @arkeytyp/valu-api@^2`). Until now it
was installed from GitHub by commit (`github:Roomful/valu-api#b951fb7`, the same
code). From here on, a new version in `package.json` on `main` is a release:
`.github/workflows/npm.yml` tests it, publishes it (npm Trusted Publishing, no token) and tags the commit. The
package carries only what an app needs (`src`, `types`, `bin`, `manifests`,
`docs`, the READMEs): 2 MB instead of 25.

### Added

- **Service functions inside Valu Social (embedded mode).** An app framed by Valu
  Social calls `valu.Rooms.searchMyRooms()` exactly as at its own address and gets
  the same answer: `createValuApp()` sends every function but the `local` ones
  (which run in the page) as the same `api:call` the host gets, and Valu Social
  answers it with valu-api's own function over its own connection. It does so once
  its `api:ready` says `valuApi: {protocol: 1, calls: true, user, network}`; a call
  made before then waits for it, and without that key (an older Valu Social) the
  tree answers `501` as before. `valuApi` (the calls and the user) is taken only
  from a trusted parent origin: `hostOrigins` when the app gives it, otherwise the
  Valu origins the host trusts for sign-in (`DEFAULT_SIGN_IN_ORIGINS`, now defined
  in `src/host/origins.js` and re-exported by `src/host/Host.js`). Any other parent
  still binds the bridge for intents, but gets the `501` tree and a signed-out
  `auth.state`. A local Valu Social needs `hostOrigins: ['http://localhost:3005']`.
  No permissions inside Valu Social: no tiers, no grants, no consent. See
  [docs/connecting.md](docs/connecting.md#inside-valu-social).
- `createFrameServer({ services, appState?, log? })`, from the package root and
  `@arkeytyp/valu-api/src/embed/FrameServer.js`: what Valu Social mounts to answer
  its framed apps, one per framed app, over
  `connectValuServices({ socket, userId, applicationId: <the app's slug>, cache: null })`
  (the app's storage shelf is addressed by that slug, as at the host).
  `readyInfo({ user, network })` is the `valuApi` key of `api:ready`;
  `handle(message)` is the ack of one `api:call`: the host's checks less sign-in
  and the permission gate (`404`; `501` for `local`, and `app-state` without an
  app state; `400`), ONE attempt bounded by the call's `timeoutMs` (at most 30 s),
  the host's leak guard. Never rejects; no DOM.
- `createValuApp({ readyTimeoutMs })`, default 10 000: how long to wait for
  `api:ready`. Embedded: `valu.ready` rejects `host_unreachable` after it, the
  calls held for it (and later ones) answer `503 host_unreachable` with
  `retryable: true`, and `connection` is `offline`; a late `api:ready` still
  serves calls. Dedicated: the host handshake's bound, as before.
- `ServiceClient.call(name, params, { appState })` (and `ValuServiceApi.call`): the
  application state one call's handler reads, in place of the transport's. The
  frame server gives its app state to every call this way.

- `hostPath` on `createValuApp` and `HostTransport`: where on `hostOrigin` the host
  page is, `/host/` by default. The consent page is `consent.html` beside it.
  valusocial-web's web host is served from the root of its own origin:
  `createValuApp({ hostOrigin: 'https://api.valuguru.app', hostPath: '/' })`.

- `createValuApp(options)`: the one entry point an app uses. It returns one
  object with the bridge (`callService`, `sendIntent`, `onCommerceEvent`,
  `addEventListener`), the service tree (`valu.Users.current()`,
  `valu.data.Users.current()`) and `auth`, `network` and `connection`. A
  top-level page (or `?valu-mode=dedicated`) is **dedicated**: the page runs on a
  hidden host iframe, signs the user in through a popup (`valu.auth.signIn()`,
  from a click) and has its calls checked against the app's grants, with the
  consent dialog opened on `consent_required` when the call came from a click. A
  framed page is **embedded**: the bridge as it always was, and the service
  functions answered by Valu Social (above). See
  [docs/connecting.md](docs/connecting.md#dedicated-mode--createvaluapp).
- `valu.call(name, params, options)`, `valu.invoke(name, params, options)` and
  `valu.toolDefinitions(filter)` on the object `createValuApp` returns: the
  by-name surface of the services tree, over the same client and transport as
  `valu.Users.current()` (so the consent retry applies), in both modes.
- `createValuApp({ hostOrigins })`: embedded mode's optional pin on the origins
  the embedding application's `api:ready` may come from.
- `HostTransport`, exported from the package entry: the page's side of the host
  bridge, used by `createValuApp`.
- Types for both, and for the auth and connection state and the error codes
  (`types/valu-api.d.ts`).

### Changed

- **Embedded bridge hardening** (`PostMessageTransport`). It used to take
  `api:ready` from any window and re-point every later message at its sender, so
  any frame or opener that could post to the page could take the bridge over.
  Now: `api:ready` is accepted only from `window.parent` when the page is framed;
  the origin of the first one is bound, and replies, triggers and further
  `api:ready` messages are taken only from that window and origin; everything
  else is dropped. There is no default origin list; `hostOrigins` (above) pins one.
  A page that is not framed has no parent to name, so its first `api:ready` binds,
  subject to `hostOrigins`, as before.
- `package.json` has an `exports` map now. These subpaths resolve: the package
  itself, `src/*` (the host page imports `src/host/*`), `manifests/*` (the
  service manifest snapshot), `types/*.d.ts` and `types/*` (the declarations, by
  package path, for `/// <reference types>` and for TypeScript under
  node16/nodenext) and `package.json`. Anything else, `scripts/*` say, is no
  longer importable by package path. `test/package-exports.test.js` runs the map
  against a symlinked install.
- The rule on service functions: they run over a connection (`SocketTransport`),
  over the host bridge (`HostTransport`), which checks the app's grants before
  every call, or, inside Valu Social, over Valu Social's connection
  (`EmbeddedTransport` posting `api:call` to the frame server).
  `PostMessageTransport` itself still serves none
  ([docs/authorization.md](docs/authorization.md)).
- Embedded `auth`: `auth.state` is Valu Social's user and network from
  `api:ready` (`{signedIn: user !== null, user, network}`, the dedicated shape), not
  always signed out; `signIn()` resolves it when there is a user (it used to reject
  `not_available` always) and still rejects `not_available` when there is none;
  `requestConsent()` resolves `true` without asking (it used to reject
  `not_available`); `signOut()` still rejects `not_available`. `fetchImpl` and
  `localTransport` apply in embedded mode too.
- Client follows the host: an `auth` push with `reason: 'timeout'` (the host gave
  up redeeming the sign-in token) rejects a waiting `signIn()` with `timeout` at
  once, not after its own five minutes. `createValuApp`'s `auth.state` and
  `connection.state` read the signed-in-while-`connecting` start and an
  `unavailable` push with `signedIn: true`; `valu.ready` still resolves at
  `api:ready`. Types: `ValuAuthReason` has `timeout`, `bad_origin` is gone from the
  error codes (the host no longer sends it), `not_a_member` is documented as a
  `401` call refusal and an intent code.
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
  removed starts a recovery instead of failing the call with 503. A request
  held meanwhile (`signOut()`, a consent, an intent) waits at most its
  `timeoutMs`, else 30 s, then rejects `host_unreachable` with `retryable:
  true`. When the new host is still `connecting`, `reconnected: true` comes
  with its first `ready` push instead of the replacement's.
- A tab whose master becomes unreachable is pushed `connection reconnecting`
  before `auth {reason: 'unavailable'}`, never `ready` with `unavailable`.
- `veruswallet:read` is a `forbidden` scope, no longer `consent`: its only
  function, `VerusWallet.get-balance`, is on the `app-state` channel and the
  host answers it 501, so a consent for it would grant nothing. A consent
  request naming it is refused (`invalid_request`).
- The host's resolver lookup is bounded at 4 s (was 10 s), so hello to
  `api:ready` (resolve plus the 5 s stored-session wait) stays under the
  client's 10 s.
- Removed: the unused `brandOrigins` host config and `HOST_ERRORS.BAD_ORIGIN`.
