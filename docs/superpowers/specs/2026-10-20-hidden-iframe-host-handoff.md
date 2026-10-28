# Handoff: the hidden-iframe valu-api host

**Date:** 2026-10-20 · **From:** the design session with Pavlo (2026-10-19 → 10-20)
· **For:** the session that builds it · **Status:** approach decided by Pavlo, the
dev team and the lead. Nothing is built yet.

This file is self-contained. It supersedes the architecture in
`2026-10-19-dedicated-mode-design.md`, which sits in the same folder.
- What changes: that document routed app data through a new Valu Guru
  endpoint.
- What still holds from it: its permission model, its scope decisions and its
  §3 table of verified facts.

---

## 0. Before you start

**Sign-in.** You cannot type passwords or complete SSO. Anything that needs a
real signed-in browser (the login popup, a real session in the iframe) needs
Pavlo. Ask for it up front, at the start of a working block.

**Repositories** (all local):

| Repo | Path | Notes |
|---|---|---|
| valu-api (`@arkeytyp/valu-api`) | `/Library/Git/valu-api` | `main` = `8d4a5e9` (feat/embedded-commerce-parity was merged 2026-10-19). Unpublished `2.0.0`; consumers pin commits. |
| Valu Social web | `/Library/Git/valusocial-web` | Branch `develop`; a push auto-deploys the DEV web (`dev_deploy.yml`). The production web is a manual `prod_deploy.yml` dispatch. Dev server: `http://localhost:3005`, usually already running and signed in. |
| Valu Guru server | `/Library/Git/valu-guru-latest` (GitHub `Roomful/valu-guru-server`) | **A push to `main` deploys production**, and timestamped migrations auto-apply. Check what's live with `curl https://valuguru.texpo.io/version`. |
| Master API docs | `Roomful/valu-docs` → `docs/apidocs/*.md` | The master server's own code is not available to us. |

**Shared checkouts.**
- Other Claude sessions work in these repos at the same time.
- Use worktrees under `<repo>/.claude/worktrees/`, which is git-excluded.
- Never switch a shared checkout's branch.
- Rebase feature branches; never merge the base into them.

**Ask before:** pushing to `develop` or `main`, deploying, or writing to a
production database.

**Pavlo's memory notes** (`~/.claude/projects/-Users-pavelklym/memory/`)
cover:
- running and inspecting the web app, in `valu-web-repo.md`;
- database access rules, in `valu-guru-db-access.md`;
- published-site URLs, in `valu-site-publishing.md`;
- the Sign in with Valu test apps, in `sign-in-with-valu-test-apps.md`.

---

## 1. Goal

Every app built in Workspaces installs `@arkeytyp/valu-api`. Today those apps
call the platform over the postMessage intent bridge, so they only work while
framed inside Valu Social.

The goal:
- **One API, valu-api, that works the same** whether an app is
  - framed in Valu Social, or
  - opened on its own host (`https://<slug>-ws-<ws>.valuguru.app/` or a
    custom domain).
- **Claude Code (the Guru project worker) learns valu-api only.** The bridge
  vocabulary disappears from what it is taught, so generated apps stop
  hand-writing bridge clients.

**How (decided 2026-10-20):**
- valu-api inside an app page loads a **hidden iframe on a Valu origin**, "the
  host".
- The host holds the user's session, opens the sockets, checks permissions and
  serves the API.
- The app page can never read the session: the browser's same-origin policy
  keeps it inside the iframe.

---

## 2. Decisions (final unless marked)

| # | Decision | By |
|---|---|---|
| D1 | The hidden iframe on a Valu origin is the valu-api provider for apps. | Pavlo + dev team + lead, 2026-10-20 |
| D2 | The host is **built from scratch from core services, in this order: socket → security → auth → intent bridge with permissions → API services**. It is *not* a cut-down Valu Social UI build. | same |
| D3 | Existing services may be reused only if they **do not touch UI apps, UI stores or anything that slows the host down**. | same |
| D4 | Scope: apps built in Workspaces (the main case) **and** Developer Portal apps. Valu's own internal apps (LLM Debug and similar) stay as they are. | Pavlo |
| D5 | **Three permission tiers**, which the host enforces: basic (granted with sign-in), consent (the user agrees), forbidden to apps. | Pavlo |
| D6 | Apps that declare nothing (all already-published apps) are asked for each permission **on first use**; they need no republish. | Pavlo |
| D7 | The same permission model in every mode. | Pavlo |
| D8 | Dangerous actions (Commerce seller dialogs, rating, deleting) and checkout run in a **popup on a Valu origin**, never inside the iframe (clickjacking). | design; agreed |
| D9 | valu-api's own answer shapes (`{users}`, `{policies}`, …) are the contract for apps. Valu Social keeps its old intent shapes for raw-bridge apps and for its AI tools. | Pavlo |
| D10 | Claude learns only valu-api: a starter template with valu-api pinned, rewritten skills, and a publish guard (only for new-template projects; old ones are exempt until migrated). **Human docs** (Developer Portal, the valu-docs Intent Explorer) also switch to valu-api only. | Pavlo |
| D11 | Already-published raw-bridge apps keep working: Valu Social keeps serving their intents. | Pavlo |
| D12 | **Dropped** along with the old design: the Valu Guru app endpoint, the master-team asks (session exchange "M2", the `sub` question, the identity-token `aud`), and using "Sign in with Valu" for platform access. | follows from D1 |

### Settle these with Pavlo first (my recommendation in bold)

1. **Where the host code lives and is served.**
   - **Recommended:** a new entry in valusocial-web (`src/host/`, plus a
     `host.html` added to Vite `rollupOptions.input`, `vite.config.js:332`).
     That lets it import the few reusable modules directly and ship with the
     web deploy. Add a lint rule that forbids imports from React, JSX,
     `src/Applications`, `src/Components`, `src/Stores/*` (except named pure
     ones), `virtual:pwa-register`, Unity, LiveKit and Videochat.
   - Alternative: a separate package or repo.
   - Either way the host gets **its own small bundle**. Valu Social's start-up
     JS is about 2.9 MB raw / 0.85 MB compressed, and the browser's HTTP cache
     is partitioned per site too, so every app would pay for it again.
2. **Serving origin.** It must be a Valu origin, with `frame-ancestors` limited
   to app hosts (§4.2): for example `https://auth.texpo.io/host.html` or a
   dedicated subdomain. The host's `init.client` network resolution depends on
   the origin and referer (§4.3).
3. **Embedded mode.** Do apps *inside* Valu Social also use the host for data?
   - **Recommended: yes.** That gives one implementation and one permission
     check. Valu Social's bridge then serves only UI (docks, pickers, theme,
     routes) and hands the nested host a one-time token, so it has a session.
   - This matches "hidden iframe as valu-api that will provide all API for
     apps".
   - Inside Valu Social the nested host's storage is partitioned too (Chrome's
     "ancestor bit"), so the handoff is needed.
4. **Origin → app identity source.**
   - **Workspaces apps:** Valu Guru knows host → project (`{slug}-ws-{ws}`,
     custom domains via `valuguru.workspaces.projects.domains.*`) and the
     project's `dev_app_id`.
   - **Developer Portal apps:** their registered URL on the master app record.
   - The host needs a lookup it can call **without trusting the app**.
   - **Recommended:** a public read-only Valu Guru endpoint that takes a host
     and returns `{appId, devAppId, workspace, slug}`.
5. **Where grants live.** **Recommended:** Valu Guru's DB, one row per
   (user, app, scope, granted_at, revoked_at), read and written by the host
   over its Valu Guru socket. Valu Social shows the "Connected apps" list and
   revocation.
6. **Network.** **Recommended:**
   - embedded → the user's current network;
   - dedicated → the app's home network (its workspace's), with
     `network_mismatch` when the session is in another network.

---

## 3. Architecture

```
app page (any host: *.valuguru.app / custom / Valu Social frame)
  └─ valu-api client ──postMessage──▶ hidden <iframe src="https://<valu-origin>/host.html">
                                        ├─ socket core: Roomful master socket + Valu Guru socket
                                        ├─ security:   frame-ancestors, origin→app, parent-only messages
                                        ├─ auth:       session in (partitioned) storage, login via popup handoff
                                        ├─ bridge:     api:ready / api:service-intent / pushes, permission checks
                                        └─ API services: valu-api SDK functions + Valu Guru ops (Commerce …)
  popups on a Valu origin: sign-in · consent · dangerous-action confirm · checkout (My Cart)
```

### 3.1 Socket core

**Roomful (master) socket.** Reuse valu-api's `ValuSocketConnection` ("door 2",
`src/socket/ValuSocketConnection.js`). It already does:
- `POST https://api.roomful.net/api/v0/publicRpc/init.client` with `X-Session-Id`;
- socket.io to `wss://<host>?sessionId=…` (path `/socket`, websocket only);
- waits for the `user_info` push to know the user and network;
- reconnects (retrying for 120s before declaring the connection lost) and
  redacts the session from logs.

Inject `socket.io-client` **2.5.0**, the version Valu Social pins; valu-api has
no socket.io dependency on purpose.

**Valu Guru socket.** Write a small client, modelled only on the connect path of
`valusocial-web/src/Services/AiGuru/AiGuruService.js`:
- `connect` / `#openConnection` at ~778–870;
- `#buildConnectUrl` at ~965;
- `request()` at ~2473–2530.

The protocol:
1. Mint `POST https://api.roomful.net/api/v1/auth/getOneTimeAuthToken` with
   `X-Session-Id`. CORS allows any origin, `x-session-id` included (verified).
2. Open `wss://valuguru.texpo.io/?token=<oneTime>`.
   - This is the production API host. `valuguru.app` serves published sites,
     and its `/version` answers 404.
3. Send `{type:'data_request', requestId, op, params, networkId}`, receive
   `data_response`, cancel with `data_cancel`.
4. **Tokens are single-use: mint a new one on every reconnect.**

The server checks only the token at upgrade (`connection-auth.ts`) and needs no
`register_tools` before `data_request` (`index.ts` `case "data_request"`).

**Do not use `AiGuruStore`.** It is 7.6k lines, configures the service through
UI state, and carries chat and run logic the host does not need.

**Side effect to know.** Each Valu Guru connection overwrites the user's stored
session token in `vg_session_tokens` (`index.ts` ~5001). That's harmless with
the same session; with a different one, the user's server agents switch to it.

### 3.2 Security

**Frame policy.**
- Serve the host page with `Content-Security-Policy: frame-ancestors` listing
  only app hosts: `https://*.valuguru.app`, plus verified custom domains and
  Developer Portal app domains.
- Today `auth.texpo.io` and `valu.social` send **no** `frame-ancestors` or
  `X-Frame-Options` (checked 2026-10-19), while `web.texpo.io` does.
- Separate finding: Valu's **login page can currently be framed by anyone**, a
  clickjacking risk worth its own fix.

**Messages.**
- Accept messages **only** from `window.parent`.
- Read `event.origin`, map it to an app (§2 Q4), and reply with
  `targetOrigin` = that origin.
- **App identity never comes from message params.** Valu Social today stamps
  `intent.senderApplicationId` in the same way (`ApplicationCenterStore.js`
  `#onApplicationIntent` ~161–189).

**Never** put the session, a one-time token or any credential in a message to
the parent. valu-api has `assertNoCredentialLeak` (`src/auth/TokenStore.js`)
and a redaction helper.

**Clicks on Valu UI happen in popups, never in the iframe.** Popups must be
opened by the app page on a user click: a cross-origin iframe does not receive
the parent's user activation.

**Per-app rate limits and an audit log** (who, which app, what, when): v1 if
cheap, otherwise soon after.

### 3.3 Auth

**Where the session is.**
- Valu Social stores the Roomful `sessionId` as base64 JSON in `localStorage`
  key `session` on its origin (`ApplicationStore.setSession`, ~1092–1100).
- Auth is header-based (`X-Session-Id`), so cookies are not needed.

**The core problem.** In a third-party iframe, `localStorage` and IndexedDB are
**partitioned by top-level site**: Chrome 115+, and Safari (whose limits are
stricter). The user's normal Valu login is invisible to the host, so the host
must obtain its own session per app site.

**Login flow to prototype first:**
1. The app calls `valu.signIn()` from a click.
2. valu-api opens a popup on a Valu origin, which is first-party, so a user
   already signed in to Valu passes straight through.
3. The popup mints a one-time token with its own session.
4. The popup posts the token **to the host iframe only**:
   `window.opener.frames[i].postMessage(token, '<valu-origin>')`. It is never
   sent to the app page.
5. The host redeems it with
   `POST https://api.roomful.net/api/v1/auth/checkOneTimeAuthToken/{token}`,
   which returns `{user_id, session_token}` (Valu Guru calls it with an empty
   body and no credential). **Verify CORS for that call from a browser.**
6. The host stores the session in its partitioned storage.

**Alternative:** the Storage Access API. `requestStorageAccess()` needs a click
*inside* the iframe, and Safari historically granted only cookies, not
`localStorage`.

**Expiry.** `WebSocket.connect`'s `auth/check` → 401 means the host clears the
session and asks valu-api to show sign-in again.

**Network quirk.** `init.client` sends `referer`. When the host is framed,
Valu Social's version sends the **parent** origin (`ApplicationStore.js:855`),
which may resolve a different network. Check this in the prototype.

**Not used:** "Sign in with Valu" (OIDC). It returns only `access_token`,
`expires_in`, `id_token`, `scope` and `token_type`: no session and no refresh
token. This was verified from the "My Profile" sign-in log (§6).

### 3.4 Intent bridge with permissions

**Protocol.** Keep the message names valu-api already speaks, so valu-api treats
the host like Valu Social:
- the `api:ready` handshake (with the start intent);
- `api:service-intent` `{applicationId, action, params, requestId}`, answered
  with the reply;
- pushes: `api:trigger`, `api:new-intent`, `api:color-scheme`, and Commerce
  events (`ValuApi.ON_COMMERCE`).

References: `valusocial-web/src/Stores/IFrame/IFrameStore.js` (listener ~212,
cases ~228–288) and `valu-api/src/transport/PostMessageTransport.js`.

**App identity.**
- The canonical id is `{workspace}/{slug}`, the App API address form, because
  slugs are unique only within a workspace (`testingCatalogue.js`; test builds
  are `slug--dev` / `slug--review`).
- Test builds get their **own** grants.
- **Data keys stay as today.** Commerce `appId`, the CMS/ApplicationStorage
  belonging `app:{id}:…`, and CMS's lookup of the Developer Portal id via
  `findApplicationById(sender).devId` must keep receiving the strings they get
  now. Map canonical → the existing stamped id.

**Deny by default.**
- Every action must be on an allow-list, and its scope must be granted.
- Scopes come from valu-api's descriptors (30 today): `users:read|write`,
  `rooms:read|write`, `textchat:read|write`, `groups:read|write`,
  `events:read|write`, `community:read`, `cbac:read|write`,
  `profile:read`, `networks:read`, `resources:read`, `time:read`,
  `http:read|write`, `cms:read|write`, `applicationstorage:read|write`,
  `developer:read|write`, `veruswallet:read|write`.
- Add scopes for Valu Guru ops: `commerce:read`, `commerce:write`,
  `commerce:sell`.

**Tiers** (D5; the assignment is the design session's proposal):

| Tier | Scopes |
|---|---|
| Basic | `users:read`, `networks:read`, `time:read`, `resources:read` |
| Consent | `textchat:*`, `rooms:write`, `groups:write`, `events:write`, `commerce:*`, `community:read`, … |
| Forbidden | `veruswallet:write`, `cbac:write`, `developer:write` |

**Consent** (D6): a popup asks on first use; declared scopes can be asked once
after the first sign-in. Grants live where §2 Q5 decides.

**UI actions → popups.** About 25 of the ~136 intent actions need UI:
- **Commerce:** `checkout`, `open-cart`, `open-order`, `open-purchases`,
  `open-products`, `open-purchase-in-media`, `preview-purchase`,
  `rate-product`, `create-product` (with no `title`), and the nine seller
  consent actions: `set-donation-tiers`, `publish-product`, `unlist-product`,
  `archive-product`, `delete-product`, `set-sale`, `set-volume-tier`,
  `create-discount-code`, `update-discount-code`;
- **DataProvider:** `pick-single` / `pick-multiple`;
- **RoomPoints:** `create-room-point` / `edit-room-point`;
- **UnityDialog:** `open` / `close`;
- **Application:** `close_all`, `expand-application`, `close-application`.

How to handle them:
- **v1:** confirm dialogs and checkout open as popups (My Cart has only tab URLs
  today, `/cart`, `/cart/orders`, `/cart/purchased`, so it needs an entry for
  "this app's rows + promo").
- Pickers, RoomPoints, Unity and docks answer `not_available` outside Valu
  Social.
- **Trap:** without a rendered `ModalRender`, `ModalStore.openModal` never
  resolves (`intents/consent.js:49-81`), so do not reuse `ModalStore` in the
  host.

**Commerce pushes.** In Valu Social they route through `applicationsContext`
and are **dropped silently** for non-dockable apps (`commerceEvents.js:150-160`).
The host must route pushes to its parent itself.

### 3.5 API services

- **Roomful functions:** use **valu-api's own service SDK**, 65 functions that
  are UI-free and conformance-tested. Call
  `createValuServices({ socket, appState, config, fetchImpl })` over the host's
  `ValuSocketConnection`. Valu Guru already does exactly this
  (`valu-guru-latest/src/valu-tools/sdk.ts`).
  - Prefer `cache: null` or invalidate carefully.
  - The 3 `app-state` functions (Developer list/create, VerusWallet balance)
    need a host-supplied `AppState`, or stay forbidden or not available.
- **Valu Guru ops (Commerce and others):** follow
  `valusocial-web/src/Services/Commerce/CommerceDataService.js` (about 70
  `valuguru.commerce.*` op references; it only wraps `AiGuruService.request`).
  - Take the op mapping, not `CommerceService`, which imports
    `CreateProductModal.jsx` (`CommerceService.js:20`) and depends on
    `ModalStore`, `ApplicationCenter` and the Merchant/Cart stores.
- **Reuse rule (D3).**
  - Pure modules (data mappers, validators, op tables) are fine.
  - **Forbidden:** React/JSX, `ModalStore`, `ApplicationCenterStore`,
    `Router` (its pipeline docks apps and may redirect to `/auth`; 21 store
    constructors call `router` unguarded), any `src/Applications/*` store,
    `virtual:pwa-register` (`ApplicationStore.js:1` imports it), Unity,
    LiveKit and Videochat.
  - Valu Social's `ApplicationStore` creates every store and service at boot,
    which is exactly what the host must not do.
- **Intent inventory** (from a code map, 2026-10-20): 27 services with
  `onNewIntent`, about 136 actions. About 108 are pure data: Rooms 15, Users 8,
  Cbac 5, Resource 5, RoomZones 5, Community 4, Groups 4, AiGuru 3, Events 3,
  TextChat 3, Http 3, CMS 3, AppStorage 3, …, plus about 30 Commerce data
  actions.

---

## 4. Build order (D2) and first milestone

0. **Throwaway prototype, 1–2 days. Do this first: it can kill the approach.**
   - Build a host page with only the socket core and auth: popup login →
     one-time-token handoff → `valu.Users.current()` over the master socket,
     plus one Valu Guru op, e.g. `valuguru.commerce.cart.get`.
   - Run it from a test app on `*.valuguru.app`. Either create a Workspaces
     project, or temporarily add a script to a test project; ask Pavlo.
   - Test in **Chrome**, **Safari macOS** and **iOS Safari**. The iOS 26.4 /
     27.0 simulators exist on this Mac; Playwright's WebKit is also available.
   - Record:
     - whether the session survives a reload;
     - whether Safari keeps it, and for how long;
     - popup blocking;
     - which network `init.client` resolves.
1. **Socket core.** `ValuSocketConnection` with the injected socket.io, plus the
   new Valu Guru client with re-mint on reconnect. Unit tests with fake sockets
   (valu-api has fakes in `test/helpers/fakes.js`).
2. **Security.** Serving origin, `frame-ancestors`, parent-only messages,
   origin → app lookup.
3. **Auth.** Production login popup, storage, expiry, logout.
4. **Bridge + permissions.** Allow-list, scopes, tiers, grants store, first-use
   consent popup, audit.
5. **API services.** valu-api SDK functions → Commerce ops → the rest. Then
   the UI-action popups (confirm, checkout).
6. **valu-api client.**
   - Mode detection (`valu.mode`, override `?valu-mode=dedicated`).
   - Inject the iframe, handshake, `signIn()`, a popup helper with a user-gesture
     fallback.
   - Typed `valu.network` / `valu.theme`.
   - A conformance suite that runs every function through the host.
7. **Embedded switch,** if §2 Q3 = yes.
8. **Claude and docs** (D10): template repo, skills rewrite (database rows plus
   in-code fallbacks plus migrations; `upsert_skill` caps at 20k characters),
   publish guard, human docs.

Rough size with Claude implementing: prototype 1–2 days; v1 about 2–3 weeks
calendar (1.5–2 with parallel sessions per repo). Waiting on sign-ins, deploys
and reviews dominates.

---

## 5. Prior art (researched 2026-10-20)

- **Privy (embedded wallets).**
  - Isolates secrets in an iframe on its own domain.
  - Admins set the allowed `frame-ancestors`.
  - The iframe accepts messages **only from its parent**.
  - It has since moved its default to server-side TEEs.
  - Source: [Privy security](https://docs.privy.io/guide/security/),
    [user device](https://docs.privy.io/security/wallet-infrastructure/advanced/user-device).
- **Stripe Connect embedded components.**
  - Stripe-origin iframes get a **scoped, short-lived** Account Session (which
    components and features are enabled), not a full session.
  - Worth copying if the master ever offers restricted sessions.
  - Source: [Account Sessions](https://docs.stripe.com/api/account_sessions).
- **Auth0 silent auth and old Google Sign-In:** their hidden iframes **broke**
  under ITP and third-party-storage blocking.
  - Source: [Auth0 + ITP](https://support.auth0.com/center/s/article/troubleshoot-auth0-token-renewal-issues-in-safari-with-itp-enabled),
    [FedCM](https://developer.chrome.com/docs/identity/fedcm/overview).
  - That is why the prototype comes first.
- **Atlassian Forge `requestJira` and monday `monday.api`:** the host makes the
  call on the user's behalf, limited by the app's manifest scopes. This is the
  same model as our bridge plus permissions.
  - Source: [Forge](https://developer.atlassian.com/platform/forge/custom-ui-bridge/requestJira),
    [monday SDK](https://developer.monday.com/apps/docs/introduction-to-the-sdk).
- **Storage partitioning:** [Chrome](https://privacysandbox.google.com/cookies/storage-partitioning),
  [Storage Access API](https://privacysandbox.google.com/3pcd/storage-access-api),
  [WebKit](https://www.webkit.org/blog/8124/introducing-storage-access-api).

---

## 6. Verified facts and where to look

| Fact | Where / how |
|---|---|
| valu-api's socket layer: two doors (adopt, or `sessionId`), the `ValuSocket` contract (`emit` never rejects), retries only for reads, cache cleared on writes and reconnects | `valu-api/src/socket/*`, `src/services/ServiceClient.js`, `src/CallPolicy.js`, `docs/connecting.md` |
| `AuthProvider.handshake()` is never called by socket code; scopes are client-side and advisory today | `valu-api/src/auth/AuthProvider.js`, `docs/authorization.md` |
| The master accepts any origin for `getOneTimeAuthToken`, `init.client` and `signin` (`access-control-allow-origin: *`); the socket refuses only a missing session (401) | probes, 2026-10-19 |
| Valu Guru's WS upgrade has no origin check; a bogus token gets 401 | probe; `connection-auth.ts` |
| The only master server-to-server API is `partnerRpc`, which is narrow (user and room info, permission checks, resources). The master socket takes only `sessionId` | valu-docs `docs/apidocs/partner_*.md`, `websocket*.md` |
| Live Sign in with Valu test apps: `https://my-profile-ws-7a07b7b5.valuguru.app/`, `https://github-analytics-ws-7a07b7b5.valuguru.app/` (workspace "Hebrew Lab" `ws_7a07b7b5`; Pavlo is a developer there) | memory `sign-in-with-valu-test-apps.md` |
| Reading a project's source or tables from the signed-in `:3005` page | `application.services.AiGuru.request('valuguru.workspaces.projects.repository.archive', {projectId})` returns a short-lived download URL; `…projects.database.rows` reads tables (needs the developer role) |
| Valu Social boot: `ApplicationStore` is created at render time, but its constructor is plain JS. The service-intent path runs without React, as `ApplicationCenterStore.serviceIntent.test.js` proves | valusocial-web |

---

## 7. Related, not part of this task

- **Proposed session, not started:** "Check framed apps can't call
  VerusWallet.transfer" (task `task_924f3458`). Today nothing seems to stop a
  framed app from running `VerusWallet.transfer` with no dialog: there is no
  per-app allow-list and `availability` isn't checked
  (`src/Services/AiGuru/VerusWalletService.js`).
- **Clickjacking:** Valu's login page can be framed by anyone (§3.2).
- **Superseded:** `2026-10-19-dedicated-mode-design.md`, which used a Valu Guru
  endpoint. Its builder-check calls (canonical app id, network, consent after
  sign-in, publish guard only for new projects) carry over unchanged.
