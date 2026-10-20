# valu-api Host M8–M10 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the core (M0–M7), make the same valu-api work inside Valu Social through the host (M8), rail Claude Code and every developer doc to valu-api for new projects (M9), and let a dedicated app run checkout and the seller dialogs in popups on a Valu origin (M10).

**Architecture:** M8 keeps Valu Social as the UI provider and makes it hand the nested host iframe a one-time token plus the app's identity directly (never through the app page); the valu-api client routes data to the host and UI to the bridge. M9 adds a template repo, a second skill pool selected by a `provisioning.template` stamp, a publish guard for template projects, a generated function reference with a skills-vs-package test, and rewrites the Developer Portal articles and the intent docs. M10 adds a standalone "action popup" shell in valusocial-web that signs in with a token obtained from the host and draws the Cart or a dialog for one pending action.

**Tech Stack:** as the core plan, plus GitHub template repositories (`/generate`), npm publish of `@arkeytyp/valu-api` 2.x.

**Spec:** `docs/superpowers/specs/2026-10-20-valu-api-host-core-design.md` §5 (M8–M10 rows), §4.11; this plan refines those rows with what the 2026-10-20 recon of the three repos found. Prerequisite: the core plan `2026-10-20-valu-api-host-core.md` is done through M7.

## Global Constraints

- All constraints of the core plan apply (no runtime deps in valu-api, credentials never cross the app page, envelopes, protocol version, commit trailer, worktrees, no pushes to `develop`/`main` without Pavlo).
- **Old projects and old apps are untouched** (Pavlo, 2026-10-20): every M9 change is keyed on `provisioning.template.id === 'valu-api'`; the existing skill rows, the App Builder loadout and old projects' `CLAUDE.md` wording keep their text.
- The one-time token is a **whole session**, not per app (`getOneTimeAuthToken` takes no app). It is posted only to a window on the host origin, with that `targetOrigin`, never `'*'`.
- Valu Social's intent dispatch keeps serving raw-bridge apps exactly as today; grant checks in Valu Social apply only to frames that attached a host (`api:host-attach`).
- Protocol bump: M8 adds messages but no breaking shape, so `protocol` stays `1`; a client built for the core still works against an M8 host in dedicated mode.
- Skills written by migrations start at `211_…` (`supabase/legacy-migrations.json` `throughVersion: 210`); the UI cap of 20 000 characters applies to the generated reference as well, because skills are also edited in the UI.
- valu-api is consumed by new projects from **npm** (`@arkeytyp/valu-api@^2`), because the project worker has no GitHub or SSH credentials; the rebuild step runs with `NODE_ENV=production`, so the package must be in `dependencies`.

## Review Focus

1. A page on an allowed app origin that is framed by a **non-Valu top-level page** must get neither a token nor data in embedded mode (the embed message comes only from a brand origin, and the nested chain must end at a Valu Social origin). Test in Task 2.
2. A raw-bridge app (no `api:host-attach`) must see **no new consent dialogs** and no behaviour change in Valu Social. Test in Task 4.
3. The publish guard must **ignore `node_modules` and `dist`**, where valu-api's own transport legitimately contains `api:ready`, and must refuse only template projects. Test in Task 12.
4. A skill may name only functions and intents that the pinned valu-api has; a skill naming `valu.Users.getUser()` (which does not exist) must fail the test. Test in Task 11.
5. The action popup must refuse a pending action whose **app id in the URL** does not match the app bound in the host; the host, not the URL, is the source of truth. Test in Task 17.

---

## M8 — Embedded mode through the host

### Design refinements (from the recon)

- **Who hands the token.** Valu Social's `IFrameStore` can reach the app frame's nested windows as `iframe.contentWindow.frames[i]` and post to them with `targetOrigin = hostOrigin`; the app page cannot read that message. The app's valu-api client tells the bridge when its host iframe exists with a new bridge message `api:host-attach {hostOrigin}` (no secret). The bridge mints a one-time token (the mint moves from `AiGuruStore` into `ApplicationService` as a reusable method) and posts `{type:'valu-host:embed', token, master, app:{address, slug, devAppId, homeNetworkId:null}, networkId}` to every nested frame. Identity therefore comes from Valu Social's registry (`manifest.id`, which may be `slug--dev` / `--review`), **not** from the resolve endpoint, so legacy `web.texpo.io` frames and test builds work.
- **Host nesting rule in embedded mode.** The host accepts `parent !== top` only while waiting for a `valu-host:embed` from a brand origin; `location.ancestorOrigins`, where present, must end at a brand origin. `frame-ancestors` gains the four brand origins and `https://web.texpo.io`.
- **Routing in the client.** Embedded mode uses both transports: `callService` and the host-served intents go to the host; everything else (`api:run-intent`, pointers, `api:run-command`, UI intents such as `Commerce.checkout`, `open-cart`, the seller dialogs, pickers) goes to the parent bridge as today. Commerce events come from the host only.
- **Consent inside Valu Social.** The framed app's sandbox has no `allow-popups`, so the client asks the bridge: `api:service-intent {applicationId:'Application', action:'request-consent', params:{scopes}}`. Valu Social draws `ConsentModal` anchored to the app pane (`ConsentGate.ask`), writes the grant over its Guru socket with the stamped sender id, and answers `{approved}`. The client retries with `api:call {..., afterConsent:true}`, which makes the host re-read grants before checking.
- **Valu Social's own checks.** For frames that attached a host, Valu Social checks grants before running a UI intent whose manifest `permissions` is non-empty (M8 fills `permissions` for `Commerce.checkout` → `commerce:write`, the nine seller dialogs → `commerce:sell`, `rate-product` → `commerce:write`, `DataProvider.pick-*` → `resources:read`); the `app.run` pointer path gets the sender stamped from the pointer's owner frame (closes the unstamped gap for every app, a bug fix).
- **Grants freshness.** The host's `GrantsStore` caches for 60 s (not the page's life) and re-reads on `afterConsent`, on reconnect, and on `host:grants-changed`; the "Connected apps" page revokes through `valuguru.apps.grants.revoke`, so a revoked app loses access within a minute or on its next consent-tier call after reconnect.
- **Theme.** No server knows the theme (`UXStore.colorScheme` is a per-origin `localStorage` key). `valu.theme` is client-only: embedded from the `api:color-scheme` push (accepted from the bound parent) with the `ux` pointer's `colorScheme()` as the initial value; dedicated from `prefers-color-scheme`. This replaces the spec's "via Valu Guru" wording.

### Task 1: Host accepts an embed message and relaxes nesting (valu-api)

**Files:**
- Modify: `src/host/HostBridge.js`, `src/host/protocol.js`, `src/host/Host.js`
- Test: `test/host/host-bridge-embed.test.js`

**Interfaces:**
- Config gains `brandOrigins: ['https://live.valuverse.io','https://valu-social.com','https://chabaduniverse.com','https://texpo.io']` and `legacyAppOrigins: ['https://web.texpo.io']`; dev adds `http://localhost:3005`.
- `HostBridge.start()` no longer refuses `parent !== top`; instead `host:hello` from a nested parent puts the bridge in state `awaiting-embed` and starts a 10 s timer (`host:error {code:'embed_timeout'}` to the parent on expiry). A message `{type:'valu-host:embed', token, master, app, networkId}` is accepted only when `event.origin ∈ brandOrigins` and `event.source !== win.parent`; it binds `app` (address = `app.address`, stamped id = `app.slug`), redeems the token through `auth.redeem(token, { homeNetworkId: networkId, switch: false })` (no network switch in embedded mode), connects, and answers `api:ready` with `host.mode = 'embedded'`. The resolver is not consulted in this path. If `location.ancestorOrigins` exists and its last entry is not in `brandOrigins`, the embed is refused with `host:error {code:'bad_ancestor'}`.
- `HostAuth.redeem` gains the `switch` flag (default `true`).

- [ ] **Step 1: Write the failing tests**: `nested hello enters awaiting-embed and answers api:ready mode embedded after a brand-origin embed`; `embed from the app origin is ignored` (Review Focus 1); `embed when ancestorOrigins ends at a non-brand origin is refused bad_ancestor`; `embed_timeout after 10 s with no embed` (fake timers); `dedicated hello from a top-level parent still resolves through the resolver`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(host): embedded mode via valu-host:embed from a brand origin`.

### Task 2: Client routes data to the host and UI to the bridge in embedded mode (valu-api)

**Files:**
- Modify: `src/createValuApp.js`, `src/transport/HostTransport.js`, `src/transport/PostMessageTransport.js`
- Create: `src/transport/EmbeddedTransport.js`, `test/host/embedded-transport.test.js`

**Interfaces:**
- `class EmbeddedTransport extends Transport { constructor({ bridge: PostMessageTransport, host: HostTransport, hostServed: (applicationId, action) => boolean }) }`: `servesServiceFunctions → true`; `callService` → `host.callService`; `request('api:service-intent', m)` → host when `hostServed(m.applicationId, m.action)` else bridge; every other `request`/`notify` → bridge; events: `READY` from the bridge (as today, `api:ready` from the parent), `TRIGGER` from both (commerce from the host only), `RECONNECTED` from the host; `open()` opens the bridge first, then the host, then posts `api:host-attach {hostOrigin}` through the bridge via `bridge.notify('api:host-attach', { hostOrigin })`.
- `hostServed` default: SDK descriptors by `(service, action)` + the 30 Commerce data intents + `subscribe-events`/`unsubscribe-events` + `Application.get-identity-token`.
- `createValuApp` in embedded mode builds `EmbeddedTransport` when `hostOrigin` is set (always, by default); `valu.auth.state` comes from the host; `valu.auth.signIn()` in embedded mode resolves immediately when the host reports `signedIn:true` and otherwise rejects `not_available`.
- `PostMessageTransport` accepts `api:color-scheme {scheme}` from the bound parent and emits `Transport.TRIGGER` with `{action:'color-scheme', data:{scheme}}` (used by `valu.theme`, Task 9).
- Consent in embedded mode: on `consent_required`, `valu.auth.requestConsent(scopes)` sends `api:service-intent {applicationId:'Application', action:'request-consent', params:{scopes}}` over the bridge and resolves `approved`; the retried `api:call` carries `afterConsent: true`.

- [ ] **Step 1: Write the failing tests** with `FakeWindow` (parent) + `FakeWindowPair` (host): `callService goes to the host`; `Commerce.checkout goes to the bridge and list-products to the host`; `open posts api:host-attach after the host iframe loads`; `request-consent goes to the bridge and the retry carries afterConsent`; `commerce triggers from the bridge are ignored when the host is attached`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(client): embedded mode routes data to the host and UI to the bridge`.

### Task 3: Bridge hands the nested host its token (valusocial-web)

**Files:**
- Modify: `src/Stores/IFrame/IFrameStore.js` (new case `api:host-attach`; `#post` uses `this.#origin` instead of `'*'`), `src/Services/Application/ApplicationService.js` (new `mintOneTimeToken(): Promise<string>` moved from `AiGuruStore.#mintOneTimeToken`, which then delegates), `src/Configs/HostConfig.js` (new: `HOST_ORIGINS` allow-list from `window.__BUILD_INFO__.host`, dev `http://localhost:3001`)
- Test: `src/Stores/IFrame/IFrameStore.hostAttach.test.js`

**Interfaces:**
- On `api:host-attach {hostOrigin}` from the app frame: if `hostOrigin ∉ HOST_ORIGINS` → reply `api:host-attach-completed {error:{code:'host_origin_not_allowed'}}`; else mint, then for every `i < iframe.contentWindow.frames.length` post `{type:'valu-host:embed', token, master: MetaverseApi.host, app:{address: appAddressOf(manifest), slug: manifest.id, devAppId: manifest.devId ?? null, homeNetworkId:null}, networkId: parent.networkId}` with `targetOrigin = hostOrigin`; reply `api:host-attach-completed {ok:true}`; remember `#hostAttached = true` for Task 4. `appAddressOf(manifest)` = `${workspaceId}/${slug}` when the registry record carries a workspace (Guru apps), else the Developer Portal id.
- Re-send on every frame `load` only after a new `api:host-attach`.

- [ ] **Step 1: Write the failing tests** (jsdom): `host-attach mints once and posts the embed to each nested frame with the host origin`; `disallowed host origin is refused and nothing is minted`; `#post no longer uses '*'`.
- [ ] **Step 2: Run** `npx vitest run src/Stores/IFrame` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm run lint`.
- [ ] **Step 5: Commit** `feat(bridge): hand the nested valu-api host a one-time token on api:host-attach`.

### Task 4: Grants and consent in Valu Social (valusocial-web)

**Files:**
- Create: `src/Services/Grants/GrantsService.js` (`NAME='Grants'`; `list(appId?)`, `grant(appId, scopes)`, `revoke(appId, scopes?)` over `AiGuruService.request('valuguru.apps.grants.*')`, 60 s cache), `src/Services/Grants/GrantsService.test.js`
- Modify: `src/Configs/Service_Manifests.js` (fill `permissions` for `Commerce.checkout`, `rate-product`, the nine seller dialogs, `DataProvider.pick-single/pick-multiple`), `src/Stores/ApplicationCenter/ApplicationCenterStore.js:171-186` (before `service.onNewIntent`: when the sender frame has `#hostAttached` and the manifest intent's `permissions` is non-empty, require a grant, else ask via `ConsentGate.ask(senderId, 'ConsentModal', consentData(scopes))`, write the grant on yes, refuse `{success:false, code:'consent_required'}` on no), `src/Services/Application/ApplicationService.js` (new intent `request-consent {scopes}` → the same gate → `{approved}`), `src/Stores/ApplicationCenter/ApplicationCenterStoreAPI.js:354-396` (stamp the sender on `app.run`/`app.open` from the pointer's owner frame), `src/Services/APIBridge/APIBridge.js` (carry the owner app id on pointers)
- Test: `src/Stores/ApplicationCenter/ApplicationCenterStore.grants.test.js`

**Interfaces:**
- `consentData(appName, scopes) → ConsentModal data` with `title: '<app> asks for permission'`, `list.items` = one sentence per scope from `SCOPE_WORDING` (shared wording with the host's consent page: copy the table).
- Scope strings on manifests use the host's names (`commerce:write`, `commerce:sell`, `resources:read`).

- [ ] **Step 1: Write the failing tests**: `a raw-bridge frame (no host-attach) runs checkout with no consent and no grants lookup` (Review Focus 2); `a host-attached frame without the grant gets the ConsentModal and, on yes, the grant is written and the intent runs`; `on no, consent_required`; `request-consent answers approved`; `app.run from a pointer carries the owner's sender id`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; the existing `serviceIntent.test.js` stays green.
- [ ] **Step 5: Commit** `feat(permissions): grant checks and consent for host-attached apps`.

### Task 5: "Connected apps" settings page (valusocial-web)

**Files:**
- Create: `src/Applications/SettingsApplication/ConnectedApps/ConnectedAppsPage.jsx`, `ConnectedAppsPage.test.jsx`
- Modify: `src/Applications/SettingsApplication/SettingsManifest.js` (page `connected-apps`, title "Connected apps", icon per the manifest's icon set), `src/Applications/SettingsApplication/SettingsApplication.jsx:115-124,475-484` (custom body like `__websocket__`)

**Interfaces:**
- The page lists `GrantsService.list()` grouped by app (name from the registry when known, else the address), each scope with its wording and `granted_at`, a "Revoke" per app (`revoke(appId)`) and per scope; works in the desktop nav and the mobile stack.

- [ ] **Step 1: Write the failing tests**: renders grouped grants; revoke calls the service and removes the row.
- [ ] **Step 2–4:** FAIL → implement → PASS; lint.
- [ ] **Step 5: Commit** `feat(settings): Connected apps page with revocation`.

### Task 6: Server side for M8 (valu-guru-server)

**Files:**
- Modify: `src/host/routes.ts` (`cspFrameAncestors` default adds the four brand origins and `https://web.texpo.io`), `src/host/grants.ts` (no change) 
- Test: `src/host/routes.test.ts` (header assertion updated)

- [ ] **Step 1–4:** update the test, implement, PASS. **Step 5: Commit** `feat(host): allow brand origins as frame ancestors for embedded mode`. Deploy with the next server merge (ask Pavlo).

### Task 7: M8 verification

- [ ] **Step 1:** Conformance suite through `EmbeddedTransport` (add a `runConformanceSuite({ name:'embedded adapter', makeServices })` entry whose bridge is a `FakeWindow` parent and whose host is the Task 13 host adapter).
- [ ] **Step 2:** With the dev web (`localhost:3005`) and the dev host (`localhost:3001`): register the sample app from the core plan as a Developer Portal iframe app, open it in Valu Social, confirm `valu.Users.current()` works through the host, `Commerce.checkout` opens My Cart from the bridge, consent dialog appears for a `rooms:write` call, and revoking in Settings cuts the app off within a minute. Repeat in the iOS shell build if available.
- [ ] **Step 3:** Record in `docs/superpowers/specs/2026-10-20-m8-results.md`.

---

## M9 — Claude Code and docs

### Design refinements (from the recon)

- **Template.** A GitHub template repository `ValuPorjects/valu-app-template` (source of truth: `template/` in the valu-api repo, pushed by `scripts/publish-template.mjs`, which Pavlo runs with his token). Contents: Vite + React + TS scaffold, `package.json` with `"@arkeytyp/valu-api": "^2.0.0"` in `dependencies`, `src/valu.ts` (`export const valu = await createValuApp()`), `src/App.tsx` showing sign-in state, `.valu/template.json` `{ "id": "valu-api", "version": 1 }`, a `CLAUDE.md` with only the managed markers. `provisionProjectRepository` uses `POST /repos/{owner}/{template}/generate` when `PROJECT_TEMPLATE_REPO` is set, else today's `auto_init`; `initialProvisioning` stamps `template: { id, version }` when the template was used.
- **npm release.** valu-api `2.0.0` is published to npm from a fixed workflow (Node 20, `npm ci`, `npm test`, publish on release); the template pins `^2.0.0`. Until the release exists, the template pins a tarball URL of the built package attached to a GitHub release (fallback; Pavlo decides).
- **Second skill pool.** New rows `project-valu-api` (replaces `claude-code-user-api` + `claude-code-theme-api` for template projects), `project-valu-commerce`, `project-valu-commerce-seller`, `project-valu-cms-files`, `project-valu-resource-images`, `project-valu-app-header`, written as `211_…` migrations with in-code fallbacks and byte-mirror tests like the existing ones. `projectWorkerIndexedSkills(project)` returns the valu pool when `project.provisioning.template?.id === 'valu-api'`, else today's list; the skill plugin root becomes per pool (`.skill-plugin-valu` / `.skill-plugin`). The App Builder (static apps) keeps its loadout untouched.
- **Generated reference.** `scripts/generate-valu-reference.mjs` in valu-guru-server renders, from the pinned valu-api's `SERVICE_DESCRIPTORS` and the Commerce entries of `APPLICATION_ONLY_INTENTS`, a markdown table (function, params, returns, scope, availability per mode) under 12 000 characters, embedded in `project-valu-api` between `<!-- reference:begin -->` markers; a test fails when the embedded block differs from the generated one, and another test fails when any `valu.<Service>.<method>(` or `new Intent('<S>', '<a>'` token in the valu pool does not resolve in the pinned package.
- **Managed `CLAUDE.md` and policy.** `buildManagedSection` gets a template branch: for template projects the "Calling another application's API" block says `import { valu } from './src/valu'` and names `project-valu-api`; old projects keep their text byte for byte. `project-developer` v25 adds one sentence to "WHAT VALU ITSELF PROVIDES": if `.valu/template.json` exists, use valu-api only and open `project-valu-api`; never write `postMessage` bridge code.
- **Publish guard.** In `publishProject` before step 1, for template projects only: scan `src/**/*.{js,jsx,ts,tsx,html}` and root `*.{html,js,ts}` (excluding `node_modules`, `dist`, `.valu`) for `/\bapi:(ready|service-intent|run-intent|create-pointer|run|run-console)\b|target\s*:\s*['"]valuApi['"]/`; refuse with step `guard` and the message `Use valu-api instead of the bridge: <file>:<line> → valu.<suggestion>()`; also refuse when `@arkeytyp/valu-api` is missing from `dependencies`.
- **Typed surfaces first.** valu-api gains `valu.theme` (client-only, Task 9) and `valu.Commerce.*` (generated from the Commerce entries of `APPLICATION_ONLY_INTENTS`: `listProducts(params)` → `callService(new Intent('Commerce','list-products',params))`, typed answers from `docs/api-pointers.md`; UI actions included, answering `not_available` in dedicated mode until M10). App header stays a pointer call (`valu.getApi('app')`) and answers `not_available` in dedicated mode.
- **Human docs.** Developer Portal `sdkArticles.js` rewritten to valu-api calls with its test pins; `scripts/generate-intent-docs.js` adds a "valu-api call" line per intent; valu-api `README.md` and `docs/` lead with `createValuApp`; valu-docs (not checked out locally): the Intent Explorer's per-intent entry gets the same "valu-api call" line, done in that repo by hand.

### Task 8: Template and npm release (valu-api)

**Files:**
- Create: `template/` (files above), `scripts/publish-template.mjs`, `test/template.test.js`
- Modify: `.github/workflows/npm.yml` (Node 20, `npm ci`, `npm test`, `npm publish --provenance --access public` on `release: published`), `package.json` (`files`, `exports` for `./src/host/*` and `.`), `README.md`

- [ ] **Step 1: Write the failing test** `template builds and imports valu-api`: copy `template/` to a temp dir, `npm install` with `file:../..` substituted for the version, `npm run build` exits 0, `dist/` contains the sign-in button text.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(template): valu-app-template source and publish script; fix npm workflow`. Ask Pavlo to create the GitHub release (publishes 2.0.0) and to run `scripts/publish-template.mjs` (creates/updates `ValuPorjects/valu-app-template`, marked as a template repo).

### Task 9: `valu.theme` and typed `valu.Commerce.*` (valu-api)

**Files:**
- Create: `src/theme.js`, `src/commerce/Commerce.js` (generated by `scripts/generate.mjs` from the Commerce entries), `test/theme.test.js`, `test/commerce.test.js`
- Modify: `src/createValuApp.js`, `scripts/generate.mjs`, `types/valu-api.d.ts`, `docs/api-pointers.md` (generated)

**Interfaces:**
- `valu.theme`: `{ get scheme() → 'light'|'dark', on('change', h) → unsub }`; embedded: initial from `getApi('ux').run('colorScheme')` when available, updates from the `color-scheme` trigger; dedicated: `matchMedia('(prefers-color-scheme: dark)')`.
- `valu.Commerce.<method>(params)` for all 49 Commerce intents, method = camelCase of the action; answers verbatim; `ValuApi.ON_COMMERCE` unchanged.

- [ ] **Step 1: Write the failing tests**: `theme follows api:color-scheme when embedded`; `theme follows matchMedia when dedicated`; `Commerce.listProducts posts the intent and returns the answer`; `every Commerce action has a method` (49).
- [ ] **Step 2–4:** FAIL → implement (generator) → PASS; `npm run check:generated`.
- [ ] **Step 5: Commit** `feat(client): valu.theme and typed valu.Commerce`.

### Task 10: Provisioning from the template and the project stamp (valu-guru-server)

**Files:**
- Modify: `src/valuguru/provisioning/repository.ts:107-158` (`/generate` when `PROJECT_TEMPLATE_REPO` is set; adopt on 422), `src/valuguru/provisioning/index.ts:137-160` (`initialProvisioning` stamps `template`), `src/valuguru/provisioning/index.ts:244-300` (keep the managed `CLAUDE.md` seed; it merges with the template's markers)
- Test: `src/valuguru/provisioning/repository.test.ts` (or the existing provisioning tests)

**Interfaces:**
- `provisionProjectRepository(input, { templateRepo?: string })`; `ProjectProvisioning.template?: { id: 'valu-api'; version: number }`.

- [ ] **Step 1: Write the failing tests**: `uses /generate with the template when configured`; `falls back to auto_init without it`; `initialProvisioning stamps template when generated`.
- [ ] **Step 2–4:** FAIL → implement → PASS; `npm run check:provisioning` still passes.
- [ ] **Step 5: Commit** `feat(provisioning): create project repos from the valu-app template`.

### Task 11: The valu skill pool, generated reference, and the skills-vs-package test (valu-guru-server)

**Files:**
- Create: `src/project-valu-skills.ts` (the six `PROJECT_VALU_*_PROMPT` constants + descriptions + floor), `scripts/generate-valu-reference.mjs`, `src/project-valu-skills.test.ts`, `supabase/migrations/211_project_valu_api_skills.sql` (INSERT … ON CONFLICT pattern of `208_commerce_seller_skill.sql`, dollar tags `$PVAPI$` etc., `vg_skill_versions` rows, `NOTIFY pgrst`)
- Modify: `src/project-worker-skills.ts:90-104,719-732` (`projectWorkerIndexedSkills(project)`), `src/project-claude-worker.ts:566-572` (per-pool plugin root), `src/claude-code-skill-plugin.ts:66-71`

**Interfaces:**
- `PROJECT_VALU_SKILL_IDS = ['project-valu-api','project-valu-commerce','project-valu-commerce-seller','project-valu-cms-files','project-valu-resource-images','project-valu-app-header']`.
- `projectWorkerIndexedSkills(project?: { provisioning?: ProjectProvisioning }) → string[]`: the valu pool plus `project-rest-api`, `project-using-apis` (rewritten to valu-api in the same migration), `project-sign-in` for template projects; today's list otherwise.
- `generateValuReference({ descriptors, applicationOnly }) → string` ≤ 12 000 characters; `project-valu-api` embeds it between `<!-- reference:begin -->` / `<!-- reference:end -->`.
- Tests: byte-mirror per skill against migration 211; `reference block equals the generated one`; `every valu.<S>.<m>( and new Intent('<S>','<a>' in the pool resolves` (Review Focus 4, with a negative case `valu.Users.getUser(` injected into a copy failing); every pool skill `< 20_000` characters; descriptions pinned.

- [ ] **Step 1: Write the failing tests.** **Step 2: Run** `npx vitest run src/project-valu-skills.test.ts` → FAIL.
- [ ] **Step 3: Write the skills** (domain rules carried over from `claude-code-commerce-api`, `-seller-api`, `-cms-files`, `-resource-images`, `-app-header`; all calls as `valu.*` / `valu.Commerce.*`; sign-in via `valu.auth.signIn()` from a click; no `postMessage`, `api:*`, `target: 'valuApi'` anywhere), the generator, the migration, the pool switch and the per-pool root.
- [ ] **Step 4: Run** → PASS; `npm test` → PASS (old byte-mirror tests untouched).
- [ ] **Step 5: Commit** `feat(skills): valu-api skill pool for template projects`.

### Task 12: Managed CLAUDE.md branch, policy v25, publish guard (valu-guru-server)

**Files:**
- Modify: `src/project-claude-md.ts:163-413` (`buildManagedSection({ ..., template })`), `src/project-coder.ts` (`PROJECT_DEVELOPER_FALLBACK_INSTRUCTIONS` v25) + `supabase/migrations/212_project_developer_policy_v25.sql` (pattern of 210), `src/project-publish.ts:115-122,321` (step `guard`)
- Create: `src/project-publish-guard.ts` (`scanForBridgeUse(worktree) → Array<{file, line, text, suggestion}>`, `requireValuApiDependency(worktree) → string|null`), `src/project-publish-guard.test.ts`

- [ ] **Step 1: Write the failing tests**: `old project CLAUDE.md block is byte-identical to before` (snapshot); `template project block names src/valu and project-valu-api`; guard `finds api:service-intent in src and reports a suggestion`; `ignores node_modules and dist` (Review Focus 3); `does not run for non-template projects`; `refuses a missing dependency`; policy byte-mirror v25.
- [ ] **Step 2–4:** FAIL → implement → PASS; `npm run db:auto:check`.
- [ ] **Step 5: Commit** `feat(publish): bridge-use guard for template projects; policy v25; template-aware CLAUDE.md`.

### Task 13: Developer docs (valusocial-web, valu-guru-server, valu-api, valu-docs)

**Files:**
- Modify: `src/Applications/DeveloperPortal/Components/SdkGuide/sdkArticles.js` + `sdkArticles.test.js` (valusocial-web); `scripts/generate-intent-docs.js` + `docs/intents.md` (valusocial-web; keep the hand-kept `hubs` section); `docs/application-rest-api.md`, `docs/sign-in-with-valu.md` (valu-guru-server); `README.md`, `docs/connecting.md`, `docs/sdk.md` (valu-api); valu-docs Intent Explorer (by hand, in that repo)

- [ ] **Step 1:** Rewrite the nine SDK articles to `createValuApp` / `valu.*` / `valu.Commerce.*` / `valu.auth`; add an article `permissions` (tiers, consent, Connected apps); keep every intent the test pins covered.
- [ ] **Step 2:** Add the "valu-api call" line to the intent docs generator and regenerate; diff shows only additions plus the `hubs` section intact.
- [ ] **Step 3:** Update the server and valu-api docs; list the exact valu-docs pages to change in `docs/superpowers/specs/2026-10-20-m9-docs-checklist.md` for whoever has that repo.
- [ ] **Step 4:** Commit per repo: `docs: developer docs teach valu-api only`.

### Task 14: M9 verification

- [ ] **Step 1:** Create a project in "Valu Apps Development" from a blank prompt ("a page that greets the signed-in user and lists my rooms"); confirm the worker's output has no bridge vocabulary (`grep -rE "postMessage|api:ready|api:service-intent" src` empty), uses `valu.auth.signIn()` and `valu.Rooms.*`, and `publish_project` succeeds; then add a raw `postMessage` call and confirm the guard refuses with the suggestion.
- [ ] **Step 2:** Confirm an old project's next worker run leaves its `CLAUDE.md` block unchanged and publishes with no guard.
- [ ] **Step 3:** Record in `docs/superpowers/specs/2026-10-20-m9-results.md`.

---

## M10 — UI actions in dedicated mode

### Design refinements (from the recon)

- **Where the popup lives.** A new shell in valusocial-web, selected by hostname prefix `actions` (like `auth`), rendered by the single shell, which already registers `CartApplicationStore`, `MerchantApplicationStore`, `NetworksStore`, `ModalStore`, `CommerceService` and the four modals. The single shell's `applicationId` prop bug (`ApplicationBuilder` never receives props) is fixed first.
- **How it signs in and learns the action.** The popup is opened by the app page at `https://actions.<brand>/action?nonce=<n>`. On load it posts `{type:'valu-host:action-hello', nonce}` to `window.opener.frames[*]` with `targetOrigin = hostOrigin`; the host answers the popup window (`event.source`) with `{type:'valu-host:action', nonce, token, master, app:{address, slug}, action, params}` using `targetOrigin = popupOrigin` (a brand origin from a compiled list). The popup signs in with the token through `AuthStore.checkOneTimeAuthToken` (no navigation), then runs the action; the result goes back the same way: `{type:'valu-host:action-result', nonce, result}`; the host resolves the app's intent with Valu Social's documented answer (`{success:true, outcome, orderId?, status?}` for checkout). The app id in the URL is never used (Review Focus 5); everything comes from the host, which already checked the grant.
- **Actions.** `checkout {promoCode?}` → `CartApplicationStore` popup surface `CART` scoped to the app (`#setScope(slug)`), `whenPopupCloses(ticket)` → outcome; the nine seller dialogs → `ConsentGate.ask` with the `sellerConsent.js` builders, or `ProductDialogModal` after `merchant.loadPublishContext()`, then the existing `sellerIntents` handler runs the op; `rate-product` → `RateProductModal`; `create-product` without title → `CreateProductModal` (upload only; no Media pane). `open-cart`/`open-order`/`open-purchases`/`open-products`/`preview-purchase` open the same popup on the matching surface and answer `{opened:true}`. Pickers, RoomPoints, Unity and docks stay `not_available`.
- **Host side.** `HostBridge` gains a pending-action table keyed by nonce, `host:action {action, params, nonce}` from the client, and the two popup messages above; the client's `createValuApp` opens the popup synchronously inside the intent call when `navigator.userActivation.isActive`, else answers `{success:false, code:'needs_click'}`.

### Task 15: Host pending actions and popup channel (valu-api)

**Files:**
- Modify: `src/host/HostBridge.js`, `src/host/protocol.js`, `src/createValuApp.js`
- Test: `test/host/host-bridge-actions.test.js`

**Interfaces:**
- `MSG.ACTION:'host:action'`, `MSG.ACTION_COMPLETED:'host:action-completed'`; popup message types `valu-host:action-hello`, `valu-host:action`, `valu-host:action-result`; config `actionOrigins` (brand `actions.` origins).
- `host:action {applicationId:'Commerce', action, params, nonce, requestId}` → permission check as for the intent (`commerce:write` for checkout and rate, `commerce:sell` for seller dialogs) → the pending record `{nonce, app, action, params, token: minted lazily when the popup says hello}` → waits for `action-result` (10 min) → answers the intent's documented shape; the host mints the popup's one-time token with its own session.
- Client: `callService(new Intent('Commerce','checkout',…))` in dedicated mode → if activation: `window.open(`${actionOrigin}/action?nonce=${nonce}`, 'valu-action', 'popup,width=520,height=720')` then `host:action`; popup closed without a result → `{success:false, code:'dismissed'}`.

- [ ] **Step 1: Write the failing tests**: `checkout without commerce:write answers consent_required`; `action-hello from a brand origin gets the token and the action; from the app origin nothing`; `action-result resolves the intent`; `popup closed resolves dismissed`; `a hello with an unknown nonce is ignored`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(host): pending UI actions handed to a popup on a Valu origin`.

### Task 16: Single-shell props fix and the `actions` shell (valusocial-web)

**Files:**
- Modify: `src/application.jsx:96-112` (hostname `actions` → `LazyActionPopupLoader`), `src/Applications/Shells/ApplicationBuilder.jsx:26-31,131` and `SingleApplication.jsx:160` (pass props through)
- Create: `src/Applications/ActionPopup/ActionPopupApplication.jsx`, `src/Applications/ActionPopup/actionPopupHandoff.js` (pure: `helloHost`, `postResult`, origin checks), `actionPopupHandoff.test.js`, `.valu-build.json` `host.actionOrigin`
- Test: `src/Applications/Shells/ApplicationBuilder.test.jsx` (props reach the single shell)

**Interfaces:**
- `ActionPopupApplication` boots the single shell with no docked app, posts `action-hello`, accepts `valu-host:action` only from `HOST_ORIGINS`, signs in via `AuthStore.checkOneTimeAuthToken(token)`, then dispatches by `action` (Task 17), finally `postResult` and `window.close()`.

- [ ] **Step 1: Write the failing tests**: `single shell receives applicationId`; `action message from a non-host origin is ignored`; `result is posted only to the host frame with the host origin`.
- [ ] **Step 2–4:** FAIL → implement → PASS; lint.
- [ ] **Step 5: Commit** `feat(actions): standalone action popup shell signed in by the valu-api host`.

### Task 17: The actions (valusocial-web)

**Files:**
- Create: `src/Applications/ActionPopup/actions/checkout.js`, `sellerDialog.js`, `rateProduct.js`, `createProduct.js`, `openSurface.js`, each `run({ app, params, stores, services }) → Promise<result>`; tests per file with fake stores
- Modify: `src/Applications/CartApplication/Stores/CartApplicationStore.js` (allow `#popupAnchor` without a pane; scope by `app.slug`)

- [ ] **Step 1: Write the failing tests**: `checkout scopes the cart to the app, applies the promo, resolves whenPopupCloses outcome`; `publish-product refuses unsupported without publishNetworks, else runs the dialog then the op`; `rate-product returns {score,text} result`; `an action whose app differs from the host-bound app is refused` (Review Focus 5).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(actions): checkout, seller dialogs, rating and product creation in the popup`.

### Task 18: M10 verification and deploys

- [ ] **Step 1:** Dev: `actions.localhost:3005`-style hostname is not available locally; use the `?valu-shell=actions` dev override added in Task 16 for `localhost:3005`.
- [ ] **Step 2:** From the sample app on its real host: checkout a test item (Pavlo's account; restore the cart after), run one seller dialog on a seller account, rate a product. Record in `docs/superpowers/specs/2026-10-20-m10-results.md`.
- [ ] **Step 3:** Deploys (ask Pavlo): server (host config), dev web, then production web with the `actions.` hostname set up by DevOps (DNS + the same static host).

---

## Self-review notes

- Spec coverage: M8 row → Tasks 1–7; M9 row → 8–14; M10 row → 15–18; §4.11 unchanged.
- Interfaces consistent with the core plan: `HostBridge`, `HostAuth.redeem`, `GrantsStore`, `HostTransport`, `createValuApp`, `MSG`, `HOST_ERRORS`; new names introduced once each (`EmbeddedTransport`, `GrantsService`, `PROJECT_VALU_SKILL_IDS`, `ActionPopupApplication`).
- Things that may change after M7 and must be re-checked before starting M8: whether the redeemed session equals the minting session (affects nothing here, since embedded mode uses the bridge's session anyway), Safari's handling of a nested host inside Valu Social (storage is only a cache there), and WKWebView's nested-iframe behaviour.
- Spec corrections implied by this plan (to apply in the spec): `valu.theme` has no server source; embedded identity comes from Valu Social's registry, not the resolve endpoint; `frame-ancestors` includes the brand origins and `web.texpo.io`; grants cache 60 s.
