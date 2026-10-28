# Service functions inside Valu Social (embedded mode) — design

2026-10-28. Builds on the host core design (`2026-10-20-valu-api-host-core-design.md`) and on
`feat/host-path` (eea3186).

## 1. Why

`createValuApp()` already picks its mode from where the page is: a top-level page is
**dedicated** (the hidden host iframe), a page framed by Valu Social is **embedded** (the
postMessage bridge). But in embedded mode the service tree answers 501
(`UnservedTransport` in `src/createValuApp.js`): `valu.Rooms.searchMyRooms()` works at the
app's own address and fails inside Valu Social. So the worker's `project-valu-api` skill teaches
two code paths ("WHICH DOOR": framed → the old bridge recipes, not framed → valu-api), which is
the opposite of "new apps use valu-api only".

Goal: **one code path.** `createValuApp()` + `valu.X.y()` + `auth.signIn()` work framed and at
the app's own address, with the same answers. The package handles the mode; the worker is taught
nothing about modes.

## 2. Decisions

- **Pavlo, 2026-10-28:** an embedded app needs **no permissions** — no tiers, no grants, no
  consent — the same trust Valu Social gives framed apps' intents today. "Code in the valu-api
  package that handles mode, instead of teaching the AI."
- **Approach (my call, within that):** Valu Social answers valu-api's own `api:call` for its
  framed apps, by running **valu-api's own functions** over Valu Social's existing connection,
  through a module that lives in valu-api and that Valu Social mounts. Rejected: forwarding each
  function to Valu Social's existing service intents. Those answer with Valu Social's shapes
  (e.g. rooms carrying `@[room:…]` entity tags; valu-api answers ids and names, see
  `src/services/impl/Rooms.js` header) and errors, so one call would answer differently by mode,
  and 54 conversions would have to track Valu Social. Rejected: the host iframe inside Valu
  Social — the host refuses a framed app page by design (`nested`), and its storage would be
  partitioned under Valu Social's site, needing a second sign-in.
- **No permission gate at all** in embedded mode (literal reading of Pavlo's answer). Forbidden
  scopes included: a framed app can already reach all of them as intents by name. The two
  channels valu-api never sends over a connection keep their existing rules: `local` runs in the
  app page; `app-state` answers 501 unless Valu Social supplies an app state (it does not in v1).

## 3. Protocol (embedded; same bridge envelope `{name, message, requestId, target:'valuApi'}`)

- **`api:ready`** (Valu Social → app) gains one key next to the start intent's fields:
  `message.valuApi = { protocol: 1, calls: true, user: {id, name} | null, network: {id, name} | null }`.
  An app that does not know the key ignores it; a Valu Social that does not send it is an older
  build, and the app keeps today's behaviour (501).
- **`api:call`** (app → Valu Social), byte-identical to what `HostTransport` posts for a service
  function: `{ service, action, params, requestId, timeoutMs }` with the envelope's `requestId`.
- **`api:call-completed`** (Valu Social → app): `message` is a `ValuAck`, exactly as the host
  answers. Posted to the app frame's origin, never `'*'`.
- No pushes in v1. A network switch in Valu Social reloads its framed apps today; a later version
  can push `api:trigger {action:'auth'|'connection'}` with the host's shapes.

## 4. valu-api

1. **`src/embed/FrameServer.js`** — `createFrameServer({ services, appState?, log? })` →
   `{ readyInfo({ user, network }) → message.valuApi, handle(message) → Promise<ValuAck> }`.
   No DOM, no postMessage, no timers of its own beyond the call's: Valu Social does the posting.
   `handle` validates as the host's dispatch does (unknown function 404; bad params 400; `local`
   501 "runs in the app page"; `app-state` 501 without an app state), runs ONE attempt
   (`retries: 0`; the framed app's client owns retries, the host-core rule) bounded by the
   message's `timeoutMs` (capped like the host's), and passes the answer through the host's leak
   guard (`assertNoHostLeak`): no session id ever reaches the app. Reuse `HostDispatch` helpers
   rather than copying them. Exported from the package root and reachable as
   `@arkeytyp/valu-api/src/embed/FrameServer.js`.
2. **Client, `createValuApp` embedded mode:**
   - the service tree runs on a transport that serves `local` functions in the page (as
     `HostTransport` does) and sends every other function as `api:call` over the bridge **when
     `api:ready` said `valuApi.calls`**; without it, 501 as today. A call made before `api:ready`
     waits for it, within its own timeout.
   - `auth.state` comes from `valuApi.user`/`network` (`signedIn: user !== null`).
     `auth.signIn()` resolves that state when signed in (nothing to do inside Valu Social) and
     rejects `not_available` otherwise; `auth.requestConsent()` resolves `true` (nothing is asked
     inside Valu Social); `auth.signOut()` still rejects `not_available` (an app cannot sign the
     user out of Valu Social).
   - `valu.ready` rejects `host_unreachable` when no `api:ready` arrives within `readyTimeoutMs`
     (default 10 s): a frame that is not Valu Social (a preview, a third-party page) fails fast
     instead of waiting forever.
   - by-name calls (`valu.call`, `valu.invoke`), `valu.data` and the consent-retry wrapper keep
     working in both modes; `callService(intent)` is unchanged.
3. Types (`types/valu-api.d.ts`, consumer typecheck), `docs/connecting.md` (one "Inside Valu
   Social" section: same functions, same answers, no permissions, the user is Valu Social's),
   CHANGELOG.

## 5. Valu Social (valusocial-web)

- One `connectValuServices({ socket: <the WebSocket service>, userId })` per Valu Social session
  (the adopted-socket door: `adoptValuSocket` recognises the WebSocket service by `emitAsync`),
  wrapped in one `createFrameServer`. Rebuilt (or `handleReconnect`ed) on reconnect and on a
  network or user change, so no cache outlives the connection it came from.
  - **Amended 2026-10-28 (review of feat/embedded-calls): per framed app, not per session.**
    One `connectValuServices({ socket, userId, applicationId: <the app's slug from the host
    resolver>, cache: null })` and one `createFrameServer` per framed app, on the same socket.
    `ApplicationStorage.*` and the CMS default shelf are addressed by the services'
    `applicationId` (`app:{slug}:userSortingTable:{userId}`), as the host stamps it: a shared
    one would put every framed app on one shelf, or none (403, `app:null`). Never the launch
    intent's `applicationId`, never the `<workspace>/<slug>` address. `cache: null` as the host's
    services have it (the frame server bypasses the cache on every call). Two workspaces whose
    apps share a slug share a user's shelf, as at the host.
- `IFrameStore`: the `api:ready` it posts carries `valuApi: frameServer.readyInfo(...)`; a new
  `api:call` case, taken only from the app's own frame (`event.source === iframe.contentWindow`
  and its origin), answers `api:call-completed` with the frame server's ack, posted to the frame's
  origin.
- The valu-api pin moves to the commit that has `src/embed/`.
- valusocial-web's CLAUDE.md forbids committing without Pavlo's word: the work is left
  uncommitted in its worktree.

## 6. Done when

- valu-api: unit tests for the frame server (each refusal, one attempt, timeout bound, leak
  guard) and for embedded mode (calls over the bridge, held until ready, 501 without
  `valuApi.calls`, auth state, signIn/requestConsent/signOut, ready timeout); `npm test` and the
  typecheck green.
- valusocial-web: vitest for the `api:call` case and the `api:ready` key; the touched suites green.
- End to end on localhost: an app framed by a local Valu Social calls `valu.Users.current()` and a
  consent-tier function (`valu.Rooms.searchMyRooms()`) and gets the same answers it gets at its
  own address through the host, with no popup.
- Then the worker's skill drops WHICH DOOR for "call `createValuApp()` everywhere" (separate
  change, by the session that owns the skill).
