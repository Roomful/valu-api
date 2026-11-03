# The legacy bridge list, and the road to `enforce` — design

Status: draft for Pavlo's review, 2026-11-03. Builds on
`2026-10-28-app-permissions-design.md` (the declared-permissions rule, the
gate modes), `2026-11-03-typed-app-intents-design.md` (the functions that
replace the bridge) and the valusocial-web branch `fix/valu-api-native-only`
(the refusals that hold in every mode).

Four repositories: valu-guru-server (the list, the counters, the mode),
valusocial-web (the gate, the counting, the Portal tab), valu-api (nothing
new here beyond the typed-app-intents work), valu-docs (the Explorer).

## 1. Why

Valu Social frames apps in its dock and lets them drive it over postMessage: the
**old bridge** (`api:run-intent`, `api:service-intent`, API pointers
`api:create-pointer` + `api:run`, `api:run-console`, `api:run-command`) and
the **new path** (`api:call`, answered by valu-api's frame server). The permission
gate (`app_permissions_mode`, seeded `off` on 2026-10-29) checks only Developer
Portal apps, and only once the mode is `report` or `enforce`. About thirty
built-in iframe apps in the manifests (Merkos302 sites, ckids.org, vercel
previews, Valu Docs) are never checked.

Pavlo's rule (2026-11-02): **nothing outside valusocial-web may change its
behaviour.** New apps use valu-api only. Apps that already rely on the old
bridge keep working, by name, on a list an administrator keeps. Everyone else
is refused once the mode is `enforce`.

Today nothing records who uses the old bridge, so the list cannot be written
yet. The first thing to build is the counting.

## 2. Goals

1. A **list of legacy apps** in the Valu Guru database, managed from Developer
   Portal by a `superAdmin`, with a reason, an audit log and an optional expiry.
2. **Counting** of old-bridge use per app per day, from every frame (built-in
   apps included), so the list is seeded from facts and shrinks as apps migrate.
3. **Mode switches** with a log, in the same tab, instead of hand-written SQL:
   the existing permissions mode, and a new, separate bridge mode.
4. With the bridge `closed`, an app **off the list** keeps only: `api:ready`,
   `api:call`, `api:service-intent` to intents in valu-api's catalogue (typed
   intents, checked by scope as today) and inbound `api:trigger`. Everything
   else on the old bridge is refused. An app **on the list** keeps the old
   bridge as today, minus what `fix/valu-api-native-only` refuses to every frame.
5. Legacy stays legacy: the list never widens what any app may do. Internal API
   functions, internal application intents and forbidden writes are refused to
   a legacy app too.

## 3. Non-goals

- Closing the bridge for anyone before the list exists and `report` has run.
- Native mobile attestation (App Attest / Play Integrity) and the `iframe_2048`
  same-origin frame. Decided later, 2026-11-02.
- Typing the application intents, routes and `valu.Apps.open/send` in valu-api:
  `2026-11-03-typed-app-intents-design.md`. This design depends on it (§7 step 6)
  and does not repeat it.
- Changing what the native shells (ValuSocial-iOS, -Android) may call. They are
  not frames; nothing here touches them.
- Third-party iframe apps' own security (an XSS on ckids.org). The list makes
  them visible and removable; it does not make them safe.

## 4. Decisions made (Pavlo, 2026-11-02 and 11-03)

1. Close the bridge only for apps **off the legacy list**, never for all.
2. Keep `api:ready`, `api:call`, catalogue `api:service-intent`, `api:trigger`
   open to every app; the rest of the old bridge closes for apps off the list.
3. The list is managed by **`superAdmin`** only (not every platform admin).
4. Built-in manifest apps go **in the database** too (key `manifest:<id>`,
   seeded by a migration), not a flag in code, so one tab shows everything.
5. Expiry on a list entry is **optional**; the tab shows each app's last use.
6. `api:run-command` (`pushRoute` / `replaceRoute`) closes too; `valu.route.push /
   replace` and `valu.onRoute` land in the typed-app-intents work. `valu.Apps.open`
   and `valu.Apps.send` stay.
7. Of the 20 service intents valu-api does not type: `AiGuru.open / close /
   get-applications / has-application / is-application-loaded` and
   `Logging.get-logs` are **legacy-only**; the other `AiGuru.*` (histories,
   knowledge base) and `RoomPoints.list / save / delete-room-point` get typed
   before `enforce`.
8. **Valu Docs' Explorer migrates** to `createValuApp` + `api:call` before
   `enforce`. Until then Valu Docs is on the list with reason "playground".
9. Pavlo renews valu-api's `DOCS_DISPATCH_TOKEN` so the docs sync works again.
10. Full test suites run before a merge into develop / main, not per push.

## 5. Design

### 5.1 The list: `vg_app_bridge_exceptions` (valu-guru-server)

Modelled on `vg_app_privacy_apps` (migration `20261029140000`): one row per app,
service-role only, a log the ops append to.

```sql
create table vg_app_bridge_exceptions (
  app_key     text primary key,   -- 'dev:<devAppId>' | 'ws:<workspaceId>/<slug>' | 'manifest:<id>'
  title       text not null,      -- what the tab shows; the manifest title or the portal app name
  reason      text not null,
  added_by    text not null,      -- user id
  added_at    timestamptz not null default now(),
  expires_at  timestamptz,        -- null: open-ended
  log         jsonb not null default '[]'::jsonb,  -- [{at, by, byName, change, reason}]
  updated_at  timestamptz not null default now()
);
```

`app_key` uses the same three shapes the misses table already uses (`dev:`,
`ws/slug` as `ws:`), plus `manifest:` for apps that exist only in
valusocial-web's manifests. The migration that creates the table **seeds every
built-in iframe app** from the current manifests (`manifest:valu_docs` with
reason "playground, until the Explorer moves to api:call", the Merkos302 and
Metaverse iframe apps with reason "built-in before the rule, 2026-11"). The
seed list is written by hand into the migration from
`Application_Manifests_*.js`; the builder lists the ids in the migration's
comment. An expired row (`expires_at < now()`) is not on the list; it is kept
for the log and shown as expired.

**Keys are normalised on the server.** The client may report either
`dev:<devAppId>` or `ws:<workspaceId>/<slug>` for the same Portal app (it knows
the `ws:` form only after the `declared` answer). The `use` and `set` ops
resolve a `dev:` key to `ws:` when a project exists (`findProjectByDevApp`),
else keep `dev:`; `declared` looks up both forms. So an app has one row and one
counter, whichever key a client sent. (Builder-check finding; my call.)

Ops (dispatched beside `valuguru.apps.privacy.*`). **Gate: a new
`requireSuperAdmin`**, `perms.superAdmin` only. The privacy ops' `requireAdmin`
is `admin || superAdmin`, and `admin` is a *network* admin
(`network-admin.ts`), so reusing it would let a network admin switch the
platform's mode, against decision 3. The privacy ops are left as they are;
that is a separate question for Pavlo (§11).

- `valuguru.apps.bridge.list {}` → `{entries: [{appKey, title, reason, addedBy, addedByName, addedAt, expiresAt, log, lastUse}]}`. `lastUse` joins §5.2's counters (`max(day)` for the key).
- `valuguru.apps.bridge.set {appKey, title?, reason, expiresAt?}` → upsert, appends to `log`. `reason` required (like `privacy.setMode`).
- `valuguru.apps.bridge.remove {appKey, reason}` → sets `expires_at = now()` and logs "removed"; the row stays, so nothing is ever lost and a removed app can be re-added with its history. (My call: one table, no separate log table.)
- `valuguru.apps.bridge.candidates {days}` → the §5.2 keys seen in the last `days` that are not on the list, with their counts and titles. Default 30.

### 5.2 Counting old-bridge use

**Table** `vg_app_bridge_use (app_key text, day date, message text, count int, primary key (app_key, day, message))`, `message` one of `run-intent`, `service-intent-other`, `service-intent-catalogue`, `pointer-run`, `run-console`, `run-command`, `call`. The two `service-intent` buckets matter: a catalogue intent over `api:service-intent` is what an older valu-api SDK sends for its typed intents and stays open under `enforce`, so it must not count as "uses the old bridge". **Old-bridge use** = every bucket except `call` and `service-intent-catalogue`; "migrated" = only those two in the last 30 days. (Builder-check finding; my call.)

**Op** `valuguru.apps.bridge.use {appKey, message, count}` → RPC `vg_count_app_bridge_use` (an upsert that adds `count`, like `vg_count_app_permission_miss`). Counted only, the client's word; it decides nothing.

**Client** (valusocial-web `IFrameStore`): every framed app, gated or not, gets a per-store counter keyed by message kind; it flushes to the op every 60 s and on `onDestroy`, so a chatty app costs one socket message a minute, not one per call. The key is what `FrameGates` already computes: `ws:<appId>` when the declared answer named one, else `dev:<devId>`, else `manifest:<manifest.id>`. `api:call` is counted in `FrameCalls.handle`. Counting never blocks or refuses a call, and a failed flush is dropped (one warn).

### 5.3 The two modes: ops instead of SQL

`valuguru.apps.permissions.setMode {mode, reason}` and
`valuguru.apps.bridge.setMode {mode, reason}` (`requireSuperAdmin`): the first
writes `vg_platform_settings.app_permissions_mode` (off / report / enforce), the
second `bridge_mode` (open / closed; the migration seeds `open`). Each appends
`{at, by, byName, mode, reason}` to its own `*_log` key (jsonb array) in the
same table. The 60-second cache in `permission-enforcement.ts` applies to both,
so a switch takes up to a minute to reach every client, which the tab says.
`valuguru.apps.permissions.get` gains both modes and both logs for the tab;
`declared` gains `bridgeMode` beside `bridge`.

### 5.4 What the web refuses, by mode and list

`IFrameStore` learns the app's standing from one answer: `valuguru.apps.permissions.declared`
gains a field `bridge: 'legacy' | 'current'` (and accepts `manifestId` as a
third way to name an app, so built-in apps get an answer too). `FrameGates`
keeps it with the declaration.

**Two rules, two switches.** The declaration rule (`app_permissions_mode`,
off / report / enforce) says what a Developer Portal app may ask for, and it
applies on both paths, the host at the app's own address included; this design
does not change it. The bridge rule is a **second setting,
`bridge_mode`** (`open` / `closed`), in `vg_platform_settings` beside the first:
`closed` refuses the old bridge to apps off the list. They are switched
separately (§5.3, §5.5), so closing the bridge never starts refusing undeclared
scopes by itself, and vice versa. (Builder-check finding; my call. One
setting would have tied the two rollouts together.)

**The list never widens the declaration rule.** A listed Portal app is still
held to its `valu-permissions.json` under `enforce`, exactly as an unlisted one:
the standing is checked *after* `permit`, and only decides whether a
non-catalogue bridge message is refused as `bridge_closed`. Verdict order in
`IFrameStore.#verdict`: internal → forbidden write → declaration gate →
bridge standing.

| Message | Every mode, every app (`fix/valu-api-native-only`) | bridge `open` | bridge `closed`, on the list | bridge `closed`, off the list |
|---|---|---|---|---|
| `api:ready`, `api:trigger` (inbound), `api:new-intent` | — | runs | runs | runs |
| `api:call` | forbidden writes refused | runs (gate) | runs (gate) | runs (gate) |
| `api:service-intent` to a **catalogue** intent | forbidden writes refused | runs (gate) | runs (gate) | runs (gate) |
| `api:service-intent` to a **non-catalogue** intent | forbidden writes refused | runs (gate) | runs (gate) | **refused** `bridge_closed` |
| `api:run-intent` | internal intents refused | runs (gate) | runs (gate) | **refused** |
| `api:create-pointer` / `api:run` | internal functions refused | runs (gate) | runs (gate) | **refused** (create-pointer answers the refusal; a pointer never exists) |
| `api:run-console` | internal functions / intents refused | runs (gate) | runs (gate) | **refused** |
| `api:run-command` | — | runs | runs | **refused** |

"(gate)" = the declaration rule for a Portal app, whatever `app_permissions_mode`
says; a built-in app has no declaration and the gate passes it.

"Catalogue intent" = valu-api's `INTENT_DESCRIPTORS` plus the app-intent
descriptors of the typed-app-intents design; `FrameGates.scopes()` already loads
the modules that know them. The refusal is `bridgeRefusal({code: 'bridge_closed',
scope: null})` with a message that names the valu-api function to use when the
catalogue has one for that intent, and the Legacy list otherwise. `report` mode
counts (§5.2) and refuses nothing new: that is the whole point of running it
first.

### 5.5 The Developer Portal tab

A third tab, **Legacy bridge**, beside My apps and Review queue, shown when
`applicationStore.userRoles.isSuperAdminRole` (which `isPlatformAdminRole`
already equals in the web). Three blocks, top to bottom:

1. **Modes**: two switches side by side, each asking for a reason (the reason
   dialog `PrivacyAdminControls` uses) and showing its last five log lines:
   *Permissions* `off / report / enforce` and *Old bridge* `open / closed`.
   One sentence under both: "A change reaches clients within a minute".
2. **Legacy apps**: the list, one row per entry: title, key, reason, who/when,
   expiry (editable), last use (from the counters, and *which* messages: a
   row whose last 30 days show only `call` is marked "migrated — can be
   removed"), Remove (reason required).
3. **Candidates**: apps seen on the old bridge in the last 30 days that are not
   on the list, with counts per message kind and an **Add** button (reason
   required). Empty under `off` until counting ships; the block says so.

Read-only for everyone else: the tab is not rendered. The store side mirrors
`loadReviewQueue`: one load on tab open, the server's refusal recorded as
"not an admin", never as an error.

### 5.6 What legacy does not get

A legacy app is refused the same three things as every frame, in every mode:
`internal` API functions, `internal: true` application intents and forbidden
writes (`veruswallet:write`, `cbac:write`, `developer:write`). The list is an
exception to the *bridge closing*, not to those.

## 6. Mobile: unchanged, and why

The native shells call `APIBridge` directly through `IOSApiBridge` and
`AndroidApiBridge`; they are not frames, so no mode, list or refusal here
touches them. They use: `app.run`, `overriderAppLoading`, `overridePersonaSwitch`,
`blockExternalLinks`, `navigate`, `crypto.setSeed`, `network.startNewNetworkSession`,
`auth.logout`, and subscriptions to seven events. All of these are either
`internal` (kept from frames by `fix/valu-api-native-only`) or ordinary.

The web cannot tell Valu's own native app from any app that embeds the page in
a WebView (the host controls the page). The boundary is the server: attested
native sign-in. Decided later. The one change now: `IOSApiBridge` detects the
shell by its own `webkit.messageHandlers.iosValu`, not by any `messageHandlers`
(every in-app browser has those). My call; small, in the fix branch's follow-up.

## 7. Rollout

1. Merge `fix/valu-api-native-only` (rebased on develop) and deploy on all four
   brands. Independent of everything below.
2. Ship §5.1–5.3 and §5.5 (backend migration + ops; web counting + tab) with the
   mode still `off`. The tab shows candidates filling up.
3. Switch permissions to `report` (from the tab). Run 2–4 weeks across every
   brand; the bridge stays `open`, so this only counts.
4. Seed the list from the candidates (the migration already holds the built-in
   apps); tell the owners of Portal apps on it.
5. Decision 7's typing, routes, `valu.Apps.*` (typed-app-intents work) and the
   Valu Docs Explorer migration (§8) land and deploy.
6. Switch the bridge to `closed`. Criterion: the last 7 days show no old-bridge
   message (§5.2's definition) from any app off the list, or each one was
   reviewed. Rollback: `open`, from the tab.
7. Separately, when the misses say so: switch permissions to `enforce`.
   Criterion: no undeclared scope from any Portal app in 7 days, or each one
   reviewed. Rollback: `report`. The two switches are independent; either may
   go first.

## 8. Valu Docs

- Now: `manifest:valu_docs` on the list, reason "playground".
- Before `enforce`: the Explorer's `valuBridge.mjs` (`api:run-intent`,
  `api:service-intent`, pointers) becomes `createValuApp` + `api:call`; the
  Intents and Service Intents pages become one Functions page generated from
  valu-api's catalogue (typed-app-intents §7). Session Overview and the REST
  APIs page keep working because `Developer.list-application-apis` is a read.
- Text: `valu-api.md` stops teaching `sendIntent` / `callService` once the
  typed app intents exist; a short "what embedded apps may not do" section lists
  the old bridge messages and points to the Functions page. Pages get real
  titles so `llms.txt` stops saying "Untitled".

## 9. Left to the builder

- The exact seed list for the migration (read the manifests at build time).
- The flush interval and the counter's in-memory shape.
- Whether `candidates` is a view or a query in the op.
- The tab's markup, following the Review queue's components and the Valu API
  tab's table.
- How `bridge_closed` names the replacement function (a map from intent key to
  function name is in the catalogue descriptors already).

## 10. Tests (what "done" means)

- Backend: the migration seeds the built-in apps; `set`/`remove`/`candidates`
  round-trip with the log; `use` adds counts; `setMode` is refused to a
  non-superAdmin and logs for one.
- Backend: `requireSuperAdmin` refuses a user with `admin` only; `use` and
  `set` normalise `dev:` to `ws:` when a project exists, and `declared` finds
  the row by either key.
- Web, `IFrameStore`: with the bridge `closed` an app off the list is refused
  each old-bridge message with `bridge_closed`, and still runs `api:call`, a
  catalogue `api:service-intent`, `api:ready`; an app on the list runs
  everything the fix branch allows AND is still held to its declaration under
  `enforce`; bridge `open` refuses nothing new and counts; an expired entry
  counts as off the list; counting never blocks a call; a catalogue
  `api:service-intent` counts in its own bucket, not as old-bridge use.
- Web, Portal: the tab renders only for `isSuperAdminRole`; both mode switches
  and Add/Remove require a reason; a row with only `call` /
  `service-intent-catalogue` is marked migrated.
- Nothing in the native bridges changes: their existing tests pass unchanged.

## 11. Open: Pavlo's answers needed

1. The privacy ops (`valuguru.apps.privacy.setMode`, `recordReview`, …) are
   gated by `admin || superAdmin`, so a network admin can change any app's
   privacy mode platform-wide. Tighten them to `superAdmin` in this work, or
   leave them? (This design's own ops use `requireSuperAdmin` either way.)
