# Legacy Bridge Exceptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A superAdmin-kept list of apps that may keep Valu Social's old postMessage bridge, counting of who uses it, a second platform switch that closes the bridge to everyone else, and a Developer Portal tab to run all three.

**Architecture:** The backend (valu-guru-server) gets a `bridge-exceptions` module shaped like `privacy-audit`: one store (`vg_app_bridge_exceptions`, `vg_app_bridge_use`) with a memory twin for tests, ops under `valuguru.apps.bridge.*` dispatched from `socket.ts`, and the `declared` answer gains `bridge` / `bridgeMode`. The web (valusocial-web, on top of `fix/valu-api-native-only`) reads that answer in `FrameGates`, refuses old-bridge messages in `IFrameStore.#verdict` when the bridge is `closed` and the app is off the list, counts every message kind per frame, and adds a **Legacy bridge** tab to Developer Portal for `isSuperAdminRole`.

**Tech Stack:** TypeScript + Supabase + vitest (backend); React + custom stores + vitest/jsdom (web); valu-api `BridgeScopes` / `Permissions` for scopes and tiers.

**Spec:** `docs/superpowers/specs/2026-11-03-legacy-bridge-exceptions-design.md` (this repo, valu-api). Read it first; the plan argues from it.

## Global Constraints

- Branches: backend `feat/legacy-bridge-exceptions` (worktree `/Library/Git/valu-guru-latest/.claude/worktrees/legacy-bridge`, from main 1afec97); web `feat/legacy-bridge-tab` (worktree `/Library/Git/valusocial-web/.claude/worktrees/legacy-bridge`, **based on `fix/valu-api-native-only` 3eaee9c0d**, which must merge first). The spec lives on valu-api `feat/typed-app-intents`.
- Tests run **once, at the end of all tasks**, per Pavlo (2026-11-03): write each task's tests, do not run them until the final task. Backend: `npx vitest run src/bridge-exceptions src/host/permission-enforcement.test.ts src/privacy-audit/ops.test.ts`. Web: `npx vitest run --config vitest.worktree.config.mjs --maxWorkers=2 --minWorkers=1 Stores/IFrame Applications/DeveloperPortal` (the worktree needs the `node_modules` symlink and throwaway config the main checkout's memory describes).
- Keys: `dev:<devAppId>`, `ws:<workspaceId>/<slug>`, `manifest:<id>`; the server normalises `dev:` → `ws:` when `findProjectByDevApp` finds a project.
- Use buckets (exact strings): `run-intent`, `service-intent-other`, `service-intent-catalogue`, `pointer-run`, `run-console`, `run-command`, `call`. Old-bridge use = all except `call` and `service-intent-catalogue`.
- Modes: `app_permissions_mode` ∈ `off|report|enforce` (unchanged); new `bridge_mode` ∈ `open|closed`, seeded `open`; logs under keys `app_permissions_mode_log`, `bridge_mode_log` as jsonb arrays of `{at, by, byName, mode, reason}`.
- Every write op needs a non-empty `reason` (≤ 500 chars) and `requireSuperAdmin` (`perms.superAdmin` only).
- Refusal code for a closed bridge: `bridge_closed`, `scope: null`; the message names the valu-api function when the catalogue has one, else "This app is not on the legacy list."
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push.

## Review Focus

1. A frame flushes counts before `declared` answered, so the key is `dev:`; the server must fold it into the `ws:` row (Task 2 test "normalises dev: to ws:").
2. An expired list entry (`expires_at < now()`) must count as off the list in `declared` and show as expired, not vanish (Task 2 test "an expired entry is not legacy").
3. A legacy app under `enforce` must still be refused an undeclared scope (Task 6 test "on the list, still held to its declaration").
4. Counting must never block or fail a call: a rejected flush is one warn, the counter resets (Task 5 test "a failed flush is dropped").
5. The tab must never render for a network admin (`isAdmin` true, `isSuperAdminRole` false) (Task 8 test "hidden for a network admin").

---

### Task 1: Backend migration and store

**Files:**
- Create: `supabase/migrations/20261103120000_app_bridge_exceptions.sql`
- Create: `src/bridge-exceptions/store.ts`
- Test: `src/bridge-exceptions/store.test.ts`

**Interfaces:**
- Produces: `type BridgeException = {appKey: string; title: string; reason: string; addedBy: string; addedAt: string; expiresAt: string | null; log: BridgeLogEntry[]}`, `type BridgeLogEntry = {at: string; by: string; byName: string; change: string; reason: string}`, `type BridgeUseRow = {appKey: string; day: string; message: BridgeMessage; count: number}`, `type BridgeMessage = 'run-intent'|'service-intent-other'|'service-intent-catalogue'|'pointer-run'|'run-console'|'run-command'|'call'`, `const OLD_BRIDGE_MESSAGES: BridgeMessage[]` (all but `call`, `service-intent-catalogue`).
- Produces: `interface BridgeStore { get(appKey): Promise<BridgeException|null>; list(): Promise<BridgeException[]>; upsert(row: BridgeException): Promise<void>; countUse(appKey, message, count, day?: string): Promise<void>; useSince(days: number): Promise<Map<string, Partial<Record<BridgeMessage, number>>>>; lastUse(appKeys: string[]): Promise<Map<string, string>>; readSetting(key): Promise<unknown>; writeSetting(key, value): Promise<void> }`, `bridgeStore(): BridgeStore`, `setBridgeStoreForTest(store|null)`, `createMemoryBridgeStore(clock?): BridgeStore`, `isLegacy(row: BridgeException|null, now: Date): boolean`.

- [ ] **Step 1: Write the migration** `20261103120000_app_bridge_exceptions.sql`: the `vg_app_bridge_exceptions` table exactly as spec §5.1; `vg_app_bridge_use (app_key text, day date not null default current_date, message text check (message in (<the seven>)), count int not null default 0, primary key (app_key, day, message))`; RPC `vg_count_app_bridge_use(p_app_key text, p_message text, p_count int) returns void` as an upsert adding `p_count` (model: `vg_count_app_permission_miss` in `20261030100000`); `insert into vg_platform_settings (key, value) values ('bridge_mode', '"open"'::jsonb) on conflict do nothing`; RLS on both tables, service_role only (copy the privacy migration's grants). Seed rows: `manifest:valu_docs` ("playground, until the Explorer moves to api:call") and one row per iframe app id in `Application_Manifests_Merkos302.js` and `Application_Manifests_Metaverse.js` of valusocial-web develop (list them with `grep -n "^    id: '" ` next to `iframe: {`; reason "built-in before the rule, 2026-11"), `added_by 'migration'`. Put the id list in a comment at the top.

- [ ] **Step 2: Write the failing store test** `store.test.ts` against `createMemoryBridgeStore`:

```ts
it('upsert then get and list; countUse adds; useSince groups by key and message', async () => { … expect((await store.useSince(30)).get('ws:ws_1/notes')).toEqual({'run-intent': 3, 'call': 1}) })
it('lastUse is the newest day per key', …)
it('isLegacy: no row → false; row without expiry → true; expired → false; future expiry → true', …)
```

- [ ] **Step 3: Implement `store.ts`** following `src/privacy-audit/store.ts` (a Supabase store + `createMemoryBridgeStore` + `setBridgeStoreForTest`). `useSince(days)` reads rows with `day >= current_date - days`; `lastUse` is `max(day)` per key; settings read/write the `vg_platform_settings` row by key.

- [ ] **Step 4: Commit** `feat(bridge): the legacy bridge list and use counters — tables, store, seed`.

### Task 2: Backend ops, superAdmin gate, declared/bridge mode

**Files:**
- Create: `src/bridge-exceptions/ops.ts`
- Modify: `src/valuguru/socket.ts` (dispatch, ~line 244 beside `isPrivacyOp`; the `declared` case ~line 348)
- Modify: `src/host/permission-enforcement.ts` (`declarationFor` gains `bridge`, `bridgeMode`; `currentMode` sibling `currentBridgeMode`)
- Modify: `src/privacy-audit/ops.ts:136-140` (`requireAdmin` → `superAdmin` only) and `src/valuguru/developer-permission.ts` (export `requireSuperAdmin(userId)` if none exists there; `src/mcp/catalogue-routes.ts:57-68` has the REST version to mirror)
- Test: `src/bridge-exceptions/ops.test.ts`, extend `src/host/permission-enforcement.test.ts`, `src/privacy-audit/ops.test.ts`

**Interfaces:**
- Consumes: Task 1's store and types; `createEnforcement` deps (`findProjectByDevApp`).
- Produces ops: `valuguru.apps.bridge.list {}` → `{entries: Array<BridgeException & {addedByName: string; lastUse: string|null; migrated: boolean}>, mode: 'open'|'closed', modeLog: BridgeLogEntry[]}`; `valuguru.apps.bridge.set {appKey, title?, reason, expiresAt?}` → `{entry}`; `valuguru.apps.bridge.remove {appKey, reason}` → `{entry}` (sets `expiresAt` = now, logs "removed"); `valuguru.apps.bridge.candidates {days?: number}` → `{candidates: Array<{appKey, title: string|null, use: Partial<Record<BridgeMessage, number>>, lastUse: string}>}`; `valuguru.apps.bridge.use {appKey, message, count}` → `{ok: true}` (no admin, any user); `valuguru.apps.bridge.setMode {mode, reason}` and `valuguru.apps.permissions.setMode {mode, reason}` → `{mode, modeLog}`. `declared` answer gains `bridge: 'legacy'|'current'`, `bridgeMode: 'open'|'closed'`, and accepts `manifestId` (key `manifest:<id>`, no project lookup).
- Produces: `BridgeOpError(code, message)` mirroring `PrivacyOpError`; `isBridgeOp(op)`, `handleBridgeOp(op, userId, params)`, `__setBridgeOpsDepsForTest`.

- [ ] **Step 1: Write the failing ops tests** (harness as `privacy-audit/ops.test.ts`: memory store, deps seam with `isSuperAdmin: u => u === SUPER`, `isNetworkAdmin`):

```ts
it('set requires superAdmin: a network admin is forbidden', …)   // code 'forbidden'
it('set needs a reason; writes the row and one log line with byName', …)
it('remove keeps the row, sets expiresAt, logs "removed"', …)
it('normalises dev: to ws: when a project exists, on use and set', …)   // findProjectByDevApp('app_1') → ws_1/notes
it('candidates: keys with old-bridge use in N days not on the list; a key with only call/service-intent-catalogue is absent', …)
it('list marks migrated when the last 30 days hold only call/service-intent-catalogue', …)
it('setMode writes bridge_mode and appends to bridge_mode_log; permissions.setMode writes app_permissions_mode', …)
it('use accepts any user, rejects an unknown message', …)
```

- [ ] **Step 2: Write the failing enforcement tests** in `permission-enforcement.test.ts`:

```ts
it('declarationFor answers bridge: legacy for a listed key and current otherwise, by either key form', …)
it('an expired entry is not legacy', …)
it('manifestId names a built-in app: source none, bridge from manifest:<id>', …)
it('bridgeMode is read from the setting, cached a minute, open when the row is missing', …)
```

- [ ] **Step 3: Write the failing privacy test** in `privacy-audit/ops.test.ts`: `it('setMode is refused to a user with admin only (network admin)', …)` — the harness's `isPlatformAdmin` becomes `isSuperAdmin`.

- [ ] **Step 4: Implement `requireSuperAdmin`**, switch `privacy-audit/ops.ts` `requireAdmin` to it (rename the deps field to `isSuperAdmin`), implement `ops.ts`, extend `declarationFor` (deps gain `bridgeEntry(appKey)`, `readBridgeMode()`), and dispatch in `socket.ts` (`isBridgeOp` beside `isPrivacyOp`; the two `setMode` ops route through `handleBridgeOp` too; `declared` passes `manifestId`).

- [ ] **Step 5: Commit** `feat(bridge): list, candidates and mode ops under superAdmin; declared answers the app's bridge standing`.

### Task 3: Web — FrameGates reads the standing and the bridge mode

**Files:**
- Modify: `src/Stores/IFrame/FrameGates.js` (`#build` ~line 200: keep `bridge`/`bridgeMode` from the `declared` answer; new public `standing(manifest)`; `manifestId` for apps without `devId`)
- Test: `src/Stores/IFrame/FrameGates.test.js`

**Interfaces:**
- Produces: `async standing(manifest) → {bridge: 'legacy'|'current', bridgeMode: 'open'|'closed', appKey: string}`; for a manifest with no `devId` it asks `declared {manifestId: manifest.id}`; when Guru is unreachable: `{bridge: 'current', bridgeMode: 'open', appKey}` (fail open; closing never happens on a guess). Cached with the gate for the page life (same `#gates` map, keyed `manifest:<id>` for built-in apps).
- Produces: `appKeyOf(manifest, declaredAnswer)` → `ws:<appId>` | `dev:<devId>` | `manifest:<id>` (exported helper).

- [ ] **Step 1: Write the failing tests**: `standing is legacy/closed from the declared answer`, `a built-in app asks by manifestId and keys manifest:<id>`, `Guru down: current/open`, `appKeyOf prefers ws: over dev:`.
- [ ] **Step 2: Implement** in `FrameGates.js`; a built-in app now also calls `declared` once (it did not before), so `#build` must tolerate `source: 'none'` with no scopes and never flip `#knownOn` for it.
- [ ] **Step 3: Commit** `feat(frames): FrameGates knows an app's bridge standing and the bridge mode`.

### Task 4: Web — refuse the old bridge when closed

**Files:**
- Modify: `src/Stores/IFrame/IFrameStore.js` (`#verdict` ~line 178; `api:run-command` case ~line 317; `api:create-pointer` ~line 352)
- Test: `src/Stores/IFrame/IFrameStore.internal.test.js` (new describe `bridge closed`)

**Interfaces:**
- Consumes: Task 3's `standing(manifest)`; valu-api's `INTENT_DESCRIPTORS` via `this.#gates.scopes()` gaining `isCatalogueIntent(service, action)` (add to `loadGateModules`: import `src/services/catalog.generated.js`'s `findDescriptor`, plus the app-intent descriptors once typed-app-intents lands — until then `findDescriptor` alone).
- Produces: `#verdict(gated, scopeOf, intent, kind)` where `kind` ∈ the seven buckets; after internal → forbidden → gate it asks `standing`, and when `bridgeMode === 'closed' && bridge === 'current' && kind ∉ {call, service-intent-catalogue}` returns `{ok: false, code: 'bridge_closed', scope: null, replacement?: string}`; `bridgeRefusal` renders `replacement` as "Use valu.<Service>.<fn>() instead" else "This app is not on the legacy list."

- [ ] **Step 1: Write the failing tests** (harness from the existing file; stub `standing`):

```js
test('closed, off the list: run-intent, pointer run, console, run-command and a non-catalogue service-intent are refused bridge_closed; api:call, api:ready and a catalogue service-intent still run')
test('closed, on the list: everything the fix branch allows runs')
test('on the list, still held to its declaration under enforce')   // gated manifest, undeclared scope → permission_not_declared, not bridge_closed
test('open: nothing new is refused')
test('api:create-pointer answers bridge_closed and keeps no pointer')
test('the refusal names the typed function when the catalogue has one')   // Commerce.get-cart → "valu.Commerce.getCart()"
```

- [ ] **Step 2: Implement**; `api:run-command` gets a verdict for the first time (kind `run-command`, scope null, never gated).
- [ ] **Step 3: Commit** `feat(frames): a closed bridge refuses apps off the legacy list`.

### Task 5: Web — count every message kind

**Files:**
- Create: `src/Stores/IFrame/BridgeUseCounter.js`
- Modify: `src/Stores/IFrame/IFrameStore.js` (count in `#processApplicationRequest` per case; flush on `onDestroy`), `src/Stores/IFrame/FrameCalls.js` (`handle` counts `call`)
- Test: `src/Stores/IFrame/BridgeUseCounter.test.js`

**Interfaces:**
- Produces: `class BridgeUseCounter { constructor({send: (appKey, message, count) => Promise<void>, intervalMs = 60000, log}); count(appKey, message); flush(): Promise<void>; stop() }`. `send` is `guru.request('valuguru.apps.bridge.use', {...})`. Counting runs before the verdict, so refused calls count too.

- [ ] **Step 1: Write the failing tests**: `counts and flushes one request per (key, message) after the interval`, `flush on stop`, `a failed flush is dropped: one warn, counters reset, next flush works`, `nothing is sent when nothing was counted`.
- [ ] **Step 2: Implement**; one counter per root store (`FrameGates.for`-style `WeakMap`), fake timers in tests.
- [ ] **Step 3: Commit** `feat(frames): count old-bridge and api:call use per app, flushed once a minute`.

### Task 6: Web — Portal store and API for the tab

**Files:**
- Modify: `src/Applications/DeveloperPortal/Services/DeveloperPortalApi.js` (new methods over `services.AiGuru.request`: `bridgeList()`, `bridgeSet(params)`, `bridgeRemove(params)`, `bridgeCandidates({days})`, `bridgeSetMode(params)`, `permissionsSetMode(params)`)
- Modify: `src/Applications/DeveloperPortal/DeveloperPortalStore.js` (state `bridge: {entries, candidates, mode, modeLog, permissionsMode, permissionsModeLog, loading, isSuperAdmin}`; `loadLegacyBridge()`, `setBridgeEntry`, `removeBridgeEntry`, `setBridgeMode`, `setPermissionsMode`; event `LEGACY_BRIDGE_UPDATED`)
- Test: `src/Applications/DeveloperPortal/DeveloperPortalStore.legacyBridge.test.js`

**Interfaces:**
- Consumes: Task 2's op shapes.
- Produces: the store methods above; `loadLegacyBridge` mirrors `loadReviewQueue` (a first `forbidden` records `isSuperAdmin: false`, a later failure keeps rows).

- [ ] **Step 1: Write the failing tests**: `loadLegacyBridge fills entries, candidates and both modes`, `a forbidden answer records isSuperAdmin false and no error`, `setBridgeEntry reloads`, `setBridgeMode with a reason calls the op and reloads`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Commit** `feat(portal): the legacy bridge list, candidates and modes in the store`.

### Task 7: Web — the Legacy bridge tab

**Files:**
- Create: `src/Applications/DeveloperPortal/Components/LegacyBridge/LegacyBridge.jsx`, `LegacyBridge.scss`, `ModeSwitch.jsx`, `ReasonDialog.jsx` (the reason form from `PrivacyAdminControls.jsx:105-140`, generalised: a `TextArea3` + submit, `onSubmit(reason)`)
- Modify: `src/Applications/DeveloperPortal/DeveloperPortal.jsx` (`LIST_TAB.LEGACY = "legacy"`; `showsTabs` also when `isSuperAdminRole`; tab label "Legacy bridge"; render `<LegacyBridge>` for that tab; load on open like line 208)
- Test: `src/Applications/DeveloperPortal/Components/LegacyBridge/LegacyBridge.test.jsx`, extend `DeveloperPortal.*.test.jsx` where the tab list is asserted (`DeveloperPortal.openVersion.test.jsx:33` mocks `ReviewQueue`; mock `LegacyBridge` the same way)

**Interfaces:**
- Consumes: Task 6's store state and methods; `applicationStore.userRoles.isSuperAdminRole`.
- Produces: `<LegacyBridge store={devPortalStore} applicationStore={…} />` with three blocks in spec §5.5 order: Modes (two `SegmentedControl3`s, each change opens `ReasonDialog`), Legacy apps (table: title, key, reason, who/when, expiry (editable → `ReasonDialog`), last use, `migrated` pill "Migrated — can be removed", Remove → `ReasonDialog`), Candidates (rows with per-bucket counts, Add → `ReasonDialog` with a title field). Empty states: "No candidates yet — counting starts when this build is deployed." Under both switches: "A change reaches clients within a minute."

- [ ] **Step 1: Write the failing tests**: `renders the three blocks from store state`, `a migrated row wears the pill`, `Remove asks for a reason and calls removeBridgeEntry`, `the mode switch asks for a reason before setBridgeMode`, `hidden for a network admin` (in the Portal test: `isAdmin: true, isSuperAdminRole: false` → no "Legacy bridge" tab), `shown for a superAdmin`.
- [ ] **Step 2: Implement**, following `ReviewQueue.jsx`'s component imports (`SystemPill3`, `ListGroupHeader3`, `SecondaryButton3`) and `Permissions.scss` tokens.
- [ ] **Step 3: Commit** `feat(portal): Legacy bridge tab — list, candidates and both mode switches, superAdmin only`.

### Task 8: Run the tests once, fix, final commits

- [ ] **Step 1: Backend** `cd /Library/Git/valu-guru-latest/.claude/worktrees/legacy-bridge && npx vitest run src/bridge-exceptions src/host/permission-enforcement.test.ts src/privacy-audit/ops.test.ts` → all pass; `npx tsc --noEmit` clean.
- [ ] **Step 2: Web** set up the throwaway config (symlink `node_modules`, `assets/unity`; `vitest.worktree.config.mjs` with its own `cacheDir`), then `npx vitest run --config vitest.worktree.config.mjs --maxWorkers=2 --minWorkers=1 Stores/IFrame Applications/DeveloperPortal` → all pass; lint the changed files (`../../../node_modules/.bin/eslint <files>`), only develop's pre-existing errors remain.
- [ ] **Step 3: Fix** whatever failed, amend into the owning task's commit (`git commit --fixup` + `git rebase -i --autosquash` is not available; a plain follow-up commit per repo is fine).
- [ ] **Step 4: Report** per repo: branch, commits, what the suite covered, and that the full suites run before merge (not now).
