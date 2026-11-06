# Typed app intents over `api:call` — design

Status: decided (Pavlo, 2026-11-03 and 11-06); built on `feat/typed-app-intents`
(valu-api, valusocial-web), 2026-11-06.

## 1. Why

Valu Social will close the **intents bridge** to framed apps off the legacy
list: the postMessage messages `api:run-intent`, `api:service-intent` to an
intent outside valu-api's catalogue, `api:create-pointer` / `api:run` (API
pointers), `api:run-console` and `api:run-command`
(`2026-11-03-legacy-bridge-exceptions-design.md` §5.4). `api:call` stays, and so
does `api:service-intent` to a catalogue intent. The reason is safety: the bridge
lets any framed page drive Valu Social by name, and only `api:call` goes through
one checked path (valu-api's frame server and the permission gate).

**Not now.** This work *prepares* for closing it. Nothing is refused, and every
app that uses the bridge keeps working. Pavlo, 2026-11-03.

Before the bridge can close, everything an app does with it today must be a
**valu-api function** carried over `api:call`, and the docs must explain only
that. Today it is not:

| Call | Goes over | After the bridge closes (app off the legacy list) |
|---|---|---|
| `valu.sendIntent(new Intent('textchat', 'open-channel', …))` (an app intent) | `api:run-intent` | breaks |
| `valu.callService(new Intent(…))` to an intent outside the catalogue | `api:service-intent` | breaks |
| `valu.callService(new Intent(…))` to a catalogue intent | `api:service-intent` | works (legacy-bridge §5.4) |
| the typed intents of 2026-10-30 (`valu.Commerce.getCart()`, `valu.Application.expandApplication()`) | `api:service-intent` (`EmbeddedTransport.#callIntent`) | works: they are catalogue intents (legacy-bridge §5.4) |
| routes (`bridge.pushRoute`) | `api:run-command` | breaks |
| service functions (`valu.Users.current()`) | `api:call` | works |

So the typed SERVICE intents do not break when the bridge closes. The reason to
carry them over `api:call` too is one checked path for everything an app asks
(the frame server, the gate, the leak guard, the timeouts), and the app intents
and routes, whose bridge messages (`api:run-intent`, `api:run-command`) do
close.

And **the 77 application intents** (open a chat, a room, a profile, Calendar,
Media …) have no function at all: they are reachable only by name through
`sendIntent`. The docs site's only list of them is the Explorer's Intents page
and the Intents Reference, both generated from valusocial-web's manifests and
both teaching the bridge.

## 2. Goals

1. Every application intent an app may call is a typed function on the
   `createValuApp()` object, for example `valu.Chats.openChannel({ userId })`.
2. Every typed intent, old and new, travels over `api:call` when Valu Social
   says it answers them, and over the old bridge otherwise (an older Valu
   Social).
3. Valu Social answers intents arriving over `api:call` through the same frame
   server and the same permission gate as service functions.
4. The docs site explains intents only as valu-api functions.
5. When this ships, Valu Social can close the bridge for apps on the new
   valu-api without any change to those apps.

## 3. Non-goals

- Closing or refusing the bridge. That is a later change in valusocial-web,
  with its own rollout for apps built on older valu-api versions (the legacy
  backfill workstream).
- API pointers (`getApi(...).run(...)`) and console commands as typed
  functions. What apps need from them is already a service function
  (`network.id` → `valu.Networks.getCurrentNetwork()`). They simply stop
  working when the bridge closes, and the docs stop teaching them (§7).
- Changing what the host (dedicated mode) serves, or the host's own
  page ↔ host-iframe protocol. That is valu-api's own channel, not the bridge.
- A typed function for `AiGuru.get-chat-history`, `get-agent-history`,
  `query-knowledge-base`, `Logging.get-logs` and `Developer.*`. They are refused
  to apps by the scope tables already (unscoped, or `forbidden`).

**Anti-goals** (would be a failure even if it technically worked):

- A second path that skips the permission gate. An intent over `api:call` is
  checked exactly as the same intent over the bridge is checked today.
- Breaking an existing app. Old valu-api versions, and new valu-api against an
  old Valu Social, keep working exactly as now.
- Docs that teach `sendIntent` / `callService` / `getApi` as the way to do
  something.

## 4. Decisions made (Pavlo, 2026-11-03)

1. **Which app intents.** All of them except Valu Social's internal ones:
   `auth.logout`, every intent of LLM Debug (`iframe_llm_debug`), staging
   Content Studio (`staging-content-studio`), and Metaverse 2D's `agent-*`
   intents.
2. **Names.** Namespace by the app's **title** in PascalCase (`Chats`,
   `Media`, `Calendar`, `MyCart`, `ContentStudio`, `MerchantConsole`,
   `Metaverse2D`, `UserCard`, `ValuGuru` …). Where a valu-api service has the
   same name, the app's intents join that service's namespace (`Groups`,
   `Profile`, `Rooms`). Method names are the action in camelCase
   (`open-channel` → `openChannel`), as for every function.
3. **Mode at the app's own address.** The rule decided on 2026-10-30 for typed
   intents (docs/connecting.md "Typed intents"):
   - `window`: opens Valu Social in a tab;
   - `embedded-only`: skipped with one warning;
   - `embedded-served`: answers `501 not_available`;
   - `both`: served by the host.
4. **The bridge is not closed now.** This prepares for it.

### Decided 2026-11-06 (Pavlo)

5. §10.1: **yes**. `valu.Apps.open(appId, { route? })` and
   `valu.Apps.send(appId, action, params)`, scoped at run time by
   `scopeOfAppIntent(..., { toFrame })`; the scanner reads a literal `appId` and
   flags a dynamic one.
6. §10.2: **yes**. `valu.route.push(path)`, `valu.route.replace(path)`,
   `valu.onRoute(handler)`, over `api:call`.
7. **`valu.Apps.isLoaded(appId)`, `valu.Apps.list()`, `valu.Apps.has(appId)`**,
   from the live counts (one app polls the `app.isApplicationLoaded` API pointer
   about 76 times a minute): typed functions backed by the declared service
   intents `AiGuru.is-application-loaded`, `AiGuru.get-applications`,
   `AiGuru.has-application`, which were `no-rpc` and so untyped. Served inside
   Valu Social; at the app's own address `embedded-served` → `not_available`
   (the host has no dock to read, so it cannot answer honestly). Builder's
   call: they take the scope the matching API pointer commands already have,
   `ui:open` (BridgeScopes `SERVICE_INTENT_SCOPE`), which also makes
   `api:service-intent AiGuru.is-application-loaded` scoped on the bridge.
8. §8's builder items are done in this work: the `INTENT_MODE_OVERRIDES`
   review, `CMS.pickResource` (`embedded-only`), and `RoomZones.*` /
   `RoomPoints.*` (all scoped, so all typed; the three `not-ported` RoomPoints
   ones too, as intents, until a socket port replaces them).
9. Out of scope: M8–M10, `valu.theme`, publish guards.

## 5. Design

### 5.1 The catalogue: app intents as descriptors

- `scripts/sync-manifests.mjs` also snapshots valusocial-web's
  `PREDEFINED_APPLICATIONS` (`src/Configs/Application_Manifests.js`) into
  `manifests/application-manifests.snapshot.json`:
  - for each application: `id`, `title`, whether it is an iframe app, and its
    `intents` (action, description, availability, permissions, params);
  - sorted by id, intents in declaration order, as the service snapshot is.
- `scripts/generate.mjs` builds one descriptor per exposed app intent into
  `INTENT_DESCRIPTORS`, next to the existing typed intents:
  - `channel: 'intent'`, plus a new `target: 'application' | 'service'`. The
    existing ones are `service`.
  - `service`: the namespace (decision 2); `application`: the app id the intent
    is sent to (`textchat`).
  - `key`: `<Namespace>.<action>`.
  - `scope`: `scopeOfAppIntent(appId, action, { toFrame: <iframe app> })`.
  - `mode`: derived as today (`ui:open` → `window`, otherwise
    `embedded-served`), then `INTENT_MODE_OVERRIDES`.
- **Excluded** by a list in `scripts/bindings.js` (`EXCLUDED_APP_INTENTS`):
  decision 1's internal intents, by app id and action pattern.
- **An intent with no scope is not exposed.** Valu Social refuses it once
  permissions are enforced, so a function for it would be a trap. Measured
  with the real iframe flag (2026-11-03), only `merchant.open-moderation` is
  left out; that leaves 62 app intents. The generator lists what it left out,
  so a reviewer sees it.
- Content Studio is an iframe app, so its four intents are `apps:intent`
  (basic) and are exposed as `ContentStudio.*` (`embedded-served`). That is
  what the bridge allows today.
- **Bridge gating must not change.** `scopeOfServiceIntent` (BridgeScopes.js)
  looks the name up in the descriptor index first, and the bridge gate and
  the `/-i/` route both call it. App-intent descriptors must not make, for
  example, `api:service-intent Rooms.show-room` scoped (it is refused today).
  So `scopeOfServiceIntent` skips descriptors with `target: 'application'`,
  and a test pins three folded names (`Rooms.show-room`, `Profile.show-user`,
  `Groups.open`) as still unscoped there.
- **Collisions fail the build**: two descriptors with the same key, or an app
  method that equals an existing method in a folded namespace.
- **Params Valu Social reads beyond the manifest** (my call). Every app
  intent also accepts `route` and `pushToHistory` (declared by the SDK, as
  `extensions.js` does for service functions), because opening an app at a
  route is documented (valu-routing.md). `predefinedDock` / `predefinedLayout`
  are **not** offered: they let an app rearrange the user's dock, they are
  undocumented, and nothing outside Valu Social should change its layout.
- Types (`types/valu-services.d.ts`) and `docs/service-api.md` are generated as
  for every function, with the scope and mode in the JSDoc.

### 5.2 The wire: `api:call` carries intents

- The `api:call` message gains one optional field:
  `intent: { target: 'application' | 'service', id }`. Here `id` is the app id
  or service id the intent is addressed to, and `action` / `params` are the
  call's own. A call without `intent` is a service function, as today.
- Valu Social says it answers intents with one more key in `api:ready`:
  `valuApi: { protocol: 1, calls: true, intents: true, user, network }`.
  The key is additive, so the protocol number stays `1`.

### 5.3 The app side: `EmbeddedTransport`

- `#callIntent(descriptor, params)`:
  - when the last `api:ready` said `intents: true`: post `api:call` with
    `intent` set. It is held until `api:ready` like any call, bounded by the
    call's `timeoutMs`, never retried (`CallPolicy` already gives intents 0
    retries);
  - otherwise: the old bridge, as today. `api:service-intent` for
    `target: 'service'`; `api:run-intent` for `target: 'application'`, which
    is new for typed functions but is what `sendIntent` sends.
- The reply is read with `intentAck`, so a refused intent reads like a refused
  function in both paths.
- `valu.sendIntent` and `valu.callService` stay as they are, on the bridge.
  They are what closes later; the typed functions are the replacement.

### 5.4 The app side: `HostTransport` (dedicated)

Service intents are unchanged: `window` opens a tab, `embedded-only` is
skipped, the rest go to the host as today (the host counts what it does not
serve). For the new app intents:

- a `window` app intent opens `intentWindowUrl(origin, { service: <app id>, action }, params)`.
  Valu Social's `/-i/<id>/<action>` route already runs application intents
  whose scope is `ui:open` (`Router.#runIntentRoute`), so no web change is
  needed for this;
- `embedded-only` is skipped;
- `embedded-served` answers `501 not_available` locally. The host serves no
  app intent, so asking it would only add a round trip.

### 5.5 Valu Social's side: the frame server answers intents

- `createFrameServer({ services, gate, appState, intents })` takes a new
  option: `intents(target, id, action, params) → Promise<reply>`. Valu Social
  supplies it, doing what the bridge handlers do today with the **frame's own
  `Application` instance**, which stamps the sender (`get-identity-token`,
  `close-application` and `expand-application` need it):
  - `application`: `application.run(new Intent(id, action, params))`, as
    `api:run-intent` does;
  - `service`: `application.callService(new Intent(id, action, params))`, as
    `api:service-intent` does.

  The runner looks the instance up **on every call**
  (`getApplicationContext(manifestId)`). Frame servers are cached per app and
  origin, and a reopened app gets a new `Application`, so an instance captured
  when the server was built would go stale.
- **Intents do not depend on the app lookup or the services client** (my
  call). FrameCalls resolves the app's slug and builds services before every
  function call, and answers 503 when the Workspaces resolve endpoint is down.
  An intent needs neither, so it must not fail when only the resolver is
  down:
  - `services` becomes optional in `createFrameServer` (functions then answer
    501);
  - FrameCalls answers a call with `intent` set before the slug lookup;
  - `intents` is advertised separately from `calls`.
- `handle(message)` with `intent` set:
  1. the descriptor exists in `INTENT_DESCRIPTORS` for that `target` / `id` /
     `action` (404 `unknown_function` otherwise). The frame server never runs
     an intent the catalogue does not name;
  2. `intents` was given (501 `not_available` otherwise);
  3. the params fit (400);
  4. the gate: the descriptor's scope, which is the same scope the bridge
     handler computes today (`scopeOfAppIntent` / `scopeOfServiceIntent`);
  5. one attempt bounded by `timeoutMs` (cap 30 s), the reply through
     `intentAck`, then the leak guard. Never rejects.
- `readyInfo()` adds `intents: true` only when `intents` was given.
- valusocial-web builds its own `readyInfo` without loading valu-api
  (`FrameCalls.frameReadyInfo`), so it must add `intents: true` there too. The
  existing test that pins it to valu-api's `readyInfo` keeps the two equal.
- `FrameCalls` passes `intents` and routes an intent call as above. The
  IFrameStore `api:call` case itself needs no change, and the bridge cases
  stay as they are.
- **The identity token passes the leak guard only for its own intent** (my
  call). Inside Valu Social, `Application.get-identity-token` answers
  `{token}`, and `token` is a blocked key, so the guard would replace the
  answer. The host marks this one reply as allowed (HostDispatch / HostBridge);
  the frame server does the same, keyed by the descriptor, never by anything
  in the reply. Every other intent reply is guarded.

### 5.6 The permission scanner

`detectScopes` already reads typed calls from the catalogue. With the new
descriptors, `valu.Chats.openChannel(...)` maps to its scope with no scanner
change. A test pins one app intent per namespace kind: own, folded, and window.

### 5.7 As built (2026-11-06)

- Descriptors: `target` and `to` (the app or service id) on every intent
  descriptor; `positional` on the `valu.Apps` reads. One `INTENT_DESCRIPTORS`
  array; `APPLICATION_TARGETS` (every app id and whether it is a frame) and
  `UNTYPED_APPLICATION_INTENTS` beside it.
- Wire: `api:call {intent: {target, id}, action, params, requestId, timeoutMs}`;
  a route is `intent: {target: 'route'}`, action `push` | `replace`,
  `params: {path}`, never gated. `valu.Apps.open/send` to an app the catalogue
  names use that app's descriptor (params checked); otherwise a descriptor made
  at call time (`src/services/apps.js`), which the frame server scopes again with
  Valu Social's `toFrame`. An unscoped one is refused before it is sent.
- Counts: 62 app intents exposed (of 78 declared); left out: 14 by decision 1
  and `merchant.open-moderation`, `valuguru.show-chatbots` (no scope; the latter
  is new since 11-03). 70 typed service intents.
- `INTENT_MODE_OVERRIDES` for app intents (all `ui:open` → `embedded-only`):
  `Chats.get-ui-state`, `Chats.close-channel`, `Chats.options`, `UserCard.show`,
  `Calls.open-source-picker`, `Metaverse.set-route`. Every other `ui:open` app
  intent stays `window`.

## 6. Rollout

1. valu-api: §5.1–5.4, plus `createFrameServer`'s `intents` (§5.5), then a
   merge to `main` with a merge commit (consumers pin a sha).
2. valusocial-web: bump the pin, pass `intents` in `FrameCalls`, deploy to
   staging (texpo.io), then the four production brands (Pavlo's manual
   `prod_deploy.yml`).
3. The Workspaces worker skill (`project-valu-api`) teaches typed app intents.
   It applies only after production serves intents. The check needs a string
   that only the new code contains: `intents:` already occurs in the main
   chunk through the app manifests. So FrameCalls carries a named constant
   (for example `FRAME_INTENTS = 'valu-frame-intents/1'`), and the check
   looks for that string in the production bundle on all four brands.
4. Docs (§7).
5. Later, not in this work: Valu Social refuses the bridge, with notice for
   apps on older valu-api versions.

## 7. Docs

- **valu-api README** (`docs/readme-create-valu-app`): "Calling Valu" lists app
  intents as functions (`valu.Chats.openChannel({ userId })`), and `sendIntent` /
  `callService` move to a "Being retired" note. The System API section (API
  pointers, console) is marked as being retired.
- **Docs site** (`Roomful/valu-docs`):
  - The Explorer's **Intents** and **Service Intents** pages become one
    **Functions** page, generated from valu-api's catalogue
    (`SERVICE_DESCRIPTORS` + `INTENT_DESCRIPTORS`). Each function shows its
    scope and mode and the `valu.X.y(...)` call. Its **Run** button posts
    `api:call` (with `intent` for typed intents) when Valu Social's
    `api:ready` says so.
  - The **Intents Reference** page is replaced by valu-api's generated
    `docs/service-api.md`, synced by `scripts/sync-valu-api-docs.mjs`.
  - The CMS `pick-resource` example becomes `valu.CMS.pickResource(...)`
    (`CMS.pick-resource` becomes a typed service intent, §8).

## 8. Left to the builder

- `INTENT_MODE_OVERRIDES` for app intents. Some `ui:open` intents open nothing
  in a fresh tab: getters (`textchat.get-ui-state`), closers
  (`textchat.close-channel`, `videochat.leave-meeting`), `metaverse.set-route`.
  Each one is reviewed and set to `embedded-only` where a tab has no meaning;
  the list goes in the PR description.
- Typed functions for the **service** intents still missing: `CMS.pick-resource`
  (`embedded-only`: a picker), and `RoomZones.*` / `RoomPoints.*` if they have
  scopes. Add their services to `INTENT_FUNCTION_SERVICES` or extend the rule.
- The exact JSON field names on the wire, as long as §5.2's shape holds.
- Whether `INTENT_DESCRIPTORS` keeps one array or splits by target.

## 9. Tests (what "done" means)

- Generator: the snapshot → descriptors for a fixture with an own namespace, a
  folded one, an excluded intent, a scope-less intent and a collision (which
  fails the build).
- `EmbeddedTransport`: with `intents: true`, a typed intent posts `api:call`
  with `intent`; without it, `api:run-intent` / `api:service-intent`; the reply
  maps through `intentAck`; a held call times out.
- `HostTransport`: a `window` app intent opens the `/-i/` URL; `embedded-only`
  is skipped; `embedded-served` answers 501.
- `FrameServer`: every refusal in §5.5's order; the gate gets the bridge's
  scope; no `intents` option → 501 and no `intents` key in `readyInfo`.
- valusocial-web `FrameCalls.test.js`: `readyInfo` carries `intents: true`; an
  app intent over `api:call` runs `application.run`; a refused one never does.
- E2E, by the recipe in the embedded-calls work (local Valu Social plus the
  sample): `valu.Chats.openChannel(...)` opens the chat inside Valu Social, and
  opens a Valu Social tab at the app's own address.

## 10. Answered (2026-11-06: yes to both; §4 decisions 5–6)

1. **Opening any app by id, and intents to other framed apps.** `api:run-intent`
   also carries:
   - the implicit `open` of any app: `ui:open`, but only 5 of 22 apps declare it;
   - intents to framed and Developer Portal apps: `apps:intent`, with ids that
     no manifest names.

   The catalogue cannot name either, so the frame server would refuse them
   (§5.5 step 1). Proposed: `valu.Apps.open(appId, { route? })` and
   `valu.Apps.send(appId, action, params)`, scoped at run time by
   `scopeOfAppIntent(..., { toFrame })` instead of by descriptor. The scanner
   reads a literal `appId` and flags a dynamic one.
2. **Routes.** `api:run-command` (`pushRoute` / `replaceRoute`) is a bridge
   message too. If it closes with the rest, this work adds `valu.route.push(path)`,
   `valu.route.replace(path)` and `valu.onRoute(handler)` over `api:call`.
   Valu Social's `on_route` push to the app is not a request, so it is
   unaffected.
