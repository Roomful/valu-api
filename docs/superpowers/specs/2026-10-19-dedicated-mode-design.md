# valu-api: one API for embedded and dedicated apps — design

> **SUPERSEDED on 2026-10-20** by `2026-10-20-hidden-iframe-host-handoff.md`
> (same folder).
> - The team chose a hidden iframe on a Valu origin as the valu-api host, in
>   place of the Valu Guru app endpoint described below.
> - Still valid: the permission model (§4.5), the canonical app id and network
>   calls (§4.3), the publish guard and skills plan (§4.9), and the verified
>   facts (§3).

**Date:** 2026-10-19 · **Decided with:** Pavlo · **Status:** design, nothing built

Every app a Workspace builds installs `@arkeytyp/valu-api`. Today those apps
mostly talk to the Valu Social application over the postMessage intent bridge,
so they only work while framed inside Valu Social. This design makes one API
that works the same in both places an app runs:

- **embedded** — framed inside Valu Social;
- **dedicated** — on its own address, e.g. `https://<slug>-ws-<ws>.valuguru.app/`.

It does so **safely from the start**: an app never holds the user's session,
and it can do only what the user allowed that app to do.

Sections 1–4 are what was decided. §5 is what the master-server team must
answer or build. §7 is the order of work, and §8 is what is left to whoever
builds it. Calls I made rather than Pavlo are marked *(my call)*.

---

## 1. Intent

- **One API.** The same call (`valu.Commerce.addToCart(...)`) has the same
  name, params, answer shape and errors in both modes. App code does not branch
  on where it runs.
- **Native where it can be.** When embedded, valu-api still uses the bridge for
  what only Valu Social can do: open a dock, draw a picker or a confirmation
  dialog, theme, routes.
- **Claude Code learns valu-api only.** The Guru project worker that builds
  these apps is taught valu-api and nothing about the bridge, so it stops
  hand-writing bridge clients.

Why now: published apps already have their own hosts (since 2026-10-09), and
"Sign in with Valu" exists (Stan, 2026-10-07 → 10-13), so a dedicated app can
know who its visitor is. What it cannot do yet is act for them, and that is
the gap this closes.

## 2. Goals, non-goals, anti-goals

**Goals**

1. One API with identical behaviour in both modes.
2. Safe from the start:
   - an app never receives the user's Roomful `sessionId`, `session_token` or a
     one-time token;
   - every call is checked on a server against what the user granted that app;
   - dangerous actions are confirmed on a Valu page, never inside the app.
3. One permission model in both modes, with one consent record per (user, app).
4. Claude Code builds with valu-api only. Skills, the project `CLAUDE.md`, the
   developer policy and the human-facing docs say nothing about the bridge, and
   publishing refuses an app that uses the bridge directly.

**Which apps** (decided): apps built in Workspaces **and** apps registered in
the Developer Portal. Valu's own internal apps (LLM Debug and similar) stay as
they are: not routed through this design, and not asked for consent.

**Non-goals**

- How Valu Social itself talks to the master or to Valu Guru.
- The answer shapes of existing intents, which raw-bridge apps and Valu
  Social's AI tools (`AiGuruTools.js`) read today.
- Native mobile apps.

**Anti-goals: a failure even if everything works**

- Any path on which app code can obtain a session or a one-time token.
- A generic "run any Roomful RPC" pass-through.
- Two implementations of one data function (bridge vs server) that can drift.
- Already-published apps breaking on rollout.

## 3. Where things stand (verified 2026-10-19)

| Area | Fact | Where |
|---|---|---|
| valu-api | Two independent parts: `ValuApi` (the bridge, no socket) and the service SDK, which runs 65 functions over the Roomful socket only. | `src/ValuApi.js`, `src/services/api.js` |
| valu-api | Each function declares a scope (30 names, e.g. `users:read`, `rooms:write`, `veruswallet:write`). The check is client-side and advisory (`AuthProvider.scopeAck`), and `AuthProvider.handshake()` is never called by any socket code. | `src/services/descriptors.js`, `src/auth/AuthProvider.js` |
| valu-api | It has no Valu Guru client (removed in `0d10df8`, 2026-10-01). | — |
| Valu Social | Bridge: `IFrameStore.js` → `ApplicationCenterStore.handleIntentRequest`. It declares 133 service intents, and the `permissions` field is empty on all of them. | `src/Stores/IFrame/IFrameStore.js` |
| Valu Social | Commerce intents become `valuguru.commerce.*` ops over the Valu Guru socket (70 op references). | `src/Services/Commerce/CommerceDataService.js` |
| Valu Social | `Application.get-identity-token` takes the app id from the host-stamped `intent.senderApplicationId`. | `src/Services/Application/ApplicationService.js` |
| Valu Social | My Cart URLs exist only for its tabs (`/cart`, `/cart/orders`, `/cart/purchased`), not for "pay for app X's items". | `CartApplicationStore.js` (`#routes`) |
| Valu Guru | The WS upgrade accepts only a master one-time token, with no origin check. | `src/valuguru/connection-auth.ts` |
| Valu Guru | `data_request` knows the user but not the app, so every op the user may run is reachable from any connection. | `src/index.ts` (`case "data_request"`) |
| Valu Guru | Acts on Roomful only with the user's stored session (`vg_session_tokens`, written on each Valu Social connect), through a per-user pool. | `src/server-agents/connection-pool.ts`, `session-tokens.ts` |
| Valu Guru | Already runs valu-api's functions over that pool. | `src/valu-tools/sdk.ts` |
| Valu Guru | Already verifies master identity tokens and mints short-lived scoped tokens for the App API. | `src/debug/identity-auth.ts`, `src/app-api/token.ts` |
| Sign in with Valu | Provider `connect.roomful.net`: discovery document, RS256 keys at `/keys`. Each app has one OIDC client (`application:createOidcClient`, in the master docs since 2026-10-08). | `docs/sign-in-with-valu.md` (valu-guru-server) |
| Sign in with Valu | **What the provider actually returns** (read from the `_vg_sign_in_log` of "My Profile", `pj_3221bffa` in workspace `ws_7a07b7b5`: four successful sign-ins on 2026-10-16): `access_token`, `expires_in`, `id_token`, `scope`, `token_type`. **No session and no `refresh_token`** (apps ask only for `openid profile email`). The id_token claims are `at_hash`, `aud`, `auth_time`, `azp`, `c_hash`, `client_id`, `exp`, `iat`, `iss`, `nonce`, `sub`; the profile fields arrive separately. Live test apps: `https://my-profile-ws-7a07b7b5.valuguru.app/`, `https://github-analytics-ws-7a07b7b5.valuguru.app/`. | `src/project-functions.ts` (`signInExchangeCode`) |
| Master | The Roomful socket needs a `sessionId`; CORS allows any origin. `partnerRpc` is server-to-server but covers only a few reads and checks. No documented call turns a sign-in token into a session (Stan's "M2"). | valu-docs `docs/apidocs/*` |
| Claude Code | 13 skills teach the bridge, about 7 of them heavily. `claude-code-user-api` ships a ~30-line hand-written bridge client and says "There is no SDK package". Skills contradict each other on frame detection. There is no starter template: a new repo holds only a README. | `src/claude-code-subagent.ts`, `src/project-worker-skills.ts`, `src/valuguru/provisioning/repository.ts` |
| Human docs | The Developer Portal SDK articles and the valu-docs Intent Explorer (added 2026-10-19) teach intents. | valusocial-web Developer Portal, valu-docs |

## 4. The design

### 4.1 Shape

```
  embedded (framed in Valu Social)              dedicated (own host)
  app code → valu-api                           app code → valu-api
     │  bridge: identity token, UI intents         │  Sign in with Valu: id_token
     │  (docks, pickers, confirm dialogs)          │  UI: popup to a Valu page
     ▼                                             ▼
  ┌──────────── Valu Guru — app endpoint ────────────────────────────┐
  │ verify token → (user, app) · allow-list · scope ∈ grant ·        │
  │ validate params · confirmation if dangerous · audit · rate limit │
  └──────┬───────────────────────────────┬───────────────────────────┘
         │ valuguru.* ops (Commerce …)   │ Roomful functions: valu-api over
         │ in-process                    │ the user's pooled connection
                                         ▼
                                    master (Roomful)
```

**Data goes through Valu Guru in both modes** (decided: option "B"). The bridge
carries only UI and the identity token. This gives:

- one implementation per data function;
- one place where permissions are checked;
- identical answer shapes by construction.

The cost is one extra hop for Roomful calls when embedded.

`local` functions (URL builders, `Time`, `Http`) still run inside valu-api in
the page.

### 4.2 Mode detection

- valu-api decides the mode itself and exposes `valu.mode` (`'embedded' | 'dedicated'`).
- It is embedded if and only if the bridge handshake (`api:ready`) arrives
  within a short wait.
- A dev override (`?valu-mode=dedicated`) forces dedicated mode inside a frame
  for testing.
- Apps never test `window.parent` or `window.top`.

### 4.3 Identity and the connection to Valu Guru

- **Embedded:** valu-api asks the bridge for `Application.get-identity-token`.
  The master issues it, with `aud` = the app id stamped by the host, and it
  lives 5 minutes. valu-api connects to the Valu Guru app endpoint with it.
- **Dedicated:**
  - "Sign in with Valu" runs as built.
  - The app's server function hands the page the `id_token`, and refreshes it
    with the `refresh_token` *(my call; today the page gets only the app's own
    session)*.
  - valu-api takes a `getToken()` callback and calls it on every connect and
    reconnect.
- **Valu Guru app endpoint:** a new WebSocket door, separate from Valu Social's
  `?token=` door, which stays as it is.
  - It accepts either token: master identity tokens (master JWKS) and
    `connect.roomful.net` id_tokens (provider JWKS).
  - It checks signature, issuer, expiry and audience.
  - It maps the audience to a registered application (OIDC `clientId` →
    application via `oidcClientId`). For Workspaces apps Valu Guru already
    holds that mapping on the project row. For Developer Portal apps it needs a
    master lookup (§5, item 8).
  - It derives `(userId, appId)` from the token, never from params.
- **Must be verified before building:** that `sub` is the Roomful user id in
  both tokens (§5, M1).
- **Canonical app identity** *(my call)*. Grants and audit are keyed to the
  App API address: `{workspace}/{slug}` for a Guru-built app, and the Developer
  Portal application id otherwise.
  - Why not the bare stamped id: today Valu Social stamps the dock registry id,
    which for a Guru project is the bare slug (with `--dev` / `--review` for
    test builds, `testingCatalogue.js`). Slugs are unique only within a
    workspace, so two workspaces' `meal-planner` apps would share grants.
  - Valu Social asks the master to mint the embedded identity token with
    `aud` = the canonical address. The App API gateway and the debug panel,
    which read today's form, accept both forms during the transition.
  - `--dev` and `--review` builds get their **own** grants. A test build is new
    code and must not inherit what the user granted the released app.
  - **Data keys do not change.** The Commerce `appId` and the
    ApplicationStorage/CMS belonging `app:{id}:…` keep the strings they use
    today. Valu Guru passes the existing stamped id through as the data key, so
    no data moves.
- **Network** *(my call)*. Sessions and the per-user pool are network-scoped
  (one connection per user, network fixed at open).
  - Embedded: calls run in the user's current Valu Social network.
  - Dedicated: calls run in the app's home network, i.e. its workspace's
    network.
  - The app may not name another network.
  - If the only session Valu Guru holds is for a different network, the call is
    refused with `network_mismatch` rather than answered from the wrong
    network. Under M2 the exchange asks for a session in the right network.
  - Making the pool per (user, network) is deferred until dedicated apps need it.
  - valu-api exposes the network as `valu.network`, which replaces the
    `network` pointer apps read today.

### 4.4 Acting on Roomful for the user

The session never leaves Valu Guru.

- **Target:** the master lets **only Valu Guru**, with its own client
  credentials, exchange a user's sign-in token for a Roomful session (§5, M2).
  Ideally that session is separate per (user, app) and revocable.
- **Interim, with no master change** *(my call)*:
  - Valu Guru uses the user's stored Valu Social session from `vg_session_tokens`.
  - Embedded mode always has a fresh one, because the user is in Valu Social.
  - Dedicated mode works for users who used Valu Social recently. Others get a
    clear error (`needs_valu_session`: "open Valu Social once").
- **Known side effect:** today every new Valu Social connection overwrites the
  user's stored session. The app endpoint must never write to that store.

### 4.5 Permissions

- **Scope per function.** valu-api's descriptors are the single source: the
  existing 30 scopes, plus new ones for Valu Guru ops (e.g. `commerce:read`,
  `commerce:write`, `commerce:sell`). Valu Guru already imports valu-api, so it
  reads the same catalogue.
- **Risk tiers** (three tiers: decided; the exact assignment below is *my call*):

  | Tier | Scopes | Granted |
  |---|---|---|
  | Basic | `users:read`, `networks:read`, `time:read`, `resources:read` | with sign-in |
  | Consent | `textchat:*`, `rooms:write`, `groups:write`, `events:write`, `commerce:*`, `community:read`, … | explicit consent |
  | Forbidden to apps | `veruswallet:write`, `cbac:write`, `developer:write` | never |

- **Declaration.** An app lists the scopes it needs in its manifest. For
  Guru-built apps the list is generated from the functions the code calls.
- **Consent:**
  - dedicated: on a Valu consent page the visitor is redirected to **right after
    sign-in**, as one list *(my call)*. The sign-in page itself
    (`AuthSignInPage` on `auth.<brand>`) gets only an opaque `authRequestID`
    and never learns which app is asking. The consent page is served from
    `auth.<brand>`, where the visitor has just been signed in (`AuthStore`
    `setSession`). Redirecting, rather than opening a popup, avoids popup
    blocking on page load. The generated sign-in function performs the
    redirect.
  - embedded: a Valu Social dialog;
  - a scope the app did not declare is asked for **on first use**, in both
    modes (decided). That is also how already-published apps keep working.
- **Storage.** Grants live in Valu Guru: user, app, scope, granted_at,
  revoked_at. One record serves both modes.
- **Revocation.** A "Connected apps" list in Valu Social settings. Revoking
  closes that app's connections.
- **Per call**, on the app endpoint:
  1. the function is on the allow-list (deny by default);
  2. its scope is in the user's grant for this app;
  3. `validateParams` (from valu-api) passes;
  4. identity comes from the token;
  5. a dangerous action goes to confirmation (§4.6);
  6. execute;
  7. write an audit row (who, which app, what, when);
  8. apply a per-app rate limit.
- **Embedded UI intents.** Valu Social fills `permissions` for the intents that
  still go over the bridge, and checks the same grants before running them.

### 4.6 Dangerous actions and UI-only intents

| Kind | Examples | Embedded | Dedicated |
|---|---|---|---|
| Confirm dialogs | publish / unlist / archive / delete product, set-sale, set-volume-tier, set-donation-tiers, create / update discount code, rate-product | **The same server-side confirmation as dedicated** *(my call)*. Valu Social only draws the dialog for it, inline over the app. | Valu Guru stores a pending confirmation (exact action and params, bound to user and app, short expiry) and returns a URL. valu-api opens a popup to a Valu page (served from `auth.<brand>`) that draws the same dialog. Confirming executes the action, and the app's call resolves with the result. |
| Checkout | `Commerce.checkout` | My Cart over the app, as today | Popup to My Cart scoped to the app's rows and promo. The outcome arrives as `order-updated` over the app connection. Needs a new My Cart URL entry. |
| Open a Valu view | open-cart / order / products / purchases / purchase-in-media, preview-purchase | dock, as today | open the Valu Social page in a new tab |
| Pickers | `DataProvider.pick-single` / `pick-multiple` | as today | `not_available` in v1 *(my call)* |
| Dock control and 3D | `AiGuru.open/close/…`, `Application.close-application/expand/close_all`, `RoomPoints` editors | as today | `not_available` |
| Events | `Commerce.subscribe-events` | pushed over the Valu Guru app connection in both modes | (same) |

- **Why embedded confirmations also go through Valu Guru.** Otherwise a
  dangerous action would run inside Valu Social, skipping the app endpoint's
  grant check, audit and answer shape, which breaks §4.1. This means the
  pre-checks, consent wording and "ask only when it can happen" logic in
  `sellerIntents.js` / `sellerConsent.js` move into Valu Guru. Valu Social
  keeps one dialog entry point: "draw pending confirmation X".
- Popups must be opened from a user gesture; otherwise valu-api falls back to a
  link the user clicks.
- **Popup sign-in state.** The sign-in sets the session on `auth.<brand>`, so
  Valu pages served from that host are signed in. The confirm, consent and
  checkout pages live there. §5.5 asks only to confirm this.

### 4.7 Answer shapes

- valu-api's own shapes (`{users}`, `{policies}`, …) are the contract in both
  modes, and they are identical because there is one implementation.
- Valu Social keeps its current intent shapes for raw-bridge apps and for its
  AI tools.

### 4.8 Already-published apps

- Raw-bridge apps keep working: Valu Social keeps serving their intents.
- Permission checks reach them through first-use consent.
- No republish is required.

### 4.9 Claude Code

1. **Starter template.** Provisioning creates each project repo from a template
   with `@arkeytyp/valu-api` pinned and an init file, instead of
   `auto_init: true` (`repository.ts`).
2. **One `valu-api` skill replaces the bridge parts.** The Commerce, CMS,
   theme, header and resource-image skills keep their domain rules (e.g. "the
   app never takes a payment") and switch their calls to `valu.*`.
3. **A generated function reference** (name, params, scope, behaviour per mode)
   comes from valu-api's catalogue. A valu-guru-server test fails when a skill
   names a function that the pinned valu-api does not have.
4. **Remove the bridge vocabulary** (`api:ready`, `postMessage`,
   `target:'valuApi'`, `api:service-intent`, `api:run`, …) from:
   - the skills;
   - the managed project `CLAUDE.md` block (`src/project-claude-md.ts`);
   - the `project-developer` policy;
   - the App Builder prompt.
5. **Publish guard.** `publishProject` (`src/project-publish.ts`) refuses an app
   whose own source, outside `node_modules`, uses the bridge directly, and names
   the valu-api function to use instead.
   - It applies to projects created from the new template.
   - Older projects are **exempt until migrated** *(my call)*. Every existing
     Guru project uses the hand-written client, and refusing their next publish
     would hold an unrelated change hostage. The project chat offers the
     migration instead.
   - **Typed replacements must exist before the guard turns on** for what the
     skills use through pointers today:
     - **theme:** `valu.theme`. Embedded, it follows the host push. Dedicated,
       it reads the user's Valu theme setting through Valu Guru, falling back
       to `prefers-color-scheme`.
     - **network:** `valu.network` (§4.3).
     - **app header:** embedded only; dedicated returns `not_available`, and
       the app draws its own.
6. **Timing.** The new skills ship only after the valu-api release, the Valu
   Guru app endpoint and Valu Social's permission checks are live.
7. **Later, not in this project.** The bridge accepts only valu-api's versioned
   handshake.

### 4.10 Human docs

The Developer Portal SDK articles, the valu-docs Intent Explorer, and
valu-api's README and `docs/` all switch to valu-api only (decided).

## 5. For the master-server team

1. **M2, the safe form.** A server-to-server exchange: Valu Guru, authenticated
   with its own client credentials, presents a user's sign-in token (an
   `id_token` or access token from an app's OIDC client) and receives a Roomful
   session for that user. The session is usable only by Valu Guru, and ideally
   is separate per (user, app) and revocable. The provider already advertises
   `urn:ietf:params:oauth:grant-type:jwt-bearer`. Apps must never be able to
   call this.
2. **M1.** Is `sub` the Roomful user id in both the master identity token and
   the `connect.roomful.net` id_token?
3. **Identity-token audience.** Does `appManifest:getIdentityToken` re-derive
   the app from the connection, or trust the `applicationId` param?
   - The bridge path stamps it, so embedded apps are fine either way.
   - If the master trusts the param, a signed-in user can mint a token naming
     any app. That only lets them act as themselves through that app's grants,
     but the team should know (see the note in `src/app-api/token.ts`).
4. **M4, network.** Which network does a dedicated app's session belong to, and
   can the authorization request carry a `networkId`?
5. **Popup sign-in state.** Confirm that pages on `auth.<brand>` stay signed in
   after a sign-in, since `AuthStore` sets the session there.
6. **Embedded token audience form.** Valu Social will ask
   `appManifest:getIdentityToken` for `aud` = `{workspace}/{slug}` for
   Guru-built apps (§4.3). Is that value accepted?
7. **Optional.** A way to resolve an `authRequestID` to its OIDC client, so the
   sign-in page itself could show the app's name and requested permissions.
   Not needed for v1: §4.5 uses a consent page after sign-in instead.
8. **Client id → application.** A call (for Valu Guru) that returns the
   application id for an OIDC `clientId`, so Developer Portal apps, whose
   clients Valu Guru did not create, can be identified.

## 6. Constraints

- **Valu Guru:** a push to `main` deploys production, and timestamped
  migrations apply automatically.
- **Skills:** they are DB rows plus byte-identical in-code fallbacks plus
  migrations. `upsert_skill` caps instructions at 20,000 characters.
- **valu-api runtimes:** it must keep working in Node, because Valu Guru
  imports it. socket.io-client stays injected, never a dependency. The Valu
  Guru client uses the platform `WebSocket`.
- **valu-api's own rule:** "no third-party app gets a socket before server-side
  enforcement" (`docs/authorization.md`). This design *is* that enforcement, so
  dedicated mode must not ship ahead of §4.5.

## 7. Order of work *(my call)*

Each phase can be tested on its own.

0. **Questions.** Send §5 to the master team. Verify M1 with one real sign-in.
1. **Valu Guru app endpoint, embedded identity only.**
   - Server: grants, enforcement, audit, allow-list, using the interim session.
   - valu-api: the Valu Guru client and mode detection.
   - Result: embedded apps work end to end through Valu Guru.
2. **Valu Social.**
   - Consent dialogs and permissions for the bridge's UI intents.
   - The "Connected apps" settings.
   - Confirmation pages and the My Cart URL.
3. **Dedicated mode.**
   - The app endpoint accepts sign-in id_tokens.
   - valu-api: popups and `getToken()`.
   - Move from the interim session to the master exchange when M2 lands.
4. **Claude Code and docs.** Template, skills, publish guard, human docs.
5. **Later.** The bridge accepts only valu-api's handshake.

A conformance suite runs every valu-api function against both modes from
phase 1 onward.

## 8. Left to the builder

- The app endpoint's path and message envelope (reusing the
  `data_request` / `data_response` shape is fine).
- Table names, the consent and "Connected apps" UI, and the detection timeout.
- The exact scope names for `valuguru.*` ops and their tiers within §4.5's rule.
- How valu-api packages popup handling.
- Test harnesses.

## 9. Decisions (2026-10-19)

| Decision | By |
|---|---|
| One API for both modes; embedded keeps native UI through the bridge | Pavlo |
| Safe from the start: no session in apps; server-side permission checks | Pavlo |
| How Roomful calls reach the master: one connection through Valu Guru, or a second direct connection from the app | **open**: Pavlo expects two connections, and §4.1 / §4.4 assume one. To settle before building |
| Three risk tiers (basic / consent / forbidden) | Pavlo |
| Which apps: Workspaces and Developer Portal; internal apps unchanged | Pavlo |
| The same permission model in both modes | Pavlo |
| Already-published apps: ask permission on first use | Pavlo |
| Data through Valu Guru in both modes; bridge for UI only (option "B") | Pavlo |
| Human docs switch to valu-api only | Pavlo |
| Interim session, tier assignment, `not_available` list, phase order, id_token handed to the page | my calls |
| Canonical app identity (`{workspace}/{slug}`), separate grants for test builds, unchanged data keys | my calls (from the builder check) |
| Network: user's current (embedded) / app's home network (dedicated); `network_mismatch` | my calls (from the builder check) |
| Embedded confirmations through Valu Guru too; Valu Social only draws the dialog | my call (from the builder check) |
| Dedicated consent by redirect right after sign-in, on `auth.<brand>` | my call (from the builder check) |
| Publish guard only for new-template projects; typed `valu.theme` / `valu.network` first | my calls (from the builder check) |
