# valu-api host core — design

**Date:** 2026-10-20 · **Status:** decided with Pavlo on 2026-10-20, ready for
the implementation plan · **Author:** the spec session, from the handoff
`2026-10-20-hidden-iframe-host-handoff.md` (same folder) and a read-only
verification of the three repos on 2026-10-20.

- The handoff's decisions **D1–D12 stand** and are not repeated.
- This document **replaces the handoff's §3 (architecture) and §4 (build order)
  for the core** and settles its §2 questions Q1–Q6 (see §9). Where the code
  contradicts the handoff, this document is right and §3 says why.
- Calls made here rather than by Pavlo are marked **(my call)**. Questions only
  Pavlo can answer are in §9.3.
- **Amended 2026-10-21**, after the overnight implementation: a sentence changed
  in place carries **(2026-10-21)**, and §11 lists each ruling with the section
  it amends.

---

## 1. Intent

Apps built in Workspaces install `@arkeytyp/valu-api`. Today they work only
while framed inside Valu Social, because the platform reaches them over the
postMessage bridge. The handoff decided (D1) that on an app's own host
(`https://<slug>-ws-<ws>.valuguru.app/`) valu-api loads a **hidden iframe on a
Valu origin, "the host"**, which holds the user's session, opens the sockets,
checks permissions and serves the API. The app page never sees a credential.

**The core** is the smallest complete and safe path through that design:

> An app on its own `*.valuguru.app` host signs the user in with one click,
> then calls valu-api's service functions and the Commerce data intents, and
> every call is identified by origin, checked against what the user granted
> that app, and answered in valu-api's shapes.

Everything visual stays out of the iframe: the core has exactly two popups,
sign-in and consent. Dangerous actions and checkout are a later milestone.

**Target state (Pavlo, 2026-10-20).** The core is the first step towards
this: **every new app uses valu-api only, in both modes**, and never the
intent bridge directly. Claude Code (the Guru project worker) is railed to
valu-api through the template, the skills and the publish guard, and the
human developer docs say the same. Already-published apps are not migrated
and keep working as they are (D11). valu-api, as the API provider every app
depends on, must survive socket drops, disconnects and reconnects without
the app noticing more than a delay (§4.11). The milestones after the core
(M8–M10, §5) get there.

## 2. Scope

**In the core**

| Area | What |
|---|---|
| Host, socket core | Master socket through valu-api's `ValuSocketConnection` with socket.io-client 2.5.0 injected; a new small Valu Guru client (one-time token per connect). |
| Host, security | Parent-only messages bound to one origin, origin → app lookup, nesting rule, `frame-ancestors`, credentials never leave the iframe. |
| Host, auth | Sign-in popup on a Valu origin → one-time-token handoff to the iframe → session in the iframe's own storage; validation, expiry, sign-out. |
| Host, bridge + permissions | valu-api's wire protocol plus three host messages; allow-list of 54 socket service functions + 30 Commerce data intents + identity token + Commerce events; 27 + 4 scopes in three tiers; grants in Valu Guru; first-use consent popup. |
| Host, API services | valu-api's own service SDK over the host's socket; Commerce data intents mapped to `valuguru.commerce.*` ops. |
| valu-api client | Dedicated mode: iframe injection and handshake, `signIn` / `signOut` / consent, auth state, `valu.network`, hardening of the existing bridge transport. |
| Valu Guru server | Resolve endpoint (origin → app), grants table and ops, a `client=host` connection flag, static serving of the host page with headers. |
| valusocial-web | One Auth-app page, `/auth/host`: the sign-in handoff. |
| Tests | Unit tests with valu-api's fakes, the conformance suite run through the host, a manual cross-browser matrix. |
| Milestone 0 | A throwaway prototype that can kill the approach (§6), before anything else. |

**Out of the core, planned as follow-on milestones** (§5, M8–M10): embedded
mode through the host (handoff Q3) with Valu Social's permission checks and
the "Connected apps" settings; the Claude template, skills, publish guard and
human docs (D10) with the typed surfaces they need (`valu.theme`,
`valu.Commerce.*`); UI-action popups for dedicated mode (checkout, the nine
seller dialogs, rating). **Not planned:** Developer Portal apps,
customer-owned domains, migrating already-published apps, a server-side audit
log and rate limits.

**Non-goals and anti-goals** are the handoff's. Two are load-bearing here:
no path on which app code can obtain a session or a one-time token, and no
generic "run any RPC" pass-through.

## 3. What the review found (handoff corrections)

Verified on 2026-10-20 against `valu-api` main `8d4a5e9`, `valusocial-web`
(read as-is) and `valu-guru-latest` main `eaa471e` plus `origin/main`.

| Handoff says | What is true | Effect on the core |
|---|---|---|
| Pushes include `api:color-scheme`; Commerce events are a separate push | Valu Social sends `api:color-scheme` from `IframeComponentLoader.jsx`, but the valu-api client **ignores** it. Commerce events are `api:trigger` with `action: 'commerce'`. | The host sends `api:trigger` for Commerce; no colour-scheme message in the core. |
| `api:service-intent` is "answered with the reply" | The reply is named **`api:run-console-completed`**, with `requestId` at the top level of the envelope and the same number the request carried. | §4.5 fixes the envelope. |
| 30 scopes | **27**, derived mechanically as `<service>:<read\|write>`. No `commerce:*` scope exists. | §4.6 adds `commerce:read\|write\|sell` and `application:identity`. |
| `ValuSocketConnection` retries for 120 s then declares the connection lost | socket.io does the reconnecting with no attempt cap; valu-api only arms a 120 s watchdog that **notifies**. Once `failed` the object never recovers and never closes the socket; a reconnect that never receives `user_info` stays `reconnecting` forever; `connect()` rejection is sticky. | §4.2 wraps it with a replace-on-failure rule. |
| "Valu Guru already does exactly this" with `createValuServices` | Valu Guru adopts its own Node connection (`{socket}` door), never `ValuSocketConnection`. **No production consumer of the `{sessionId}` door exists**; it is tested only against fakes. | M0 must prove it against the real master. |
| `createValuServices({ socket, appState, config, fetchImpl })` | Also needs `applicationId` (ApplicationStorage answers 403 without it; CMS builds `app:null:…`), `cache: null` (cache is on by default), and `config.webBase` (defaults to the iframe's own origin). | §4.7. |
| Accept only from `window.parent`, reply with `targetOrigin` | The valu-api client today checks **nothing** about the sender: the last `api:ready` wins and redirects all traffic to its `event.source`/`event.origin`. Valu Social checks `event.origin` only and replies with `'*'`. | §4.8 hardens the client; the host is strict from day one. |
| `init.client` referer quirk: Valu Social sends the parent origin | valu-api's door sends body `{domainName: <apiHost>, origin: https://<apiHost>, referer: ''}` and never the page origin; whatever it resolves is **overridden by `user_info`**. | The host switches the session into the app's home network itself (§4.4). |
| "Verify CORS for `checkOneTimeAuthToken`" | Verified: preflight 204 and `access-control-allow-origin: *`. The master answers **HTTP 200 even for a bad token**; the verdict is `error.status`. | §4.4. |
| valu-api has a redaction helper; `assertNoCredentialLeak` guards the call path | No exported helper. `assertNoCredentialLeak` is called only by `AuthProvider.handshake` and `TokenStore.set`, and its key list lacks `session_token`, `token`, `x-session-id`. | The host owns its own leak guard (§4.3). |
| Custom domains via `valuguru.workspaces.projects.domains.*` | Those ops manage **pretty sub-domains `{slug}.valuguru.app` only**, with no table: the Sites Publisher's domain list is the record. No customer-owned domains exist. | `frame-ancestors` is `https://*.valuguru.app`; the resolve endpoint reads the publisher's list. |
| Origin → app: "Valu Guru knows host → project" | Nothing maps a host to a project today, neither an HTTP route nor an op. `parseSiteHost` (grammar only) and `resolveWorkspaceApi(workspace, slug)` exist as building blocks. | New endpoint, §4.9. |
| Valu Guru needs no `register_tools` before `data_request` | True on the server. The web client nevertheless waits for `tools_registered`; the host must not copy that. | §4.2. |
| Each Guru connection overwrites `vg_session_tokens` | True, and also: closing any socket may close the user's pooled Roomful connection when idle. | A `client=host` flag on the server skips both (§4.9). |
| Playwright's WebKit is available | Only Chromium is installed. iOS 26.4 and 27.0 simulators exist. | Safari tests run in Safari and the simulators. |
| `valuguru.app` site hosts are independent sites | `valuguru.app` is **not on the Public Suffix List**, so every `*.valuguru.app` app is one top-level site for storage partitioning. | One sign-in in the host covers all Workspaces apps in a browser (§4.4). |
| File paths | `ApplicationCenterStore.js` and `ApplicationStore.js` live under `src/Stores/ApplicationCenter/` and `src/Stores/Application/`; `consent.js` is `src/Services/Commerce/intents/consent.js`; `testingCatalogue.js` is under `src/Applications/DeveloperPortal/`. | — |

Also confirmed: the handoff's facts about the one-time-token protocol, the
`data_request` shapes, the `ModalStore` trap, the Commerce op mapping in
`CommerceDataService.js` (zero imports, 69 ops), socket.io-client pinned at
2.5.0, and that Valu Social's reusable pieces are `Intent.js`, `Application.js`,
`IntentPipeline.js`, `CommerceDataService.js` and `consent.js`; everything else
named in the handoff pulls a 600-module React graph.

## 4. Architecture

```
app page  https://<slug>-ws-<ws>.valuguru.app/            (top-level window)
  valu-api client, dedicated mode
    ├─ <iframe hidden src="https://<host-origin>/host/">   ── the host
    │     ├─ bridge:  host:hello → api:ready · api:call · api:service-intent · pushes
    │     ├─ guard:   parent-only, one bound origin, resolve(origin) → app, nesting rule
    │     ├─ auth:    session in the iframe's (partitioned) localStorage; token redeem
    │     ├─ perms:   allow-list · validateParams · scope tier · grants · consent
    │     ├─ master:  ValuSocketConnection {sessionId} + socket.io-client 2.5.0 → api.roomful.net
    │     ├─ guru:    GuruClient (WebSocket, one-time token per connect) → valuguru.texpo.io
    │     └─ sdk:     createValuServices({ socket, applicationId, cache: null, config })
    ├─ popup  sign-in  on a Valu origin (valusocial-web page) ──token──▶ host iframe only
    └─ popup  consent  on the host origin (part of the host bundle) ──decision──▶ host iframe only
```

### 4.1 Where the code lives and where it is served **(my call; handoff Q1/Q2. Pavlo had no preference on 2026-10-20, so this stands; the origin is configuration and can move.)**

- **Host logic lives in valu-api**, as framework-free ESM under `src/host/`:
  the bridge, guard, auth, permissions, the Guru client and the master-socket
  wrapper. Everything it reuses is already in valu-api (`ValuSocketConnection`,
  `createValuServices`, descriptors, `validateParams`, the fakes), the
  conformance suite can run end-to-end in one repo, and D3 (no UI stores) holds
  structurally instead of by lint rule. The only Valu Social pieces worth
  taking are `CommerceDataService.js` (a pure op table) and the consent
  wording; both are copied.
- **The host page and bundle are built and served by valu-guru-server** at
  `https://valuguru.texpo.io/host/`: a `host/` folder with `index.html` and a
  small esbuild entry that bundles `@arkeytyp/valu-api/src/host/*` with
  `socket.io-client@2.5.0`, which the server already depends on. Express serves
  it with the response headers in §4.3. Deploy is the server's normal
  push-to-main release.
  - Why not the handoff's recommendation (an entry in valusocial-web): nothing
    there is reusable without its React graph, the static host at 52.37.45.2
    has no header configuration in the repo, and the web deploy pipeline is
    unrelated to the server the host talks to.
  - Why not a dedicated sub-domain such as `host.valuguru.app`: it needs
    DevOps work and infrastructure we cannot read. It stays an option if M0
    shows third-party storage is too fragile (§7), since a same-site host
    would get first-party storage on every Workspaces app. It is also the
    structural fix for the shared-origin risk (§4.3, "Origin invariant"); a
    follow-up in the M8–M10 plan. **(2026-10-21)**
- **The origin is configuration**, read by the client from its options and by
  the sign-in page from its build config, so moving the host later is a
  constant change.
- **The sign-in page lives in valusocial-web** because it must run on the
  origin that holds the user's Valu sign-in (§4.4).

### 4.2 Socket core

**Master socket.** `src/host/MasterConnection.js` wraps valu-api's
`ValuSocketConnection` (`src/socket/ValuSocketConnection.js`), the
`{sessionId}` door:

- Construct with `{ sessionId, io, fetchImpl: fetch, host: 'api.roomful.net', onConnectionLost }`.
  `io` is the socket.io-client 2.5.0 factory passed in by the bundle; never let
  valu-api fall back to its dynamic import.
- The connection is ready on the `user_info` push; `selfUserId`, `networkId`,
  `user` and `network` come from it and are authoritative.
- **Replace-on-failure rule.** The wrapper owns one instance at a time.
  When `onConnectionLost` fires, when `connect()` rejects, or when state is
  `failed`, the wrapper calls `close()` on the instance and creates a fresh one
  on the next call that needs a socket. If `connect()` rejects because the
  session is refused (a `connect_error` that names 401, or `auth/check`
  answering 401 beforehand), the wrapper clears the session instead (§4.4).
  This covers the four edge cases found in the review (watchdog cleared on bare
  reconnect, sticky `failed`, sticky rejection, socket never closed).
- Never serialize or post `connection.transport`; it is the raw socket.io
  object and its URL contains the session.

**Valu Guru client.** `src/host/GuruClient.js`, a platform-`WebSocket` client
modelled on the connect path of `AiGuruService.js` and **nothing else** from
it:

1. Mint: `POST https://api.roomful.net/api/v1/auth/getOneTimeAuthToken`, headers
   `Content-Type: application/json`, `X-Session-Id`, `X-Network: <networkId>`
   when known, body `{}` → `data.token`.
2. Open `wss://valuguru.texpo.io/?token=<token>&client=host` (§4.9 for the
   flag). Tokens are single-use: **mint a new one on every connect attempt**.
3. Send only `{type:'data_request', requestId, op, params, networkId}` and
   `{type:'data_cancel', requestId}`. `requestId` is a UUID. `networkId` is
   always the network the host runs in (§4.4, "Network"); the app never
   supplies it.
4. Read `{type:'data_response', requestId, ok, data | error:{code,message,details}}`
   and `{type:'data_progress', requestId, step}`, which resets the per-request
   silence timer (default 10 s; `orders.create` and `orders.buyNow` 60 s).
   Read `commerce_event` frames (§4.7). **Ignore every other frame**, including
   `tool_call`, `session_event` and chat/agent run frames, which the server
   mirrors to every tab of the user.
5. Do not send `register_tools` or any other frame; nothing has to precede
   `data_request`.
6. Reconnect on close with a fresh token: 1 s, 2 s, 4 s … capped at 30 s,
   with jitter; pending requests reject `disconnected`. The connection is
   opened lazily on the first op that needs it and closed on sign-out.
7. The server pings at the protocol level; the client sends no heartbeat.

### 4.3 Security

**Messages.** The host accepts a message only if `event.source === window.parent`
and, after the handshake, `event.origin === boundOrigin`. It replies by
`window.parent.postMessage(msg, boundOrigin)`, never `'*'`. Messages from any
other window are accepted only on the two popup channels below, and only from
their expected origins.

**Handshake and binding.** The client sends `host:hello` first (§4.5). The
host reads `event.origin` from that message, resolves it to an app (§4.9),
and binds `{origin, app}` for the lifetime of the page. A second `host:hello`
from the same origin re-sends `api:ready`; from any other origin it is dropped.
App identity therefore never comes from message params.

**Nesting rule (my call).** The host runs only when `window.parent === window.top`
(its parent is the top-level page). This blocks "app A frames app B's page"
on the shared `valuguru.app` site and keeps embedded mode (Q3) a separate,
explicit milestone. Where `location.ancestorOrigins` exists, the host also
refuses to run if any ancestor is not an allowed origin.

**Response headers** on `/host/` and its bundle, set by the server:
`Content-Security-Policy: frame-ancestors https://*.valuguru.app; default-src 'self'; connect-src 'self' https://api.roomful.net wss://api.roomful.net https://valuguru.texpo.io wss://valuguru.texpo.io; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`,
`Cache-Control: no-cache` for the HTML and immutable, hashed names for the
bundle; `consent.html` is served with `frame-ancestors 'none'` instead
**(2026-10-21)**. A dev build adds `http://localhost:*` and `http://127.0.0.1:*`
to `frame-ancestors` and accepts an app claim from a localhost parent, named
by the client's `app` option in `host:hello` as `<workspace>/<slug>` (not a
`?valu-app=` query) **(2026-10-21)**; the production build has neither.
(`frame-ancestors` cannot be set from a `<meta>` tag, which is one reason the
server serves the page.)

**Build configuration (2026-10-21).** A dev build (`HOST_DEV=1`, which is
refused under `NODE_ENV=production`) can override the constants the bundle is
built with: `HOST_ORIGIN`, `HOST_MASTER`, `HOST_GURU_URL`,
`HOST_RESOLVE_BASE_URL` and `HOST_SIGN_IN_ORIGINS` (comma-separated, replacing
the list below; a dev build otherwise adds `http://localhost:3005`, the dev
web, to it). Without `HOST_DEV=1` all five are ignored. The server reads
`HOST_STATIC_DIR` for the folder it serves the page from. The version the
client reports in `host:hello` is the constant in `src/version.js`, which
`scripts/generate.mjs` writes.

Because the host has no UI, clickjacking does not apply to it; the header is
defense in depth. Its security rests on the binding rule, the resolve lookup,
the two popup channels and the origin invariant below **(2026-10-21)**.

**Origin invariant (2026-10-21).** The host origin holds every signed-in user's
session in the iframe's storage and receives the one-time token by
`postMessage`, so nothing else served on that origin may render
attacker-influenced bytes as a same-origin document: such a page would reach
the host through a sibling frame. Responses the server relays from other
systems (the App API forward, the project gateway, the RAG bridges) therefore
carry `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`,
and the review's one reflected-script case, the MCP OAuth callback page, is
fixed. A dedicated host origin (§4.1) would make this structural; until then it
is kept by audit, and the `/debug` dashboard (a same-origin HTML app) is not
yet audited.

**Popup channels.** Two message types reach the host from windows other than
its parent:

- `{type:'valu-host:token', token, master}` or `{type:'valu-host:token', cancelled:true}`
  from the sign-in page: accepted only when `event.origin` is in the host's
  compiled allow-list of Valu sign-in origins, `https://live.valuverse.io`,
  `https://valu-social.com`, `https://chabaduniverse.com` and `https://texpo.io`
  (§4.4). A message with neither a `token` nor `cancelled:true` is ignored
  **(2026-10-21)**.
- `{type:'valu-host:consent', nonce, approved, scopes}` from the consent page:
  accepted only when `event.origin === location.origin` (the host origin) and
  the nonce matches an outstanding request.

The app page cannot forge either, because its origin matches neither.

**Credentials never leave the iframe.** Nothing posted to the parent may
contain `sessionId`, `session_token`, a one-time token or the `X-Session-Id`
value. The host runs its own leak check on every outbound message, with a key
list that covers `session_token`, `token`, `x-session-id` and `oneTimeToken`
in addition to valu-api's list. Logs redact the session the way
`ValuSocketConnection.describe()` does.

**Resource limits (my call).** Per bound app: at most 16 in-flight requests
(the 17th answers `{error:{code:'busy'}}`), 30 s per call. Server-side rate
limits and an audit table are out of the core; the host keeps a 200-entry
debug ring buffer of (app, action, outcome, ms) readable from DevTools (not
implemented in the core; moved to M8 **(2026-10-21)**).

### 4.4 Auth

**Why a popup.** In a cross-site iframe, `localStorage` and IndexedDB are
partitioned by top-level site (Chrome 115+, Safari, Firefox), so the host
cannot see the user's Valu sign-in. It obtains a session of its own through a
popup that runs first-party on a Valu origin.

**Which storage the host gets.** Chrome and WebKit key the partition by the
top-level *site*. `valuguru.app` is not on the Public Suffix List, so all
`*.valuguru.app` apps share one partition of the host: **one sign-in serves
every Workspaces app in that browser**. A localhost dev app, and any future
customer domain, gets its own partition and its own sign-in. The host still
enforces grants per app; the shared session is never shared with app code.

**Sign-in flow.**

1. The app calls `valu.auth.signIn()` **from a click**. The client opens the
   popup synchronously, before any `await`, or the browser blocks it:
   `window.open('<signInOrigin>/auth/host', 'valu-signin', 'popup,width=480,height=640')`.
   A `null` result rejects with `{code:'popup_blocked'}`. There is no redirect
   fallback: a redirect would route the token through the app page.
   **Sign-in origins (my call, from the repos).** Valu Social runs on several
   brand origins that share one master: `https://live.valuverse.io` (ValuVerse,
   all networks), `https://valu-social.com`, `https://chabaduniverse.com`
   (the Chabad network) and `https://texpo.io` (staging, auto-deployed from
   `develop`). `auth.texpo.io` is only the Auth app standing alone for the
   "Sign in with Valu" provider, not where users normally sign in. Since the
   host switches networks itself, a session from any brand serves. The
   client's default `signInOrigin` is `https://live.valuverse.io`;
   `createValuApp({signInOrigin})` overrides it, which a Chabad-network app
   would do. The host accepts token messages from exactly those four origins
   (§4.3); the staging one is there so the flow can be tested before a
   production web deploy, and can be dropped later.
2. `/auth/host` is a page of the Auth application (valusocial-web, §4.10),
   running top-level on the Valu origin. When there is no session, the page
   sends the visitor through the normal `/auth/login?callback=/auth/host`
   round trip, which the Auth app already supports for its own pages. Signed
   in, it shows "Continue to <app host>" with Continue and Cancel. The app
   host is taken from `document.referrer` for display only.
3. On Continue it mints a one-time token with its own session
   (`POST /api/v1/auth/getOneTimeAuthToken`, `X-Session-Id`) and posts
   `{type:'valu-host:token', token, master:'<api host of this build>'}` to
   **every** `window.opener.frames[i]` with `targetOrigin = HOST_ORIGIN`, a
   build constant. Only a frame on the host origin can receive it; the app
   page and any other frame cannot. The page never reads a target origin from
   its URL. Then it closes. Cancel posts `{type:'valu-host:token', cancelled:true}`
   and closes. `master` names the master API host the build talks to
   (`api.roomful.net`, or `dev.roomful.net` for a dev-API build); the host
   refuses a token whose `master` differs from its own with `master_mismatch`
   instead of a generic redeem failure **(my call)**.
4. The host redeems: `POST https://api.roomful.net/api/v1/auth/checkOneTimeAuthToken/<token>`,
   body `{}`, no credential. Valid iff HTTP 2xx **and** `error.status === false`
   and `data.user_id` is non-empty. It switches the session into the app's
   home network when needed ("Network" below), stores the session for that
   network under `localStorage['valu-host:session']` (a memory fallback when
   storage throws, as it does in some private modes), connects the master
   socket, and pushes the auth state (§4.5). The redeem is bounded at 15 s,
   and a sign-in replaces the shared stored session only after the redeem has
   succeeded; the other tabs adopt the new session. **(2026-10-21)**
5. The client resolves `signIn()` with the new state, or rejects with
   `{code:'cancelled'}` when the popup has been closed for 10 s without a
   result, or `{code:'timeout'}` after 5 minutes. **(2026-10-21)** The grace is
   needed because the page closes itself right after posting the token and the
   host takes about 3 s to redeem it. A failure push from the host (`cancelled`,
   `session_expired`, `master_mismatch`, `not_a_member`, `invalid_token`,
   `unavailable`) rejects the pending `signIn()` at once, with that code, and
   closes the popup.

**On every host start with a stored session:** `GET https://api.roomful.net/api/v1/auth/check`
with `X-Session-Id`. A JSON `error.code === 401` clears the session. Otherwise
the master socket connects; `user_info` provides user and network. A session
that cannot be checked at all is kept, not cleared (§4.11). **(2026-10-21)**

**Sign-out.** `valu.auth.signOut()` → `host:auth {action:'sign-out'}` → the
host clears storage, closes both sockets and pushes `signedIn:false`. The
user's Valu Social sign-in is untouched (the session itself is not revoked;
revoking it would sign the user out of Valu Social too, since the redeemed
`session_token` is expected to be the minting session; M0 confirms).

**Network (decided by Pavlo, 2026-10-20): the host runs in the app's home
network.** A Roomful session is network-scoped, and a workspace is
network-isolated (`vg_workspaces.network_id` is `NOT NULL`), so an app's
store, orders and catalogue live in its workspace's network. The resolve
answer carries it as `homeNetworkId`. After redeeming a token the host opens
a temporary master connection with the redeemed session; if `user_info`
reports another network, it runs
`network:switch {networkId: homeNetworkId, requestNewSessionId: true}`, the
call Valu Social itself uses (`ApplicationStore.js:731-764`), and keeps the
returned session for that network. Storage is therefore per network:
`localStorage['valu-host:session'] = { v:1, userId, sessions: { <networkId>: { sessionId, createdAt } } }`,
shared by every Workspaces app in the browser; a host page serves one app and
so one network, and `MasterConnection` stays a single instance. A refused
switch (the user is not a member of that network) leaves the host signed out
and answers 401 `not_a_member` (not `sign_in_required`) on every call until the
next sign-in attempt **(2026-10-21)**, and the app shows that. The Guru client
sends the home network as `networkId`. M0 question 2 records what `user_info`
reports for a redeemed session and whether the original session stays valid
after the switch.

**Not used:** the Storage Access API and "Sign in with Valu" (handoff D12).

### 4.5 Bridge protocol

The host speaks valu-api's existing wire format so that the client's request
plumbing is reused, and adds three `host:` messages.

Envelopes, exactly as today: app → host `{name, message}` with `requestId`
inside `message`; host → app `{target:'valuApi', name, message, requestId}`
with `requestId` the same number at the top level.

| Direction | `name` | `message` | Answer |
|---|---|---|---|
| app → host | `host:hello` | `{protocol:1, client:'<valu-api version>', app?}` | `api:ready` (below), or `host:error {code:'unknown_app'\|'nested'\|'bad_origin', message}` |
| host → app | `api:ready` | `{applicationId, action:'start', params:{}, host:{protocol:1, mode:'dedicated', signedIn, user:{id,name}\|null, network:{id,name}\|null}}` | — |
| app → host | `api:call` | `{service, action, params, requestId}` — one of the 65 descriptors by `service` + `action` | `api:call-completed` with `message` = a **ValuAck**: `{data}` or `{error:{status:true, code, message}}` |
| app → host | `api:service-intent` | `{applicationId:'Commerce'\|'Application', action, params, requestId}` | `api:run-console-completed` with Valu Social's documented shape for that intent (`{products}`, `{success:false, code, error}` …) |
| app → host | `host:auth` | `{action:'sign-out', requestId}` | `host:auth-completed {ok:true}` |
| host → app | `api:trigger` | `{action:'auth', data:{signedIn, user, network}}` on every change; `{action:'commerce', data:{event, …}}` for subscribed Commerce events | — |
| app → host | `api:run-intent`, `api:create-pointer`, `api:run`, `api:run-console` | — | their usual reply name with `{error:{code:'not_available', message}}` |
| app → host | `api:run-command` | — | ignored: in dedicated mode the app owns its URL |

`app` (`<workspace>/<slug>`) is read by a dev host from a localhost parent only
(§4.3); a production host ignores it. **(2026-10-21)**

**Why `api:call` rather than `api:service-intent` for service functions
(my call).** The 64 manifest intents have Valu Social's answer shapes;
valu-api's functions have the SDK's (`{policies}` vs a bare array, for
example). Serving both vocabularies under one name would force the host to
re-implement Valu Social's shape mapping. `api:call` carries the SDK contract
(D9); `api:service-intent` keeps Valu Social's for the intents that have no
SDK function yet, which in the core are Commerce and `Application.get-identity-token`.
A raw `api:service-intent` for an intent that has an SDK function answers
`{error:{code:'not_available', message:'use valu.<Service>.<method>()'}}`.

**Calls while signed out** answer `{error:{status:true, code:401, message:'sign_in_required'}}`
(ValuAck) or `{success:false, code:'sign_in_required'}` (intent); after a
refused network switch the code is `not_a_member` (§4.4). **(2026-10-21)**

**`applicationId` in `api:ready` (my call)** is the canonical App API address
`<workspace>/<slug>` (handoff §3.4). It is informational for the app.

### 4.6 Permissions

Per `api:call` and per served intent, in this order:

1. **Allow-list.** The `(service, action)` pair is a known descriptor, or one of
   the served intents. Otherwise 404 `unknown_function`.
2. **Params.** `validateParams` from valu-api (`src/services/validate.js`):
   unknown keys refused, types checked → 400.
3. **Scope and tier.** Each descriptor has one scope. The tier decides:
   - *forbidden* → 403 `forbidden`, never asked;
   - *basic* → allowed once signed in;
   - *consent* → allowed if the user holds an unrevoked grant for
     `(user, app, scope)`; otherwise the call answers
     `{error:{status:true, code:403, message:'consent_required', scope}}`
     and the client runs the consent flow below.
4. **Execute**, with `applicationId` stamped from the binding and the network
   from the master socket.
5. **Record** in the debug ring buffer (not implemented in the core; M8). **(2026-10-21)**

**Scopes and tiers (my call, from the handoff's proposal):**

| Tier | Scopes |
|---|---|
| Basic | `users:read`, `networks:read`, `time:read`, `resources:read`, `profile:read`, `applicationstorage:read`, `applicationstorage:write`, `application:identity` (new; `Application.get-identity-token`) |
| Consent | `users:write`, `rooms:read`, `rooms:write`, `textchat:read`, `textchat:write`, `groups:read`, `groups:write`, `events:read`, `events:write`, `community:read`, `cbac:read`, `cms:read`, `cms:write`, `http:read`, `http:write`, `veruswallet:read`, `commerce:read`, `commerce:write`, `commerce:sell` (new) |
| Forbidden | `veruswallet:write`, `cbac:write`, `developer:write`, `developer:read` |

ApplicationStorage is basic because it addresses only the app's own bucket
(`app:<id>:userSortingTable:<user>`). The three `app-state` functions
(`Developer.*`, `VerusWallet.get-balance`) answer 501 because the host supplies
no `AppState`.

**`local`-channel functions run in the app page, not through the host (my
call).** The eight descriptors on the `local` channel (`Http.*`, `Time.*` and
the URL builders) need no socket; valu-api's own implementation runs them with
the page's `fetch`. The client's `HostTransport` executes them in place, so
`Http.get` / `Http.post` fetch from the app's origin, which is no more than
the app can do itself, and the host's `connect-src` is not loosened for them.
`http:read` / `http:write` therefore have no tier in dedicated mode. That
leaves 54 socket functions served by the host, of which 4 are forbidden.

**Commerce intents → scopes (my call):**

- `commerce:read` (11): check-entitlements, get-cart, get-display, get-order,
  get-product, get-purchase-contents, list-categories, list-orders,
  list-products, list-purchases, preview-promo.
- `commerce:write` (4): add-to-cart, clear-cart, remove-from-cart, update-cart-item.
- `commerce:sell` (15): create-product, create-store, delete-discount-code,
  end-sale, get-analytics, get-my-product, get-my-store, list-my-products,
  list-network-access, list-promotions, list-seller-products, quote-bundle,
  remove-volume-tier, request-network-access, update-product.
- `subscribe-events` / `unsubscribe-events`: `commerce:read`.

**Grants** live in Valu Guru (§4.9): one row per `(user_id, app_id, scope)`
with `granted_at` and nullable `revoked_at`. The host reads them over its Guru
socket on first need, caches them for 60 s (so a revocation made elsewhere
lands within a minute), re-reads after a reconnect, and writes through on
grant. `app_id` is the canonical address. Test builds are not reachable in
the core (only published site hosts resolve), so the handoff's "own grants for
`--dev` / `--review`" rule has nothing to apply to yet.

**Consent flow.**

1. The client receives `consent_required` for scope *s*. If
   `navigator.userActivation.isActive` (the app made the call from a click),
   it opens the consent popup at once; otherwise the ack is the answer and the
   app calls `valu.auth.requestConsent([s])` from its own click. **(2026-10-21)**
   The library does this for **service functions** only (`valu.X.y()`,
   `valu.data.X.y()` and the by-name calls). A `callService` intent is refused
   `{success:false, code:'consent_required', scope}` as it is, and the app calls
   `valu.auth.requestConsent([scope])` itself and repeats the intent.
2. The popup is `<host-origin>/host/consent.html?nonce=…`, part of the host
   bundle. It carries only the nonce. The app's name and address and the
   requested scopes come from the host iframe itself: the popup is same-origin
   with it, finds it among `window.opener.frames`, and reads the pending
   request for that nonce. Nothing the app page controls can put another
   app's name on the dialog. It shows the scopes in plain words (the wording
   comes from Valu Social's `consent.js` where one exists), with Allow and
   Don't allow. Both buttons stay disabled until about 600 ms after the window
   is visible and focused, and again after each refocus, and `consent.html` is
   served with `frame-ancestors 'none'` (§4.3). **(2026-10-21)**
3. The decision goes to the host iframe only: `window.opener.frames[i].postMessage({type:'valu-host:consent', nonce, approved, scopes}, HOST_ORIGIN)`.
   The host verifies origin and nonce, writes the grant through
   `valuguru.apps.grants.grant`, and answers the client's outstanding consent
   request. A popup closed without a decision resolves `false` after the same
   10 s grace as sign-in; the host's slot for that nonce expires on its own
   timer, as there is no cancel message yet (M8). **(2026-10-21)**
4. The client retries the original function call once.

Declared scopes (an app manifest listing what it needs, asked once after the
first sign-in) are out of the core; every scope is asked on first use (D6).

### 4.7 API services

**Service functions** run through valu-api's own SDK inside the host:
`createValuServices({ socket: masterConnection, applicationId: <stamped id>, cache: null, fetchImpl: fetch, config: { webBase: 'https://live.valuverse.io', apiGate: 'https://api.roomful.net' } })`,
re-created whenever the master connection instance is replaced (§4.2). The
host dispatches `api:call` as `services.call('<service>.<action>', params)`
and returns the ValuAck unchanged. `webBase` is configuration (it only builds
share links).

The stamped `applicationId` **(my call)** is the project slug, which is what
Valu Social stamps today for a published Guru app (`manifest.id` is the slug),
so Commerce `appId`, CMS and ApplicationStorage belongings keep receiving the
strings they get now, and the canonical address is used only for grants and
`api:ready`.

**Commerce data intents** (the 30 `valu-guru` intents in valu-api's
`APPLICATION_ONLY_INTENTS`) are ported from `buyerIntents.js` /
`sellerIntents.js` **as a mapping only**: intent → `valuguru.commerce.*` op →
params, with `appId` stamped from the binding and never taken from params, and
with the same idempotency keys and timeouts `CommerceDataService.js` uses. The
answer is whatever shape Valu Social documents for that intent. The op table
is in the verification notes; the authoritative source is
`src/Services/Commerce/CommerceDataService.js`.

**Commerce events.** The host subscribes per app through `subscribe-events {events}`
(replaces the set) and `unsubscribe-events`. It maps Guru `commerce_event`
frames exactly as `commerceEvents.js` does: `commerce.order.updated` and
`commerce.delivery.updated` only to apps named in `appIds`;
`commerce.catalogue.updated` only when its `networkId` is the current one;
product/store/promotions updates to every subscriber; `cart-updated {count}`
emitted after `commerce.cart.updated` with `count` computed from `cart.get`
for this app's rows. Delivery is `api:trigger {action:'commerce', data:{event, …}}`.

**`Application.get-identity-token`** runs `appManifest:getIdentityToken`
with `{applicationId: <stamped id>}` over the master socket, tier basic. It
lets a dedicated app call the App API with a bearer token.

**Ops never reachable from an app:** everything outside the mapping, in
particular `valuguru.commerce.api.keys.*`, `orders.simulatePayment`,
`orders.payInstantly`, `network.*`, `admin.*`, and all non-commerce op
families.

### 4.8 valu-api client

**New factory (my call on naming):** `createValuApp({ hostOrigin?, signInOrigin?, mode?, hostOrigins?, app? })`
returns one object that carries both halves of today's package:

- `valu.mode`: `'embedded' | 'dedicated'`.
  - Dedicated when the page is top-level (`window.parent === window`), or when
    the URL has `?valu-mode=dedicated`, or when `mode` is passed.
  - Embedded whenever the page is framed and nothing overrides it: the client
    waits for the parent's `api:ready` as it does today, with no timeout.
    There is no timed fallback to dedicated: Valu Social sends `api:ready`
    only about 1.25 s after the frame loads, and under the nesting rule a
    framed page could not use the host anyway.
- `valu.auth`: `state` (`{signedIn, user, network}`), `signIn()`, `signOut()`,
  `requestConsent(scopes)`, `on('change', handler)`.
- `valu.network`: `{id, name} | null`, from the host's `user_info`.
- `valu.connection`: the state and events of §4.11.
- The service tree (`valu.Users.current()` …) built with
  `createValuServices({ transport: new HostTransport(...) })`. The transport
  implements the duck-typed contract `ServiceClient` needs: `servesServiceFunctions`,
  `callService(descriptor, params, {timeoutMs})` returning a ValuAck and never
  rejecting, enforcing `timeoutMs` itself, `subscribe`, `close`. It posts
  `api:call` and resolves on `api:call-completed`, and emits `reconnected`
  when the host reports one so the client-side cache clears (§4.11).
- Also on the object **(2026-10-21)**: `valu.data` (the same tree answering the
  payload and throwing `ValuServiceError`), the by-name `valu.call(name, params)`,
  `valu.invoke(name, params)` and `valu.toolDefinitions(filter)`, and
  `valu.bridge`, the `ValuApi` underneath (in dedicated mode for the lifecycle
  only: `setApplication` and `onCreate`).
- The bridge methods as today (`callService(new Intent('Commerce', 'add-to-cart', …))`,
  `ValuApi.ON_COMMERCE`, `onCommerceEvent`), over the same transport.
- In embedded mode the host-only service functions answer 501 as today (by
  name too), `auth.state` is a constant signed-out, and `signIn`, `signOut`
  and `requestConsent` reject `not_available`; nothing else changes for framed
  apps in the core. **(2026-10-21)**

**Options (2026-10-21).** `hostOrigins` (embedded only) pins the origins the
parent's `api:ready` may come from. `app` (dedicated, dev hosts only) is the
`<workspace>/<slug>` a localhost page names in `host:hello`; a production host
ignores it. `hostOrigin` and `signInOrigin` must belong together: the sign-in
page hands the token only to the host origin of its own build, so a local host
goes with the local sign-in page and the default host with a published brand.
A mismatch fails quietly (the popup closes and `signIn()` rejects `cancelled`
after the grace).

**Iframe injection.** `<iframe src="<hostOrigin>/host/" hidden aria-hidden="true">`
appended to `document.body`, no `sandbox`, no `allow`. On `load` the client
posts `host:hello` to `iframe.contentWindow` with `targetOrigin = hostOrigin`
and waits up to 10 s for `api:ready` (then `host_unreachable`). Replies are
accepted only from `event.source === iframe.contentWindow` and
`event.origin === hostOrigin`.

**Hardening of the existing `PostMessageTransport` (my call).** In embedded
mode the peer is bound once: `api:ready` is accepted only from `window.parent`,
and the origin of the first one becomes the only origin replies go to and
messages are accepted from. Later `api:ready` messages from that peer re-run
`onCreate` as today; from any other window they are dropped. There is **no
default allow-list of Valu origins**: the set of brand, legacy and dev hosts
is not enumerable from the repos, and a list missing one would break every
framed app on it. An optional `hostOrigins` option lets an app pin the list
itself. Replies are still matched by numeric `requestId`.

**The stated rule changes.** `docs/authorization.md` says service functions
never run over the postMessage bridge because the bridge has no enforcement.
The host *is* the enforcement, so the rule becomes: service functions run over
a connection, or over the host bridge, which checks grants before every call.
`PostMessageTransport.servesServiceFunctions` stays `false`; `SocketTransport`
and `HostTransport` are the two that serve them, and no wording that only
`SocketTransport` does remains **(2026-10-21)**. The test at
`test/valuapi.test.js:307-318` keeps its meaning.

**Types and docs.** `types/valu-api.d.ts` gains `createValuApp`, `HostTransport`,
the auth state and error codes; `docs/connecting.md` gains a "dedicated mode"
section. The generated docs are untouched.

### 4.9 Valu Guru server changes

All on a feature branch; merging to `main` releases to production and applies
the migration (`VALUGURU_MIGRATIONS_ENABLED`), so the merge is a deploy.

1. **Resolve endpoint** `GET /api/host/v1/resolve?origin=<https origin>` in a
   new `src/host/routes.ts`, mounted with the other routers. No auth.
   - Parse the host with `parseSiteHost` (`src/site-address.ts`) for
     `{slug}-ws-{ws}` hosts; for `{label}.valuguru.app` pretty hosts look the
     label up in the Sites Publisher's domain list (`listManagedDomains()`),
     whose row gives `userId = workspace_id`, `appName = slug`.
   - Load `vg_projects` by `(workspace_id, slug)` and confirm the publisher's
     list has a row for that exact host owned by that project, which closes
     the spoofing window noted in §8.
   - Answer `{ok:true, app:{address:'<ws>/<slug>', workspaceId, slug, devAppId, name, homeNetworkId}}`
     (`homeNetworkId` = `vg_workspaces.network_id`) with
     `Cache-Control: public, max-age=300`, or 404 `{ok:false, error:{code:'unknown_app'}}`.
     Legacy `web.texpo.io/{ws}/{slug}/` apps are not resolvable (their origin
     does not identify a project) and are out of scope. A valid https origin
     that is not a single-label `*.valuguru.app` host (several labels, a custom
     domain) answers the same 404 `unknown_app`; a malformed or non-https
     origin, localhost included, answers 400 `bad_origin`, which the host's
     resolver client reports as `resolve_unavailable`. The production host
     therefore serves only published `*.valuguru.app` origins. **(2026-10-21)**
   - Per-IP rate limit, reusing `src/app-api/rate-limit.ts`.
2. **Grants.** Migration `supabase/migrations/<timestamp>_app_grants.sql`:
   `vg_app_grants (user_id text, app_id text, scope text, granted_at timestamptz not null default now(), revoked_at timestamptz, primary key (user_id, app_id, scope))`.
   Ops in `socket.ts`, scoped to `connectionUserId`:
   `valuguru.apps.grants.list {appId?}` → `{grants:[{appId, scope, grantedAt, revokedAt}]}`;
   `valuguru.apps.grants.grant {appId, scopes[]}` (upsert, clears `revoked_at`);
   `valuguru.apps.grants.revoke {appId, scopes?[]}`. Scope strings are
   validated against the known list. Any client with the user's session may
   call them: a user granting themselves is not a privilege gain.
3. **`client=host` connections.** `connection-auth.ts` records `client` from
   the query. For `host` connections `index.ts` calls `setUserSessionToken`
   **only when the user has no stored token or the stored one is marked
   invalid**, and never overwrites a valid one, so the host cannot repoint a
   user's pooled Roomful socket and server agents, yet a user who has never
   opened Guru chat in Valu Social still gets a pooled socket, which the
   Commerce ops need (`master-gateway` answers `master_unavailable` without
   one) **(my call)**. It also skips `closeUserConnectionIfIdleLogged` on
   close.
4. **Static host page.** `GET /host/`, `/host/consent.html` and the hashed
   bundle, with the headers of §4.3; the router serves only `index.html`,
   `consent.html` and `assets/*` by name, from `HOST_STATIC_DIR` when set
   **(2026-10-21)**. Built at image build time by an esbuild step in the
   Dockerfile from `node_modules/@arkeytyp/valu-api/src/host/` plus `host/` in
   this repo.
5. **Pin** `@arkeytyp/valu-api` to the commit that carries `src/host/`.

### 4.10 valusocial-web change

One new page of the Auth application: `/auth/host` (`page: 'host'` in
`AuthStore`'s page list, a component under
`src/Applications/AuthApplication/pages/`). It cannot be a raw aux page like
`sso.html`, because the login pages return to their `callback` through the
SPA router (`Router.navigate` → `pushState`), which never loads a raw file;
an Auth page gets the round trip for free. Signed out, it navigates to
`/auth/login?callback=/auth/host`; signed in, it runs §4.4 step 3 with the
session `ApplicationStore` holds. `HOST_ORIGIN` and the build's master API
host come from the platform build config (`.valu-build.json`); the page ships
in every brand build. The dev web deploys on a push to `develop`, in two
builds: `texpo.io` against `api.roomful.net`, which M3 uses for testing before
any production web deploy, and `dev.texpo.io` against `dev.roomful.net`, whose
tokens the production host refuses (§4.4 step 3). Production brand sites get
the page with their next manual `prod_deploy.yml` run.

### 4.11 Resilience: drops, disconnects, reconnects (Pavlo, 2026-10-20: a core requirement)

valu-api is the API provider every app depends on, so a dropped socket must
cost an app a delay, not an error, wherever that is safe. Rules:

- **Hold, don't fail.** While a socket is reconnecting, the host holds new
  calls and in-flight calls that have not reached the wire, up to a
  **reconnect grace of 20 s** per call (within the call's own 30 s timeout).
  Only when the grace runs out does a call answer 503 `disconnected`. Today
  valu-api's `emit` answers 503 at once when `socket.connected` is false and
  the read policy retries only ~0.75 s, which is shorter than one reconnect;
  the host's `MasterConnection` wrapper adds the hold in front of it.
- **Reads may be retried, writes never.** A read that was on the wire when
  the socket dropped is retried by the client's `CallPolicy` (on 408 and 503
  only); retries are client-only, and the host's own service calls run with
  `retries:0` **(2026-10-21)**. A write that was on the wire answers 503
  `disconnected` with `retryable: false`; the app decides, because the master
  may have applied it. Commerce writes keep their idempotency keys so the app
  can repeat them safely.
- **Both sockets reconnect on their own**, with exponential backoff and
  jitter (master: socket.io's 0.5–5 s; Guru: 1 s doubling to 30 s), pause
  while `navigator.onLine` is false and resume on `online`, and never give
  up while the page lives. The Guru socket mints a fresh one-time token on
  every attempt; the master socket is replaced on a `failed` state (§4.2).
- **State re-sync after reconnect.** The host re-reads `user_info`, drops
  its grants cache, re-arms Commerce event routing, and emits `reconnected`
  to the client's `HostTransport`, which clears the client-side SDK cache the
  way `ServiceClient` expects. Commerce events are per-user frames the server
  sends to every connection, so nothing has to be re-registered server side.
- **Session death is reported, not retried.** A 401 at reconnect (the session
  was revoked or expired) clears the session, answers every held call
  `sign_in_required`, and pushes `signedIn:false, reason:'session_expired'`.
- **A slow platform at startup is not session death (2026-10-21).** The master
  wait before `api:ready` is bounded at 5 s: `api:ready` then answers with the
  stored identity and `connecting`, and the host pushes `reconnecting` or
  `ready` as the link comes up. A stored session that cannot be checked is
  kept with `reason:'unavailable'` and retried with backoff, not signed out;
  only a 401 ends it.
- **The host iframe itself can die.** If the host stops answering (no reply
  to a ping `host:ping` within 10 s, or the iframe fired `error`), the client
  reloads the iframe, re-runs the handshake, and answers the calls that
  were in flight with 503 `host_restarted`; the stored session makes the
  reload silent for the user. **(2026-10-21)** The handshake is retried with
  backoff (1 s doubling to 30 s, ±20 %, and at once on `online`) while the
  answer is `host_unreachable` or `resolve_unavailable`; `unknown_app`,
  `nested` and `protocol_unsupported` are permanent. An iframe removed from the
  page starts the same recovery instead of failing calls.
- **Observable.** `valu.connection`: `state` ∈ `connecting | ready | reconnecting | offline | signed_out`,
  `on('change')`, `lastError`. Apps can show "reconnecting…" without polling.
- **Multiple tabs.** Sign-out in one tab reaches the others through the
  `storage` event on the host origin; each tab's host drops its sockets and
  pushes `signedIn:false`.
- **Tested with fakes before the real thing.** M1's unit tests drop, reopen
  and refuse the fake sockets mid-call; the conformance "host" adapter runs
  a chaos pass that drops the socket between every call. M7 repeats a drop
  test on real networks (toggle Wi-Fi, sleep the laptop, switch iOS to
  airplane mode and back).

## 5. Milestones, in the handoff's build order (D2)

Each milestone has a "done" that can be checked without the next one.

| # | Milestone | Done when |
|---|---|---|
| M0 | **Throwaway prototype** (§6) | The four questions in §6 have measured answers in a short note next to this spec, and Pavlo decides to continue. |
| M1 | Socket core in valu-api `src/host/` (`MasterConnection`, `GuruClient`) | Unit tests with `test/helpers/fakes.js` (plus a fake Guru WebSocket) cover connect, ready, drop, replace-on-failure, re-mint on reconnect, request timeout and frame filtering. The Guru client is run once against production with a pasted token. |
| M2 | Security and resolve: host page skeleton, hello → ready, binding, nesting rule, headers, static serving; the resolve endpoint with tests | A test app on `*.valuguru.app` receives `api:ready` with its address; a localhost page cannot load the production host (`host_unreachable`, blocked by `frame-ancestors`) and gets `unknown_app` from a dev build for an origin that resolves to nothing; the headers are visible with `curl -I`. |
| M3 | Auth: the `/auth/host` page, token handoff, redeem, storage, `auth/check`, sign-out, auth push; client `signIn` / `signOut` | Sign-in works with a real account in Chrome, Safari macOS and iOS Safari (simulator), both signed-in-already and signed-out; a reload keeps the session; sign-out clears it; cancel, popup-blocked and master-mismatch surface as their codes. |
| M4 | Bridge and permissions: `api:call`, allow-list, `validateParams`, tiers, grants table and ops, consent popup, retry | The conformance suite (`test/conformance`) passes through a new "host" adapter that pairs `HostTransport` with the host modules over fakes; the consent flow works end to end on the test app. |
| M5 | API services: SDK functions over the host socket; the 30 Commerce intents, events, identity token | Each served function has a passing per-function check; on a real store the buyer path list → add-to-cart → get-cart → `cart-updated` works from the test app; seller data ops answer for a seller account. |
| M6 | Client: `createValuApp`, mode detection, `HostTransport`, bridge hardening, types, docs; an `examples/dedicated/` sample app | The sample app runs on localhost against a dev host and on its `*.valuguru.app` host against production. |
| M7 | Cross-browser pass and release: Chrome, Safari macOS, iOS Safari, Firefox (nice to have); real-network drop tests (§4.11); Valu Guru pins the valu-api commit; deploy | The matrix is recorded; the pin is merged; `/version` shows the release. |

**Follow-on milestones** (added 2026-10-20 at Pavlo's request; each gets its
own plan when the core is done, because M8's details depend on what M0–M7
find):

| # | Milestone | What it is | Done when |
|---|---|---|---|
| M8 | **Embedded mode through the host** (handoff Q3) | Inside Valu Social the app's valu-api still loads the host iframe and tells the bridge so (`api:host-attach`); Valu Social mints a one-time token and posts it, with the app's identity from its own registry (`manifest.id`, so `--dev`/`--review` builds and legacy `web.texpo.io` frames work), **directly to the nested host window**, never through the app page. The nesting rule relaxes to "the chain ends at a brand origin", and `frame-ancestors` gains the brand origins and `web.texpo.io`. Data calls (`api:call`, Commerce data) go to the host; UI intents (docks, pickers, theme, routes, checkout, seller dialogs) stay on Valu Social's bridge, which fills `permissions` on them and checks grants **only for frames that attached a host** (raw-bridge apps see no change). Consent in embedded mode is Valu Social's `ConsentModal`, because the iframe sandbox has no `allow-popups`. The host uses the user's current network as Valu Social reports it (handoff Q6). Valu Social gets the "Connected apps" settings with revocation; the host re-reads grants every 60 s, so revocation lands within a minute. The unstamped `app.run` pointer path gets its sender stamped (a bug fix for every app). | `valu.Users.current()` and `callService(new Intent('Commerce', …))` return identical shapes embedded and dedicated; the conformance suite passes in both; revoking an app in settings cuts it off within a minute; the iOS shell (WKWebView) passes the same checks. |
| M9 | **Claude Code and docs** (D10) | A GitHub template repository (`ValuPorjects/valu-app-template`, source in valu-api `template/`) replaces `auto_init`, with `@arkeytyp/valu-api@^2` from **npm** in `dependencies` (the project worker has no git credentials, and the rebuild runs with `NODE_ENV=production`), `src/valu.ts` and a `.valu/template.json` marker; provisioning stamps `provisioning.template`. A **second skill pool** (`project-valu-api` and valu-api versions of the commerce, seller, CMS, images and header skills) is selected only for template projects, with its own plugin root; the existing rows, the App Builder loadout and old projects stay byte-identical. A generated function reference from the pinned valu-api sits inside `project-valu-api`, with tests that fail when the block is stale or when a skill names a function or intent the pinned package lacks. The managed `CLAUDE.md` block gets a template branch; policy v25 points template projects at `project-valu-api`; the publish guard refuses direct bridge use **for template projects only**. Typed surfaces first: `valu.theme` (client-only: `api:color-scheme` when embedded, `prefers-color-scheme` when dedicated; no server knows the theme), typed `valu.Commerce.*` generated from the catalogue, app header `not_available` in dedicated mode. Human docs: the Developer Portal SDK articles, the generated intent docs (a "valu-api call" line per intent), valu-api's README and `docs/`, and the valu-docs Intent Explorer. | A new Workspaces project built by the project worker from a blank prompt contains no `postMessage`, `api:ready` or `api:service-intent`; `publish_project` refuses a template project that does and leaves old projects alone; the Intent Explorer shows valu-api calls; the skills tests pass against the pinned version. |
| M10 | **UI actions in dedicated mode** | A standalone "action popup" shell in valusocial-web (hostname prefix `actions`, the single shell, which already has the Cart and Merchant stores and the four dialogs) signs in with a one-time token it receives **from the host** and runs one pending action: checkout (the Cart scoped to the app's rows plus promo), the nine seller consent actions, `rate-product`, `create-product` without a title, and the `open-*` surfaces; the pending-action record lives in the host, which already checked the grant; the app id never comes from the popup URL. Pickers, RoomPoints, Unity and docks stay `not_available`. Optional after M9; needed only for apps that must pay on their own host. | A dedicated commerce app completes a test checkout from its own host. |

Repos and branches: valu-api `feat/host-core`, valu-guru-server
`feat/host-core`, valusocial-web `feat/host-signin`; worktrees under each
repo's `.claude/worktrees/`. M1 and the server side of M2 can run in parallel
sessions; M3 needs the web page; M4–M5 are sequential in valu-api. M8 and M9
can run in parallel once M7 is done, since M9's skills ship only after M8 is
live (the old design's timing rule).

**Protocol versioning.** The host is deployed server side and must keep
serving every valu-api version pinned by a published app. `host:hello`
carries `protocol`; the host answers the highest version it shares with the
client and refuses with `protocol_unsupported` below its floor. Breaking a
message shape bumps `protocol`; adding fields does not.

Sign-ins needed from Pavlo: M0 (tokens), M3, M5 and M7 (a real account in
each browser). Deploys: a push to `develop` deploys the dev web, and every
Valu Guru merge to `main` deploys production, so each one is announced and
agreed first.

## 6. Milestone 0: the prototype

Purpose: find out in one or two days whether the approach survives real
browsers and the real master, before the core is built. Throwaway: no tests,
not kept.

**What it is.** A single `host-proto.html` with only the socket core and
storage: it accepts a one-time token, redeems it, stores the session, opens
the master socket, shows `Users.current()` and the result of one Guru op
(`valuguru.commerce.cart.get`), and reports what it sees. A `proto-popup.html`
on the same origin posts a pasted token to `opener.frames[*]` to exercise the
handoff mechanics. A `test-app.html` loads the host in a hidden iframe and
shows the results. No sign-in page exists yet, so **Pavlo mints tokens** in the
signed-in `:3005` console (`POST /api/v1/auth/getOneTimeAuthToken` with the
session header) and pastes them.

**Where it runs.** Both pages are published as Workspaces project sites in
the **"Valu Apps Development"** workspace (Pavlo, 2026-10-20), which puts them
on Valu-controlled `*.valuguru.app` origins with no DevOps:
`host-proto-ws-<ws>.valuguru.app` (the host) and `test-app-ws-<ws>.valuguru.app`
(the app). Framed from the test app, the host
is same-site (first-party storage); framed from a localhost page it is
third-party (partitioned storage). Both cases get measured.

**Measure and record**, in Chrome, Safari macOS and iOS Safari (26.4 or 27.0
simulator):

1. Does the stored session survive a reload of the app page, and in Safari,
   does it survive one day and a browser restart, in both the same-site and
   the third-party case?
2. Does `ValuSocketConnection` (the `{sessionId}` door) connect to the real
   master and receive `user_info`? Which `networkId` does `user_info` report
   for the redeemed session, compared with the minting session's network?
3. Is `checkOneTimeAuthToken`'s `session_token` the minting session's own id
   (the same string) or a new session? This decides whether sign-out may
   revoke it and how `vg_session_tokens` is affected.
4. Popups: does `window.open` from a click in the app page open on iOS Safari;
   does `opener.frames[i].postMessage` reach the host; is the popup blocked
   when opened after an `await`?

Also note whether a Guru connection from the host changed the user's stored
session token (ask the server log, or watch whether server agents restart).

**The local rig the core was verified on (2026-10-21).** The host's dev bundle
at `http://localhost:3001/host/`, served by the local Guru (`HOST_DEV=1`,
`HOST_GURU_URL=ws://localhost:3001/`, `HOST_SIGN_IN_ORIGINS=http://localhost:3006`;
the local Guru has the grants ops before the server branch is deployed, and uses
the production database, so grant rows are real); the sign-in page from the
valusocial-web `feat/host-signin` worktree on `:3006`, with `localStorage.session`
copied from the signed-in `:3005`; `examples/dedicated/` on `:5173`, served from
the repo root (`npx serve . -p 5173`, since it imports `../../src`); and the test
app `ws_057a1a6e/valu-api-sample` in "Valu Apps Development" (network roomful),
which the dev host serves to the localhost page through the sample's `app`
option. Sign-in (about 3 s from Continue), a reload keeping the session, a basic
function, a consent-gated function and a Commerce intent after explicit consent
all passed in Chromium.

## 7. Risks and unknowns

- **Partitioned storage lifetime in Safari.** Third-party partitioned storage
  may be short-lived or ephemeral. If M0 shows that, Workspaces apps are still
  fine only with a same-site host (`host.valuguru.app`, a DevOps task), and
  localhost or customer domains would sign in per visit.
- **The `{sessionId}` door has never run against the real master.** M0 is the
  first run. If `init.client` or the socket behave differently from the fakes,
  M1 absorbs it.
- **Which session the host gets.** If `checkOneTimeAuthToken` returns the
  minting session, the host holds the same session as the user's Valu Social
  tab on that origin: signing out of Valu Social also signs the host out, which
  is acceptable. If it returns a new session, sign-out semantics and the
  `vg_session_tokens` side effect change; the `client=host` flag covers the
  latter either way.
- **`network:switch` semantics.** The host relies on
  `network:switch {requestNewSessionId:true}` returning a session for the
  app's home network without invalidating the user's other sessions, and on
  it refusing non-members cleanly. Valu Social uses the call the same way, but
  M0 is the first time it runs from a page that is not Valu Social.
- **Popup blockers**, especially iOS: the client opens the popup before any
  asynchronous step; apps must call `signIn()` from a click.
- **Apps with their own CSP** must allow the host origin in `frame-src`.
  Workspaces apps ship no CSP today.
- **The iOS shell.** Valu Social also runs inside a native iOS shell
  (WKWebView). Storage partitioning and `window.open` behave differently
  there; M8 tests the nested host in the shell, and the core notes it as
  untested.
- **Version skew.** Published apps pin valu-api commits and never update.
  The host must stay compatible with every client it ever shipped to; the
  protocol version rule above is what makes that tractable.
- **One shared session across all Workspaces apps** in a browser is a feature
  of the storage model, not a choice; the per-app grants are what keep apps
  apart. If a per-app session is ever wanted, the master would have to offer
  scoped sessions (handoff §5, Stripe's model).

## 8. Related findings, not part of this task

Found during the review; each deserves its own ticket.

- **Valu Guru HTTP auth accepts a bare user id as a bearer token.**
  `requireAuth` (`src/auth.ts:59-77`) treats a non-JWT bearer as a trusted user
  id, on `/api/valuguru/*`, the library, usage, agents and transcribe routers.
- **Valu Guru WS legacy frames trust `msg.userId`** (`applyAuth`, unless
  `WS_REQUIRE_JWT=true`), and the network-admin check compares the client's
  claimed `networkId` with itself.
- **Commerce:** `FAKE_MASTER_ENABLED = true` in code; `orders.simulatePayment`
  is callable by any buyer on their own pending order in production.
- **Sites Publisher pretty labels** can be assigned to copy another unpublished
  project's site-host label (`project-domains.ts` `availabilityFrom`).
- **Valu Social bridge:** no permission or availability check on service
  intents; `api:run` → `app.run` reaches services unstamped; `VerusWallet.transfer`
  has no consent step (proposed session `task_924f3458`); the MCP OAuth popup
  listener checks neither origin nor source; two more never-resolve traps
  (picker cancel, `openCreateProduct`); the login page can be framed by anyone.
- **valu-api housekeeping:** `README.md:510-511` names functions that do not
  resolve; `docs/sdk.md` counts are stale; the release-drafter targets `master`.

## 9. Decisions

### 9.1 Pavlo's
- D1–D12 of `2026-10-20-hidden-iframe-host-handoff.md`, unchanged.
- 2026-10-20, on this document: the host runs in the app's home network with a
  per-network session (§4.4); the core covers Workspaces apps only, Commerce
  buyer and seller data intents only, no AiGuru intents, no API pointers
  (§2); the tiers as in §4.6; the prototype runs in the "Valu Apps
  Development" workspace (§6). No preference on code location and serving
  origin, so §4.1 stands as my call; the sign-in origin was left to the repos
  (§4.4).
- 2026-10-20, second round: the target is "valu-api only" for **new apps
  only**, with no migration of existing apps; railing Claude Code CLI to
  valu-api and updating all skills and docs, human developer docs included,
  is required (M9); new apps must never use the intent bridge directly;
  resilience to socket drops and reconnects is a core requirement (§4.11).
  M8–M10 added to §5 at his request.

### 9.2 My calls in this document
- Host logic in valu-api `src/host/`; page and bundle served by valu-guru-server
  at `https://valuguru.texpo.io/host/`; sign-in page in valusocial-web (§4.1).
- Core = Workspaces apps on published site hosts, dedicated mode only; embedded
  mode unchanged (§2).
- `api:call` for service functions with ValuAck answers; `api:service-intent`
  only for Commerce and `get-identity-token`; everything else `not_available`
  (§4.5).
- `host:hello` handshake initiated by the client; one bound origin; nesting
  rule `parent === top`; headers; popup channels verified by origin (§4.3).
- Session in the iframe's `localStorage`; `auth/check` on start; no redirect
  fallback for sign-in (§4.4).
- Tier assignment, including `applicationstorage:*` as basic and the four new
  scopes; Commerce intent → scope mapping (§4.6).
- Grants table and three ops in Valu Guru; `client=host` connection flag;
  resolve endpoint shape (§4.9).
- Stamped `applicationId` = slug; canonical address for grants and `api:ready`
  (§4.7).
- `createValuApp` as the one entry point; framed means embedded with no timed
  fallback; bridge hardening with no default origin list (§4.8).
- `local`-channel functions run in the app page; `Http.*` never crosses the
  host (§4.6).
- The consent popup reads the request from the host iframe, not from its URL
  (§4.6).
- The sign-in page is an Auth-app page `/auth/host`; the token message names
  its master and the host refuses a mismatch (§4.4, §4.10).
- `client=host` stores the session token only when the user has none or an
  invalid one (§4.9).
- 16 in-flight requests per app; no server-side audit or rate limit in the core
  (§4.3).
- Prototype served as Workspaces project sites with pasted tokens (§6).

### 9.3 Open
Nothing. The questions raised on 2026-10-20 (network rule, code location,
sign-in origin, prototype hosting, deploys, scope, tiers) are answered above.
Next step: the implementation plan, starting with M0. **(2026-10-21)** The core
has since been built; what the build changed is in §11, and what is left is the
M8–M10 plan with its follow-ups.

## 10. Left to the builder

- Module layout under `src/host/` and the esbuild setup in valu-guru-server;
  how the dev build is served locally (an `http://localhost` host for the
  sample app).
- The consent page's look and the exact wording per scope.
- The fake Guru WebSocket for tests and the "host" conformance adapter plumbing.
- Backoff constants, the debug ring buffer format, the `count` computation for
  `cart-updated`.
- How `createValuApp` exposes versions and error classes; `d.ts` details.
- The resolve endpoint's cache for the publisher's domain list and its
  refresh.
- Whether the `/auth/host` page shows the user's name (it would need one extra
  call) or only the app host.

## 11. Rulings during implementation (2026-10-21)

Made during the overnight build and its final review; each one also amends the
sentence marked **(2026-10-21)** in the section it names.

1. **Sign-in (§4.4; the token message in §4.3).** A closed sign-in popup is
   `cancelled` only after a 10 s grace (the page closes itself after posting the
   token, and the host needs about 3 s to redeem). A failure push (`cancelled`,
   `session_expired`, `master_mismatch`, `not_a_member`, `invalid_token`,
   `unavailable`) rejects the pending `signIn()` at once and closes the popup.
   After `not_a_member` the host stays signed out and answers 401 `not_a_member`
   (not `sign_in_required`) until the next sign-in attempt. A sign-in replaces
   the shared stored session only after the redeem succeeds (other tabs adopt
   it). A token message without a `token` is ignored.
2. **Consent (§4.6; `consent.html` headers in §4.3).** Service functions get the
   consent window from the library automatically; `callService` intents are
   refused `{success:false, code:'consent_required', scope}` and the app calls
   `auth.requestConsent([scope])` itself. The consent page keeps its buttons
   disabled until about 600 ms after the window is visible and focused (and
   again after each refocus); `consent.html` has `frame-ancestors 'none'`. A
   consent popup closed without a decision resolves `false` after the 10 s
   grace; the host's slot expires on its own timer (no cancel message yet, M8).
3. **Client (§4.8; `app` in §4.3 and §4.5).** The entry point is
   `createValuApp()`; `HostTransport` serves service functions (the old "only
   `SocketTransport`" wording is gone). The object also has `call`, `invoke`,
   `toolDefinitions`, `valu.data` and `valu.bridge`; options `hostOrigins`
   (embedded origin pin) and `app` (dev hosts only). Embedded host-only functions
   answer 501, embedded `auth.state` is a constant signed-out, and `hostOrigin`
   and `signInOrigin` must belong together.
4. **Resilience (§4.11; the redeem bound in §4.4).** Retries are client-only
   (host calls run with `retries:0`; the client's `CallPolicy` retries reads on
   408 and 503 only). Iframe recovery retries the handshake with backoff (1 s
   doubling to 30 s, ±20 %, and on `online`) for `host_unreachable` and
   `resolve_unavailable`, and gives up only for `unknown_app`, `nested` and
   `protocol_unsupported`; a removed iframe starts recovery instead of failing
   calls. The master wait before `api:ready` is bounded at 5 s (ready answers
   with the stored identity and `connecting`, then pushes `reconnecting` or
   `ready`). A stored session that cannot be checked is kept with
   `reason:'unavailable'` and retried with backoff, not signed out. Redeem is
   bounded at 15 s.
5. **Host page and server (§4.3; §4.9 item 4, §4.6 step 5).** A dev build
   overrides `HOST_ORIGIN`, `HOST_MASTER`, `HOST_GURU_URL`,
   `HOST_RESOLVE_BASE_URL` and `HOST_SIGN_IN_ORIGINS` (dev only: `HOST_DEV=1`,
   refused under `NODE_ENV=production`); the server reads `HOST_STATIC_DIR`.
   The origin invariant: nothing served on the host origin may render
   attacker-influenced bytes as a same-origin document (relayed responses carry
   `CSP: sandbox` and `nosniff`). The debug ring buffer is not implemented
   (moved to M8). `src/version.js` is generated by `scripts/generate.mjs`.
6. **Resolve (§4.9 item 1).** A valid https origin that is not a single-label
   `*.valuguru.app` host answers 404 `unknown_app`; a malformed or non-https
   origin (localhost included) answers 400 `bad_origin`, which the host's
   resolver client reports as `resolve_unavailable`. The production host serves
   only published `*.valuguru.app` origins.
7. **Development rig (§6).** The local end-to-end setup: host `:3001` with a dev
   bundle and the local Guru, sign-in page `:3006`, sample `:5173`, test app
   `ws_057a1a6e/valu-api-sample` in "Valu Apps Development".

What the final review deferred is listed in the M8–M10 plan, "Follow-ups from
the core's final review".
