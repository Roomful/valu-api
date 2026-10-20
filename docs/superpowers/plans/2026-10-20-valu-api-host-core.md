# valu-api Host Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An app on its own `*.valuguru.app` host signs the user in with one click and calls valu-api's service functions and the Commerce data intents through a hidden iframe on a Valu origin that holds the session, enforces per-app grants and survives socket drops.

**Architecture:** Host logic is framework-free ESM in valu-api `src/host/`, composed by a page that valu-guru-server builds with esbuild and serves at `/host/` with CSP headers. The valu-api client gains a `HostTransport` (iframe + `host:hello` handshake + `api:call`) behind one factory, `createValuApp`. valu-guru-server adds an origin → app resolve endpoint, a grants table with three ops, and a `client=host` connection flag; valusocial-web adds the `/auth/host` sign-in page that hands a one-time token to the iframe only.

**Tech Stack:** valu-api: plain ESM, Node 24 `node:test`, no runtime deps; socket.io-client 2.5.0 injected. valu-guru-server: TypeScript, Express, `ws`, supabase-js, vitest + supertest, esbuild (new devDependency). valusocial-web: React + Vite, vitest/jsdom.

**Spec:** `docs/superpowers/specs/2026-10-20-valu-api-host-core-design.md` (same worktree). The handoff it builds on is `docs/superpowers/specs/2026-10-20-hidden-iframe-host-handoff.md`. Read both before any task; section numbers below (§) refer to the spec.

## Global Constraints

- valu-api keeps **zero runtime dependencies**; socket.io-client is injected as `io` (§4.2). esbuild and socket.io-client appear only as devDependencies of valu-guru-server's host build.
- All host modules under `src/host/` must run in a browser and in Node tests: no DOM access at import time, every environment object injected (window, storage, fetch, WebSocket).
- Nothing posted to the app page may contain `sessionId`, `session_token`, a one-time token, or an `X-Session-Id` value (§4.3). The outbound leak-check key list is exactly: valu-api's `assertNoCredentialLeak` list plus `session_token`, `token`, `x-session-id`, `oneTimeToken`.
- The host replies only to `window.parent` with `targetOrigin = boundOrigin`, never `'*'`; it accepts parent messages only when `event.source === window.parent` and `event.origin === boundOrigin` (§4.3).
- Wire envelopes (§4.5): app → host `{name, message}` with `requestId` inside `message`; host → app `{target:'valuApi', name, message, requestId}` with `requestId` the same number at the top level.
- Protocol version is `1`; `host:hello` carries it; breaking shape changes bump it (§5 "Protocol versioning").
- Per bound app: at most 16 in-flight requests (17th → `busy`), 30 s per call, reconnect grace 20 s (§4.3, §4.11).
- Hosts and URLs: master `https://api.roomful.net`; Guru `wss://valuguru.texpo.io/`; host origin `https://valuguru.texpo.io`, page `/host/`; sign-in origins `https://live.valuverse.io` (default), `https://valu-social.com`, `https://chabaduniverse.com`, `https://texpo.io` (§4.4).
- Tiers exactly as §4.6; Commerce intent → scope exactly as §4.6; `local`-channel functions run in the app page (§4.6).
- Every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Commit on the feature branches named in §5; never push `develop` or `main` without Pavlo's go-ahead (a Valu Guru merge to `main` is a production deploy).
- Shared checkouts: work only in worktrees under `<repo>/.claude/worktrees/`; never switch a shared checkout's branch; rebase, never merge base into a branch.

## Review Focus

1. A message `{type:'valu-host:token', token}` posted by the **app page** (origin `https://x-ws-1.valuguru.app`) must be ignored; only the four sign-in origins may deliver a token. Test in Task 11.
2. A second `host:hello` from a **different origin** after binding must be dropped silently, and a reply must never go to that origin. Test in Task 9.
3. A call that arrives while the master socket is **reconnecting** must be held and answered after reconnect, not fail at once; after 20 s it answers 503 `disconnected`. Test in Task 2.
4. `localStorage` that **throws** (private mode) must not break sign-in: the host falls back to memory for the page's life. Test in Task 5.
5. A reply whose `requestId` is a **string** or unknown, and a parent message with no `name`, must be ignored without throwing. Tests in Tasks 9 and 15.

---

## Milestone 0 — Throwaway prototype (no TDD, not committed)

Purpose and the four measurements are in §6. Do this before Task 1; stop and report if any measurement kills the approach.

- [ ] **M0.1** In a scratch folder (not the repo), write `host-proto.html` + `host-proto.js`: a text field for a pasted one-time token; on submit `POST https://api.roomful.net/api/v1/auth/checkOneTimeAuthToken/<token>` (body `{}`), store `{sessionId: data.session_token, userId: data.user_id}` in `localStorage['valu-host-proto']`, then `new ValuSocketConnection({ sessionId, io, fetchImpl: fetch })` from valu-api `main` (bundle with `npx esbuild@0.24 --bundle` and `socket.io-client@2.5.0` installed in the scratch folder), `await connect()`, print `describe()`, `user`, `network`, then `createValuServices({ socket: connection, cache: null }).Users.current()`. Then mint a token with the stored session (`POST /api/v1/auth/getOneTimeAuthToken`, header `X-Session-Id`), open `wss://valuguru.texpo.io/?token=…`, send `{type:'data_request', requestId:'1', op:'valuguru.commerce.cart.get', params:{}, networkId:<network.id>}`, print the response. On load with a stored session, skip the field and connect directly.
- [ ] **M0.2** Write `proto-popup.html` on the same origin: a text field; on submit, post `{type:'valu-host:token', token}` to every `window.opener.frames[i]` with `targetOrigin` = the host origin, then `window.close()`. The host page listens for it and runs M0.1's flow.
- [ ] **M0.3** Write `test-app.html`: a hidden `<iframe src="<host origin>/">`, a "Sign in" button that calls `window.open('<host origin>/proto-popup.html', 'valu-signin', 'popup,width=480,height=640')` **synchronously in the click handler**, a second button that opens it after `await new Promise(r => setTimeout(r, 1500))`, and a log area fed by `postMessage` from the host (any origin, prototype only).
- [ ] **M0.4** From the signed-in `:3005` page, create two projects in the "Valu Apps Development" workspace, `host-proto` and `test-app`; via each project chat, add the built files as the site root and `publish_project`. Verify `curl -sI https://host-proto-ws-<ws>.valuguru.app/` and `…/test-app-ws-<ws>.valuguru.app/` answer 200. Also serve `test-app.html` from `http://localhost:8080` (`npx serve`) for the third-party-storage case.
- [ ] **M0.5** Pavlo mints tokens in the `:3005` console: `await application.services.Network.Post(MetaverseApi.auth.getOneTimeAuthToken, {}, {headers:{'Content-Type':'application/json'}})` (see `AuthTokenPage.jsx:65`). Run the matrix: Chrome, Safari macOS, iOS Safari (26.4 simulator), × {same-site test app, localhost test app}. Record for each: session survives reload (yes/no), survives browser restart, `user_info.network.id` vs the minting session's network, whether `session_token` equals the minting session id (Pavlo compares with `atob(localStorage.session)` on `:3005`), popup opens from the sync click, popup opens after the 1.5 s await, token message reaches the host. In Safari, re-check the stored session after 24 h.
- [ ] **M0.6** Write the answers into `docs/superpowers/specs/2026-10-20-m0-prototype-results.md` (next to the spec) and report to Pavlo. Continue only on his go.

---

## Part A — valu-api (`feat/host-core`)

Worktree: `git -C /Library/Git/valu-api worktree add .claude/worktrees/host-core -b feat/host-core main`. Copy `docs/superpowers/` from the `dedicated-mode-design` worktree into it and commit it first (`docs: host core spec and plan`). Tests run with `npm test` (`node --test "test/**/*.test.js"`, Node ≥ 21); a single file runs with `node --test test/host/<file>.test.js`.

### File structure

| File | Responsibility |
|---|---|
| `src/host/protocol.js` | Message names, error codes, envelope helpers; shared by host and client. |
| `src/host/MasterConnection.js` | Wraps `ValuSocketConnection`: replace-on-failure, hold-while-reconnecting, 401 classification, network switch. |
| `src/host/GuruClient.js` | WebSocket client for Valu Guru: mint-per-connect, `data_request`/`data_response`, backoff, frame filtering, `commerce_event`. |
| `src/host/SessionStore.js` | Per-network session storage with memory fallback and cross-tab change events. |
| `src/host/AppResolver.js` | Origin → app lookup against the resolve endpoint, cached. |
| `src/host/HostAuth.js` | Token redeem, `auth/check`, network switch orchestration, sign-out. |
| `src/host/Permissions.js` | Tier table, scope of a call or intent, grant check. |
| `src/host/GrantsStore.js` | Per-app grants cache over the Guru ops. |
| `src/host/CommerceIntents.js` | The 30 data intents → ops, event mapping. |
| `src/host/HostBridge.js` | The parent-message handler: binding, handshake, dispatch, pushes, in-flight cap. |
| `src/host/Host.js` | Composition root: `createHost(config)` for the page. |
| `src/host/consentPage.js` | Logic of the consent popup page. |
| `src/transport/HostTransport.js` | Client: iframe, handshake, `api:call`, local functions, ping, auth/connection events. |
| `src/createValuApp.js` | Client factory: mode detection, `auth`, `connection`, `network`, service tree + bridge methods. |
| `src/transport/PostMessageTransport.js` (modify) | Bind the embedded peer once. |
| `src/transport/SocketTransport.js` (modify) | Let `local`-channel functions run without a socket. |
| `test/helpers/hostFakes.js` | `FakeGuruSocket`, `FakeStorage`, `FakeWindowPair`, `fakeResolveFetch`, `fakeAuthFetch`. |
| `test/host/*.test.js`, `test/conformance.test.js` (modify) | Unit tests and the host conformance adapter. |
| `types/valu-api.d.ts`, `docs/connecting.md` (modify) | Public types and the dedicated-mode section. |

### Task 1: Protocol module and host fakes

**Files:**
- Create: `src/host/protocol.js`, `test/helpers/hostFakes.js`, `test/host/protocol.test.js`

**Interfaces:**
- Produces: `PROTOCOL_VERSION = 1`; `MSG` frozen map with keys `HELLO:'host:hello'`, `ERROR:'host:error'`, `AUTH:'host:auth'`, `AUTH_COMPLETED:'host:auth-completed'`, `PING:'host:ping'`, `PONG:'host:pong'`, `CALL:'api:call'`, `CALL_COMPLETED:'api:call-completed'`, `READY:'api:ready'`, `TRIGGER:'api:trigger'`, `SERVICE_INTENT:'api:service-intent'`, `RUN_CONSOLE_COMPLETED:'api:run-console-completed'`, `RUN_INTENT:'api:run-intent'`, `RUN_COMPLETED:'api:run-completed'`, `CREATE_POINTER:'api:create-pointer'`, `POINTER_CREATED:'api:pointer-created'`, `RUN:'api:run'`, `RUN_CONSOLE:'api:run-console'`, `RUN_COMMAND:'api:run-command'`, `CONSENT:'host:consent'`, `CONSENT_COMPLETED:'host:consent-completed'`; `HOST_ERRORS` frozen map of the codes in §4.5/§4.11 (`unknown_app`, `nested`, `bad_origin`, `protocol_unsupported`, `sign_in_required`, `consent_required`, `forbidden`, `not_available`, `busy`, `disconnected`, `host_restarted`, `host_unreachable`, `popup_blocked`, `cancelled`, `timeout`, `master_mismatch`, `not_a_member`, `session_expired`, `unknown_function`).
- `toParent(name, message, requestId) → {target:'valuApi', name, message, requestId}`; `parseAppMessage(data) → {name, message, requestId}|null` (null unless `data.name` is a string and `data.message` is an object; `requestId` is `message.requestId`); `assertNoHostLeak(payload, where)` with the Global Constraints key list, throwing like `assertNoCredentialLeak`.
- Fakes: `FakeStorage({throwOn: 'get'|'set'|null})` (Storage-like `getItem/setItem/removeItem`); `FakeGuruSocket` (WebSocket-like: `readyState`, `send(json)` records frames, `onopen/onmessage/onclose/onerror`, helpers `open()`, `reply(requestId, {ok, data, error})`, `progress(requestId, step)`, `frame(obj)`, `drop(code)`); `fakeGuruWebSocket(opts)` → constructor recording `.urls` and `.sockets`; `FakeWindowPair()` → `{app, host}` where each has `addEventListener('message')`, `postMessage(data, targetOrigin)` that delivers to the other side with `{data, origin, source}` only when `targetOrigin === '*'` or equals the receiver's origin; `app.origin`, `host.origin`, `host.parent === app`, `host.top === app` (settable), `app.frames = [host]`; `fakeResolveFetch(table)` and `fakeAuthFetch({check: 200|401, redeem: {...}})` returning `fetch`-like functions that record calls.

- [ ] **Step 1: Write the failing tests** in `test/host/protocol.test.js`: `parseAppMessage rejects non-objects and missing name`, `toParent puts requestId at the top level`, `assertNoHostLeak throws on session_token nested in data` (`{data:{session_token:'x'}}` → throws with path `data.session_token`), `FakeWindowPair delivers only to matching targetOrigin` (post from app with `targetOrigin = host.origin` arrives; with `'https://other'` does not).
- [ ] **Step 2: Run** `node --test test/host/protocol.test.js` → FAIL (module not found).
- [ ] **Step 3: Implement** `src/host/protocol.js` and `test/helpers/hostFakes.js` per Interfaces.
- [ ] **Step 4: Run** the file → PASS; run `npm test` → 505 + new all pass.
- [ ] **Step 5: Commit** `feat(host): protocol module and host test fakes`.

### Task 2: MasterConnection (M1)

**Files:**
- Create: `src/host/MasterConnection.js`, `test/host/master-connection.test.js`
- Read: `src/socket/ValuSocketConnection.js` (states, `onConnectionLost`, `connect()` rejection), `test/helpers/fakes.js` (`fakeIo`, `readyIo`, `FakeIoSocket.drop/reopen/ready`), `/Library/Git/valusocial-web/src/Stores/Application/ApplicationStore.js:731-764` for the exact `network:switch` namespace, payload and the response field that carries the new session id.

**Interfaces:**
- Produces: `class MasterConnection { constructor({ sessionId, io, fetchImpl, host = 'api.roomful.net', reconnectGraceMs = 20_000, createConnection }) }` where `createConnection(opts)` defaults to `new ValuSocketConnection(opts)`; `connect() → Promise<{userId, networkId, user, network}>`; `switchNetwork(networkId) → Promise<{sessionId}>` (runs the `network:switch` RPC with `requestNewSessionId: true`, resolves the new session id, does **not** reconnect); `get state()` ∈ `'idle'|'connecting'|'ready'|'reconnecting'|'failed'|'closed'`; `get socket()` (the live `ValuSocketConnection`, a `ValuSocket`); `emit(ns, data, timeoutMs = 30_000) → Promise<ValuAck>` (held while `reconnecting`, up to `min(reconnectGraceMs, timeoutMs)`, then `errorAck(503, 'disconnected')`; on `failed` it closes the old instance, creates a new one with the same session, connects, then emits); `onStateChange(h) → unsub`; `onReconnected(h) → unsub`; `on(event, h) → unsub` (platform pushes, delegated); `close()`. Errors: `connect()` rejects with `Error` whose `code` is `'session_expired'` when the connection fails and `GET https://<host>/api/v1/auth/check` (header `X-Session-Id`) answers a JSON body with `error.code === 401`; otherwise `code: 'unavailable'`.

- [ ] **Step 1: Write the failing tests**: `connect resolves user and network from user_info` (uses `readyIo(responder, {userId:'u1', networkId:'n1'})`); `emit during reconnecting is held and answered after reopen` (drop the fake socket, call `emit('x')`, assert still pending after 50 ms, `reopen()` + `ready()`, assert resolved with the responder's ack); `emit answers 503 disconnected after the grace` (`reconnectGraceMs: 30`, drop, emit → ack `{error:{code:503}}` and `message` contains `disconnected`); `failed state replaces the instance on next emit` (fire the 120 s watchdog with a `FakeClock`-free approach: construct with `createConnection` returning fakes and call the fake's `onConnectionLost` handler directly; next `emit` constructs a second instance: `createConnection` called twice, first instance `close()` called); `connect rejects with session_expired when auth/check says 401` (`fakeAuthFetch({check: 401})`, `connect()` of the fake rejects → `code === 'session_expired'`); `switchNetwork sends the RPC Valu Social sends` (assert the namespace and payload copied from `ApplicationStore.js:731-764`; the fake responder answers the session field, `switchNetwork('n2')` resolves `{sessionId:'s2'}`).
- [ ] **Step 2: Run** `node --test test/host/master-connection.test.js` → FAIL.
- [ ] **Step 3: Implement** `src/host/MasterConnection.js`. Hold logic: a `#ready` promise re-armed on every `disconnect` and resolved on `onReconnected`; `emit` awaits `Promise.race([ready, timeout])`.
- [ ] **Step 4: Run** → PASS. `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(host): MasterConnection with hold-while-reconnecting and replace-on-failure`.

### Task 3: GuruClient (M1)

**Files:**
- Create: `src/host/GuruClient.js`, `test/host/guru-client.test.js`
- Read: spec §4.2 (protocol), §4.11 (backoff, online/offline).

**Interfaces:**
- Produces: `class GuruError extends Error { code; details }`; `class GuruClient { constructor({ url = 'wss://valuguru.texpo.io/', mintToken, getNetworkId, WebSocketImpl = globalThis.WebSocket, onlineSource = globalThis.navigator, addEventListener = globalThis.addEventListener, backoff = { initialMs: 1000, maxMs: 30_000 }, randomId = () => crypto.randomUUID() }) }`; `connect() → Promise<void>` (idempotent; each attempt calls `mintToken()` then opens `${url}?token=<encoded>&client=host`); `request(op, params = {}, { timeoutMs = 10_000, signal } = {}) → Promise<any>` (sends `{type:'data_request', requestId, op, params, networkId: getNetworkId()}`; resolves `data` on `ok:true`; rejects `GuruError(error.code, error.message, error.details)` on `ok:false`; `data_progress` resets the silence timer; timeout rejects `GuruError('timeout')`; abort sends `data_cancel` and rejects `GuruError('aborted')`; while not connected, requests wait for `connect()` up to `timeoutMs`); `onCommerceEvent(h) → unsub` (called with the raw `commerce_event` frame); `onStateChange(h) → unsub`; `get state()` ∈ `'idle'|'connecting'|'ready'|'reconnecting'|'offline'|'closed'`; `close()`.
- Frame filtering: only `data_response`, `data_progress`, `commerce_event` are handled; anything else is ignored; the client never sends any frame type other than `data_request` and `data_cancel`.

- [ ] **Step 1: Write the failing tests**: `connect mints a token and opens the URL with client=host`; `request resolves data and rejects GuruError with code`; `data_progress resets the silence timer` (`timeoutMs: 40`, progress at 30 ms, reply at 60 ms → resolves); `tool_call and session_event frames are ignored and nothing is sent back` (assert `socket.sent` unchanged); `reconnect mints a fresh token` (drop → second socket opened with a different token, `mintToken` called twice); `pending requests reject disconnected on drop`; `offline pauses reconnect until online` (`onlineSource.onLine = false`, drop, assert no new socket in 100 ms; dispatch `online` → socket opened).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `src/host/GuruClient.js`. Backoff: `min(maxMs, initialMs * 2^attempt) * (0.8 + 0.4 * random)`.
- [ ] **Step 4: Run** → PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(host): GuruClient with mint-per-connect and frame filtering`.

### Task 4: AppResolver and Permissions (M2/M4 groundwork)

**Files:**
- Create: `src/host/AppResolver.js`, `src/host/Permissions.js`, `test/host/app-resolver.test.js`, `test/host/permissions.test.js`
- Read: `src/services/descriptors.js` (`findDescriptor`, `scopes`, `channel`), `src/services/catalog.generated.js` (`APPLICATION_ONLY_INTENTS`).

**Interfaces:**
- `class AppResolver { constructor({ fetchImpl, baseUrl, ttlMs = 300_000, now = Date.now }) ; resolve(origin) → Promise<ResolvedApp|null> }` where `ResolvedApp = { address, workspaceId, slug, devAppId, name, homeNetworkId }`; it calls `GET ${baseUrl}/api/host/v1/resolve?origin=<encoded>`; 404 → `null` (cached too); other non-2xx → throws `Error` with `code: 'resolve_unavailable'`.
- `Permissions.js`: `const TIER_OF = Object.freeze({ 'users:read':'basic', … })` exactly §4.6 (basic 8, consent 19 minus the two `http:*` which map to `'local'`, forbidden 4), plus `'commerce:read'|'commerce:write'|'commerce:sell': 'consent'`, `'application:identity': 'basic'`; `tierOf(scope) → 'basic'|'consent'|'forbidden'|'local'|null`; `scopeOfDescriptor(descriptor) → string`; `scopeOfIntent(service, action) → string|null` (Commerce per the §4.6 lists, `Application.get-identity-token` → `'application:identity'`, else `null`); `decide({ scope, hasGrant }) → {ok:true} | {ok:false, code: 'forbidden'|'consent_required'|'unknown_function'}`.

- [ ] **Step 1: Write the failing tests**: resolver `caches a hit for ttl and a miss as null`, `throws resolve_unavailable on 500`; permissions `every one of the 27 descriptor scopes has a tier` (iterate `SERVICE_DESCRIPTORS`, assert `tierOf(scopes[0]) !== null`), `every one of the 30 valu-guru Commerce intents has a scope` (iterate `APPLICATION_ONLY_INTENTS` entries whose reason is `valu-guru` and service `Commerce`), `decide returns consent_required without a grant and ok with one`, `forbidden never asks`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** → PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(host): AppResolver and permission tiers`.

### Task 5: SessionStore and HostAuth (M3)

**Files:**
- Create: `src/host/SessionStore.js`, `src/host/HostAuth.js`, `test/host/session-store.test.js`, `test/host/host-auth.test.js`

**Interfaces:**
- `class SessionStore { constructor({ storage, key = 'valu-host:session', subscribe }) }` where `subscribe(handler)` wires the cross-tab `storage` event (injected; `(h) => globalThis.addEventListener('storage', e => e.key === key && h())` in the page); `load() → {v:1, userId, sessions:{[networkId]:{sessionId, createdAt}}}|null`; `get(networkId) → {sessionId, createdAt}|null`; `set({ userId, networkId, sessionId })`; `clear()`; `onChange(h) → unsub` (fires on external change). Any storage call that throws switches the store to an in-memory map for the rest of its life (`get storageMode()` → `'storage'|'memory'`).
- `class HostAuth { constructor({ sessionStore, fetchImpl, master = 'api.roomful.net', makeConnection }) }` where `makeConnection(sessionId) → MasterConnection`; `redeem(token, { homeNetworkId }) → Promise<{ userId, sessionId, networkId }>`: `POST https://<master>/api/v1/auth/checkOneTimeAuthToken/<encoded token>` body `{}`, valid iff 2xx and `error.status === false` and `data.user_id` non-empty, else rejects `Error` with `code:'invalid_token'`; then opens `makeConnection(session_token)`, `connect()`, and if `networkId !== homeNetworkId` calls `switchNetwork(homeNetworkId)` (a refusal rejects `code:'not_a_member'`), closes that temporary connection, stores `set({userId, networkId: homeNetworkId, sessionId})` and resolves; `restore({ homeNetworkId }) → Promise<{userId, sessionId}|null>`: reads the store, `GET https://<master>/api/v1/auth/check` with `X-Session-Id`; JSON `error.code === 401` → `clear()` and `null`; `signOut()` → `clear()`.

- [ ] **Step 1: Write the failing tests**: store `falls back to memory when setItem throws` (`FakeStorage({throwOn:'set'})`: `set` then `get` returns the session, `storageMode === 'memory'`), `keeps one session per network`, `onChange fires on external storage event`; auth `redeem rejects invalid_token when error.status is true` (the master's 200 + `{"error":{"status":true,"code":400,"message":"Not found"}}`), `redeem switches network when user_info differs from home` (fake connection reports `n1`, home `n2` → `switchNetwork('n2')` called, stored session is the switched one under `n2`), `redeem stores without switching when networks match`, `restore clears on 401`, `restore returns the session on 200`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** → PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(host): SessionStore with memory fallback and HostAuth redeem/restore`.

### Task 6: GrantsStore and CommerceIntents (M4/M5 groundwork)

**Files:**
- Create: `src/host/GrantsStore.js`, `src/host/CommerceIntents.js`, `test/host/grants-store.test.js`, `test/host/commerce-intents.test.js`
- Read: `docs/api-pointers.md:364-393` (params and answers of the 30 `valu-guru` Commerce intents), `/Library/Git/valusocial-web/src/Services/Commerce/CommerceDataService.js` (op names, params, timeouts, idempotency keys), `/Library/Git/valusocial-web/src/Services/Commerce/intents/buyerIntents.js:392-440` and `sellerIntents.js:294-673` (how each intent's params become an op call and how the answer is shaped), `/Library/Git/valusocial-web/src/Services/Commerce/commerceEvents.js:42-101` (event names and `FROM_FRAME`).

**Interfaces:**
- `class GrantsStore { constructor({ guru, appAddress }) ; has(scope) → Promise<boolean>` (first call runs `guru.request('valuguru.apps.grants.list', { appId: appAddress })`, caches the unrevoked scopes for `ttlMs = 60_000`); `grant(scopes) → Promise<void>` (`valuguru.apps.grants.grant`, then adds to cache); `invalidate()` }`.
- `COMMERCE_INTENTS`: frozen map `action → { op, scope, timeoutMs?, toParams(params, ctx), fromResult(data, params) }` for exactly the 30 actions of §4.6, where `ctx = { appId, idempotencyKey() }`; `runCommerceIntent(action, params, { guru, appId }) → Promise<any>` returns the intent's documented answer, and maps a `GuruError` to `{ success:false, code: error.code, error: error.message }`; unknown action → `{ success:false, code:'not_available', error }`.
- `mapCommerceEvent(frame, { appId, networkId, subscribed }) → { event, data }|null` exactly as `commerceEvents.js` `FROM_FRAME` (order/delivery only when `frame.appIds` includes `appId`; catalogue only when `frame.networkId === networkId`; `cart-updated` handled by the caller), returning `null` when the event is not in `subscribed`.
- `COMMERCE_APP_EVENTS`: the seven app event names from `types/valu-api.d.ts:187-194`.

- [ ] **Step 1: Write the failing tests**: grants `has lists once then answers from cache`, `grant writes through`; commerce `every §4.6 action maps to an op` (assert the 30 keys and their scopes match the spec's three lists), `list-products sends catalog.search with appId stamped from ctx, not params` (params `{appId:'evil', query:'x'}` → op params `appId === 'app-1'`), `add-to-cart answers Valu Social's shape` (fake guru returns the op's data; assert the documented answer from `docs/api-pointers.md`), `a GuruError becomes {success:false, code, error}`, `mapCommerceEvent drops order-updated for other apps and catalogue-updated for other networks`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** both modules; port the mapping action by action from the two intents files, data only.
- [ ] **Step 4: Run** → PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(host): grants cache and the 30 Commerce data intents`.

### Task 7: Local-channel functions without a socket (M6 groundwork)

**Files:**
- Modify: `src/transport/SocketTransport.js:88-118` (`callService`)
- Test: `test/socket-adapters.test.js` (add a case) or `test/host/local-channel.test.js`

**Interfaces:**
- Produces: `SocketTransport.callService` runs a handler whose `descriptor.channel === 'local'` even when `this.socket` is null; non-local functions keep answering `errorAck(503, '<key>: no socket')`.

- [ ] **Step 1: Write the failing test** `local functions run without a socket`: `new SocketTransport({ fetchImpl: fakeFetch(), config: {...} })` with no socket; `callService(findDescriptor('Time.get-local-time'), {})` resolves `{data}`; `callService(findDescriptor('Users.current'), {})` resolves `{error:{code:503}}`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**: move the no-socket check after the channel test.
- [ ] **Step 4: Run** → PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** `fix(transport): local-channel functions run without a socket`.

### Task 8: PostMessageTransport hardening (M6)

**Files:**
- Modify: `src/transport/PostMessageTransport.js:100-132`
- Test: `test/valuapi.test.js` (add cases)

**Interfaces:**
- Produces: `new PostMessageTransport({ target, hostOrigins })`; the peer is bound on the first `api:ready` whose `event.source === globalThis.parent` (when `globalThis.parent` exists and differs from `globalThis`); later messages are accepted only from that source and origin; `hostOrigins` (optional array) additionally restricts the first `api:ready`'s origin; no default list.

- [ ] **Step 1: Write the failing tests** with `FakeWindow`: `api:ready from a window other than parent is ignored`, `a second api:ready from another origin does not re-point replies` (post a request; the reply target is still the first peer), `hostOrigins rejects an origin not listed`.
- [ ] **Step 2: Run** `node --test test/valuapi.test.js` → FAIL.
- [ ] **Step 3: Implement** in `#onMessage`; keep every existing test green.
- [ ] **Step 4: Run** → PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** `fix(transport): bind the embedded peer to window.parent once`.

### Task 9: HostBridge — handshake, binding, dispatch skeleton (M2/M4)

**Files:**
- Create: `src/host/HostBridge.js`, `test/host/host-bridge.test.js`
- Read: §4.3, §4.5.

**Interfaces:**
- Consumes: Task 1 protocol, Task 4 resolver/permissions, Task 5 auth/store, Task 6 grants/commerce.
- Produces: `class HostBridge { constructor({ win, resolver, auth, sessionStore, permissions = Permissions, makeServices, makeGuru, makeGrants, commerce = CommerceIntents, config: { signInOrigins, master, hostOrigin, maxInFlight = 16, callTimeoutMs = 30_000 }, log }) }`; `start()` binds `win.addEventListener('message')` and refuses to run when `win.parent === win` or `win.parent !== win.top` (then every hello answers `host:error {code:'nested'}`); `stop()`. Dispatch by `name`: `host:hello` → bind `{origin: event.origin, app}` once (resolver miss → `host:error unknown_app`; `protocol > 1` → `protocol_unsupported`), then `restore()` the session and reply `api:ready` per §4.5 with the `host` block; `api:call` → Task 10; `api:service-intent` → Task 10; `host:auth sign-out` → `auth.signOut()`, close sockets, push `api:trigger auth signedIn:false`, reply `host:auth-completed {ok:true}`; `host:ping` → `host:pong`; the four refused names → their reply with `{error:{code:'not_available'}}`; `api:run-command` → ignored. `makeServices(masterConnection, app) → ValuServiceApi` (default `createValuServices({ socket: connection.socket, applicationId: app.slug, cache: null, fetchImpl, config:{ webBase:'https://live.valuverse.io', apiGate:'https://api.roomful.net' } })`), `makeGuru(session, app) → GuruClient` (lazy), `makeGrants(guru, app) → GrantsStore`.
- Pushes: `pushAuth()` sends `api:trigger {action:'auth', data:{signedIn, user, network}}`; `pushCommerce(event, data)` sends `api:trigger {action:'commerce', data:{event, ...data}}`.

- [ ] **Step 1: Write the failing tests** with `FakeWindowPair` and the fakes: `hello from the parent binds the origin and answers api:ready with the app address and signedIn:false`; `hello from a second origin after binding is dropped and never answered` (Review Focus 2: construct a third fake window posting with a different origin via `host.dispatch({data, origin:'https://other-ws-1.valuguru.app', source: host.parent})`; assert no post to that origin and the bound origin receives nothing new); `messages not from window.parent are ignored` (source = a different object); `nested host answers nested` (`host.top = {}` ≠ parent); `unknown app answers unknown_app`; `a message with no name is ignored without throwing` (Review Focus 5); `replies carry target valuApi and a numeric top-level requestId`; `sign-out pushes auth signedIn:false`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `HostBridge` without `api:call` / `api:service-intent` bodies (they answer `not_available` for now).
- [ ] **Step 4: Run** → PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(host): HostBridge handshake, binding and dispatch`.

### Task 10: HostBridge — calls, permissions, consent, in-flight cap (M4/M5)

**Files:**
- Modify: `src/host/HostBridge.js`
- Test: `test/host/host-bridge-calls.test.js`

**Interfaces:**
- Produces, on `api:call {service, action, params, requestId}`: `findDescriptor(`${service}.${action}`)` miss → `api:call-completed` `{error:{status:true, code:404, message:'unknown_function'}}`; signed out → `{error:{status:true, code:401, message:'sign_in_required'}}`; `validateParams` failure → its 400 ack; `tierOf` forbidden → 403 `forbidden`; consent without grant → `{error:{status:true, code:403, message:'consent_required', scope}}`; `local` channel → 501 `not_available` (the client runs those itself); otherwise `services.call(descriptor.key, params)` and the ValuAck verbatim. On `api:service-intent`: `applicationId === 'Commerce'` and action in `COMMERCE_INTENTS` → scope check, then `runCommerceIntent`; `subscribe-events {events}` replaces the app's set and answers `{success:true, events}`; `unsubscribe-events`; `applicationId === 'Application'` + `get-identity-token` → `masterConnection.emit('appManifest:getIdentityToken', { applicationId: app.slug })`, answer the ack's `data`; everything else → `{error:{code:'not_available', message}}`. Refusals for intents use `{success:false, code:'sign_in_required'|'consent_required'|'forbidden', error, scope?}`. In-flight cap: a 17th concurrent request answers `busy` at once. Consent: `requestConsent(scopes, nonce)` exposes `pendingConsent(nonce) → {app, scopes}` for the popup (Task 12) and `resolveConsent({nonce, approved, scopes})` from a message whose `event.origin === config.hostOrigin`, writes `grants.grant(scopes)` when approved, then answers the waiting `host:consent` request `{approved}`.
- `host:consent {scopes, nonce, requestId}` from the app → waits for the popup's decision → `host:consent-completed {approved}`.
- `commerce_event` frames from the Guru client → `mapCommerceEvent` → `pushCommerce`; `commerce.cart.updated` → `guru.request('valuguru.commerce.cart.get')`, count rows whose `appId === app.slug`, push `cart-updated {count}`.

- [ ] **Step 1: Write the failing tests**: `api:call Users.current runs through the services and returns the ack` (fake services object with `call` recording); `api:call unknown function answers 404`; `api:call while signed out answers 401 sign_in_required`; `consent-tier call without grant answers consent_required with the scope`; `forbidden scope answers 403 without consulting grants`; `consent approved from the host origin writes the grant and the retried call succeeds`; `consent message from the app origin is ignored` (Review Focus 1 analogue for consent); `17th concurrent call answers busy`; `Commerce list-products goes to the guru with appId stamped`; `subscribe-events then an order-updated frame for this app is pushed as api:trigger commerce`; `get-identity-token emits appManifest:getIdentityToken with the slug`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(host): calls, permission checks, consent and Commerce intents in HostBridge`.

### Task 11: HostBridge — sign-in token channel and resilience wiring (M3/§4.11)

**Files:**
- Modify: `src/host/HostBridge.js`
- Test: `test/host/host-bridge-auth.test.js`

**Interfaces:**
- Produces: a `message` whose `data.type === 'valu-host:token'` is accepted only when `event.origin` ∈ `config.signInOrigins` and `event.source !== win.parent`; `data.master !== config.master` → ignored and `pushAuth` with `reason:'master_mismatch'`; `cancelled:true` → `pushAuth {signedIn:false, reason:'cancelled'}`; otherwise `auth.redeem(token, { homeNetworkId: app.homeNetworkId })` → open the master connection → `pushAuth {signedIn:true, user, network}`; `not_a_member` → `pushAuth {signedIn:false, reason:'not_a_member'}`. Resilience: `masterConnection.onStateChange` → `api:trigger {action:'connection', data:{state}}`; on `reconnected` → `grants.invalidate()`, `api:trigger {action:'connection', data:{state:'ready', reconnected:true}}`; a `session_expired` error from the connection → `auth.signOut()` and `pushAuth {signedIn:false, reason:'session_expired'}`, every held call answered `sign_in_required`; `sessionStore.onChange` (another tab signed out) → same as sign-out without replying.
- Add `CONNECTION` trigger action to the protocol docs in `protocol.js` comments.

- [ ] **Step 1: Write the failing tests**: `a token posted by the app page is ignored` (Review Focus 1: origin = app origin, source = parent → no redeem call, nothing pushed); `a token from live.valuverse.io is redeemed and auth signedIn:true is pushed`; `a token from an unlisted origin is ignored`; `master mismatch pushes reason master_mismatch and does not redeem`; `cancelled pushes signedIn:false cancelled`; `not_a_member is pushed when the switch is refused`; `session_expired signs out and pushes the reason`; `reconnected invalidates grants and pushes connection ready`; `external storage change signs this tab out`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(host): sign-in token channel and reconnect/expiry handling`.

### Task 12: Host composition root and consent page logic (M2–M4)

**Files:**
- Create: `src/host/Host.js`, `src/host/consentPage.js`, `test/host/host.test.js`, `test/host/consent-page.test.js`

**Interfaces:**
- `createHost({ win = globalThis, io, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, storage = globalThis.localStorage, config }) → HostBridge` (started), where `config = { hostOrigin, master:'api.roomful.net', guruUrl:'wss://valuguru.texpo.io/', resolveBaseUrl:'https://valuguru.texpo.io', signInOrigins:[the four], dev:false }`; with `dev:true` a hello from an `http://localhost:*` parent may carry `message.app = '<ws>/<slug>'` which bypasses the resolver (the resolver is still consulted for other origins).
- `consentPage.js`: `runConsentPage({ win = globalThis, document, hostOrigin }) → void`: reads `nonce` from `win.location.search`; finds the host iframe among `win.opener.frames` by `try { f.location.origin === hostOrigin }` and calls `f.__valuHost.pendingConsent(nonce)` (the bridge exposes `win.__valuHost = { pendingConsent }` only on the host origin); renders app name, address and the scopes with the wording table `SCOPE_WORDING` (one plain sentence per scope; copy the Commerce sentences from `/Library/Git/valusocial-web/src/Services/Commerce/intents/consent.js` where they exist); Allow / Don't allow post `{type:'valu-host:consent', nonce, approved, scopes}` to that frame with `targetOrigin = hostOrigin` and close.

- [ ] **Step 1: Write the failing tests**: `createHost wires the bridge with the config origins` (construct with fakes, hello → `api:ready`); `dev mode accepts a localhost claim` (`dev:true`, parent origin `http://localhost:5173`, `message.app:'ws_1/demo'` → `api:ready` with that address; `dev:false` → `unknown_app`); consent `renders the pending scopes and posts the decision to the host frame only` (fake opener with two frames, one on the host origin).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(host): createHost composition root and consent page`.

### Task 13: Conformance through the host (M4)

**Files:**
- Modify: `test/conformance/suite.js:40` and `test/conformance/functions.js:1043` (accept an optional `makeServices`), `test/conformance.test.js`
- Create: `test/conformance/host-adapter.js`

**Interfaces:**
- `runConformanceSuite({ name, makeSocket, makeServices })` and `runFunctionSuite(...)`: when `makeServices(responder) → { services, push, close }` is given it is used instead of `createValuServices({ socket })`; existing callers unchanged.
- `host-adapter.js`: `makeHostServices(responder) → { services, push, close }` builds a `FakeWindowPair`, a `HostBridge` whose master connection is a `MasterConnection` over `readyIo(responder)` and whose session store already holds a session (so the bridge comes up signed in, with every consent scope pre-granted through a fake grants store), and a client `createValuServices({ transport: new HostTransport({ hostOrigin, window: pair.app, document: fakeDocumentFor(pair) }) })` (Task 14 provides `HostTransport` and `fakeDocumentFor`; until then these entries are skipped with `test.skip` and un-skipped in Task 14).
- A chaos variant: `runConformanceSuite({ name:'host adapter, dropping', makeServices })` where `push` drops and reopens the fake io socket before each case.

- [ ] **Step 1: Write the harness change and the adapter**; add `runConformanceSuite({ name:'host adapter', makeServices: makeHostServices })` and the chaos variant to `test/conformance.test.js` (skipped until Task 15).
- [ ] **Step 2: Run** `npm test` → existing adapters still PASS; host entries skipped.
- [ ] **Step 3: Commit** `test(conformance): accept makeServices and add the host adapter (skipped)`.

### Task 14: HostTransport — iframe, handshake, calls (M6)

**Files:**
- Create: `src/transport/HostTransport.js`, `test/host/host-transport.test.js`
- Read: `src/transport/Transport.js`, `src/transport/PostMessageTransport.js` (request plumbing to mirror), `src/services/ServiceClient.js:37-47,95-98,178-181`.

**Interfaces:**
- `class HostTransport extends Transport { constructor({ hostOrigin, window = globalThis, document = globalThis.document, readyTimeoutMs = 10_000, pingIntervalMs = 15_000, pingTimeoutMs = 10_000, localTransport }) }`; `get servesServiceFunctions() → true`; `open() → Promise<void>` (creates `<iframe hidden aria-hidden="true" src="${hostOrigin}/host/">`, appends to `document.body`, on `load` posts `host:hello {protocol:1, client:<package version>}` to `iframe.contentWindow` with `targetOrigin = hostOrigin`, resolves on `api:ready`, rejects `Error{code:'host_unreachable'}` after `readyTimeoutMs`, `Error{code}` on `host:error`); accepts messages only when `event.source === iframe.contentWindow && event.origin === hostOrigin`; `request(name, message, requestId)` / `notify` as `PostMessageTransport`; `callService(descriptor, params, { timeoutMs = 30_000 })`: `descriptor.channel === 'local'` → `localTransport.callService(...)` (a `SocketTransport` with no socket, Task 7); else posts `api:call {service, action, params, requestId}` and resolves the `api:call-completed` message (a ValuAck), `errorAck(408, 'timeout')` on timeout, never rejects; emits `Transport.READY` with the `api:ready` message, `Transport.TRIGGER` for `api:trigger`, `Transport.RECONNECTED` on `api:trigger {action:'connection', data:{reconnected:true}}`; `get hostState() → {signedIn, user, network, protocol, mode}`; ping every `pingIntervalMs`, and on a missed `host:pong` within `pingTimeoutMs` or an iframe `error` event: reject in-flight requests with `errorAck(503, 'host_restarted')`, remove and re-create the iframe, re-handshake once (then `host_unreachable`); `close()` removes the iframe and rejects pending with `transport closed`.

- [ ] **Step 1: Write the failing tests** with `FakeWindowPair` plus a `fakeDocumentFor(pair)` helper (add to `hostFakes.js`: `createElement('iframe')` returns an object whose `contentWindow` is `pair.host` and which fires `load` when appended): `open posts host:hello with protocol 1 and resolves on api:ready`; `open rejects host_unreachable after the timeout`; `callService posts api:call and resolves the ack`; `callService local channel never reaches the host`; `replies from a window other than the iframe are ignored`; `a reply with a string requestId is ignored` (Review Focus 5); `missed pong reloads the iframe once and fails in-flight calls with host_restarted`; `api:trigger connection reconnected emits RECONNECTED`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS; un-skip the host conformance entries from Task 13; `npm test` → PASS including both host adapters.
- [ ] **Step 5: Commit** `feat(client): HostTransport over the hidden host iframe`.

### Task 15: createValuApp (M6)

**Files:**
- Create: `src/createValuApp.js`, `test/host/create-valu-app.test.js`
- Modify: `src/ValuApi.js` (export `createValuApp`, `HostTransport`), `types/valu-api.d.ts`, `docs/connecting.md` (new section "Dedicated mode")

**Interfaces:**
- `createValuApp({ hostOrigin = 'https://valuguru.texpo.io', signInOrigin = 'https://live.valuverse.io', mode, window = globalThis, document = globalThis.document, popup = (url, name, features) => window.open(url, name, features) } = {}) → Promise<ValuApp>`. Mode: `mode` option, else `?valu-mode=dedicated` in `window.location.search`, else `'dedicated'` when `window.parent === window`, else `'embedded'`. Dedicated: `HostTransport` opened; embedded: `PostMessageTransport` (no wait for `api:ready` inside the factory; `valu.ready` resolves on it).
- `ValuApp`: `mode`; `auth = { get state() → {signedIn, user, network, reason?}, signIn() → Promise<state>` (opens the popup **synchronously** at `${signInOrigin}/auth/host`, name `'valu-signin'`, features `'popup,width=480,height=640'`; `null` → rejects `code:'popup_blocked'`; resolves on the next auth trigger with `signedIn:true`; rejects `cancelled` on `reason:'cancelled'` or when `popup.closed` is observed (poll 500 ms) before a trigger; `timeout` after 300 000 ms; `master_mismatch` / `not_a_member` from the reason), `signOut() → Promise<void>` (`host:auth`), `requestConsent(scopes) → Promise<boolean>` (opens `${hostOrigin}/host/consent.html?nonce=<random>` synchronously, posts `host:consent {scopes, nonce}`, resolves `approved`), `on('change', h) → unsub` }`; `network → {id, name}|null`; `connection = { get state(), on('change', h), lastError }`; the service tree from `createValuServices({ transport })` merged in, with consent auto-retry: a `consent_required` ack when `navigator.userActivation?.isActive` → `requestConsent([scope])` then one retry; `callService(intent)`, `sendIntent`, `onCommerceEvent`, `addEventListener` as `ValuApi`; `ready → Promise<void>`; `close()`. In embedded mode `auth.signIn` rejects `code:'not_available'` and the service tree answers 501 as today.

- [ ] **Step 1: Write the failing tests** with fakes: `top-level page is dedicated and framed page is embedded`; `?valu-mode=dedicated forces dedicated in a frame`; `signIn opens the popup synchronously before any await` (the `popup` fake records call order against a flag set by a microtask); `signIn rejects popup_blocked on null`; `signIn resolves on the auth trigger`; `signIn rejects cancelled when the popup closes first`; `consent_required with user activation opens consent and retries once`; `valu.Users.current() in dedicated mode goes through api:call`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; add the types and the docs section (what dedicated mode is, the options, the error codes, "call signIn from a click").
- [ ] **Step 4: Run** → PASS; `npm test` → PASS; `npm run typecheck` if `tsc` is available.
- [ ] **Step 5: Commit** `feat(client): createValuApp with dedicated mode, sign-in and consent`.

### Task 16: Sample app and dev run (M6)

**Files:**
- Create: `examples/dedicated/index.html`, `examples/dedicated/app.js`, `examples/dedicated/README.md`

- [ ] **Step 1: Write** a static page that imports `../../src/ValuApi.js`, calls `createValuApp({ hostOrigin: new URLSearchParams(location.search).get('host') ?? 'https://valuguru.texpo.io' })`, shows `valu.auth.state` and `valu.connection.state`, has a Sign in button (`valu.auth.signIn()` in the click handler), and three buttons: `valu.Users.current()`, `valu.Rooms.list()` (consent tier), `callService(new Intent('Commerce','list-products',{}))`, printing the ack to a `<pre>`.
- [ ] **Step 2: README**: run with `npx serve examples/dedicated -p 5173` against a dev host (`?host=http://localhost:3001`, Part B Task 21's dev build) and against production.
- [ ] **Step 3: Verify** by hand against the dev host once Part B is running: sign-in, a basic call, a consent call, a Commerce call. Record the result in the README's "Verified" line.
- [ ] **Step 4: Commit** `docs(examples): dedicated-mode sample app`.

---

## Part B — valu-guru-server (`feat/host-core`)

Worktree: `git -C /Library/Git/valu-guru-latest worktree add .claude/worktrees/host-core -b feat/host-core origin/main` (local `main` is 9 behind; base on `origin/main`). Tests: `npx vitest run src/host` (or `npm test`). Every merge to `main` deploys production: stop and ask before merging.

### File structure

| File | Responsibility |
|---|---|
| `src/host/resolve.ts` | `resolveAppByOrigin` with injected lookups and a 5-minute domain-list cache. |
| `src/host/routes.ts` | `GET /api/host/v1/resolve`, `GET /host/*` static with headers, rate limit. |
| `src/host/grants.ts` | `vg_app_grants` access and the three op handlers. |
| `supabase/migrations/20261021120000_app_grants.sql` | The table. |
| `src/valuguru/connection-auth.ts`, `src/index.ts` (modify) | `client=host` flag. |
| `host/index.html`, `host/consent.html`, `host/src/index.ts`, `host/src/consent.ts`, `scripts/build-host.mjs` | The host page and its esbuild bundle. |

### Task 17: Resolve endpoint (M2)

**Files:**
- Create: `src/host/resolve.ts`, `src/host/resolve.test.ts`, `src/host/routes.ts`, `src/host/routes.test.ts`
- Modify: `src/index.ts:4840` area (mount `createHostRouter()` next to the App API router, before `terminalErrorHandler`)
- Read: `src/site-address.ts:146-175` (`parseSiteSlug`, `parseSiteHost`), `src/project-domains.ts:230+` (`ManagedDomain`, `listManagedDomains`), `src/app-api/rate-limit.ts` (`perIp`, `RateLimitExceeded`), `src/app-api/routes.ts` (router pattern, supertest tests in `routes.test.ts`), `supabase/migrations/085_workspaces.sql:32-46,151-165` (`vg_workspaces.network_id`, `vg_projects` columns).

**Interfaces:**
- `export type ResolvedApp = { address: string; workspaceId: string; slug: string; devAppId: string | null; name: string; homeNetworkId: string }`.
- `export async function resolveAppByOrigin(origin: string, deps: ResolveDeps): Promise<ResolvedApp | null>` with `ResolveDeps = { parseSiteHost, listDomains: () => Promise<ManagedDomain[]>, findProject: (workspaceId, slug) => Promise<{ id, workspace_id, slug, name, dev_app_id } | null>, findWorkspace: (id) => Promise<{ id, network_id } | null>, now?: () => number }`; `export function createResolver(deps): { resolve(origin) }` caching `listDomains()` for 300 000 ms. Rules: origin must be `https://` and end with `.` + `siteDomain()`; a host that `parseSiteHost` accepts gives `(workspaceId, slug)`; a pretty host (`<label>.<siteDomain>`) is looked up in the domain list by `domain === host` → `(userId, appName)`; in both cases the project must exist **and** the domain list must contain a row with `domain === host`, `userId === workspaceId`, `appName === slug`; else `null`.
- `export function createHostRouter({ resolver, staticDir, cspFrameAncestors = 'https://*.valuguru.app' }): Router` with `GET /api/host/v1/resolve?origin=` → `200 {ok:true, app}` with `Cache-Control: public, max-age=300`, `404 {ok:false, error:{code:'unknown_app'}}`, `400 {ok:false, error:{code:'bad_origin'}}` for a missing/invalid origin, `429` from `perIp`; `GET /host/` and `GET /host/consent.html` and `GET /host/assets/*` from `staticDir` with the headers of §4.3 (`Content-Security-Policy` built from `cspFrameAncestors`, `Referrer-Policy`, `X-Content-Type-Options`, `Cache-Control: no-cache` for HTML and `public, max-age=31536000, immutable` for `/host/assets/*`).

- [ ] **Step 1: Write the failing tests**: resolve `site host resolves to its project when the domain list confirms it`; `site host whose domain row belongs to another project is null` (the resolve spoofing case: `evil-ws-1.valuguru.app` parses, but the list row for that host has `appName:'other'`); `pretty host resolves through the domain list`; `http origin is null`; `domain list is fetched once per 5 minutes`; routes `resolve answers 200 with cache headers`, `404 unknown_app`, `400 bad_origin`, `host page carries frame-ancestors and nosniff`, `assets are immutable`.
- [ ] **Step 2: Run** `npx vitest run src/host` → FAIL.
- [ ] **Step 3: Implement** both files and mount the router in `index.ts` (static dir `path.join(__dirname, '..', 'host')` in dist terms: `dist/host`, see Task 21).
- [ ] **Step 4: Run** → PASS; `npm test` → PASS; `npm run build` → OK.
- [ ] **Step 5: Commit** `feat(host): origin → app resolve endpoint and host static router`.

### Task 18: Grants table and ops (M4)

**Files:**
- Create: `supabase/migrations/20261021120000_app_grants.sql`, `src/host/grants.ts`, `src/host/grants.test.ts`
- Modify: `src/valuguru/socket.ts` (three cases in the op switch, next to `valuguru.apps.checkUrl`)
- Read: `scripts/migrations/plan.mjs:19-45` (naming and forbidden statements), `src/valuguru/socket.ts:230-260` (how a case reads `userId`, params and answers), `src/db.ts` (supabase client).

**Interfaces:**
- SQL: `create table if not exists vg_app_grants (user_id text not null, app_id text not null, scope text not null, granted_at timestamptz not null default now(), revoked_at timestamptz, primary key (user_id, app_id, scope));` plus `create index if not exists vg_app_grants_user_app on vg_app_grants (user_id, app_id);`. No `BEGIN`/`COMMIT`.
- `grants.ts`: `KNOWN_SCOPES: ReadonlySet<string>` (the 27 descriptor scopes read from `@arkeytyp/valu-api`'s `SERVICE_DESCRIPTORS` at module load, plus `commerce:read`, `commerce:write`, `commerce:sell`, `application:identity`); `listGrants(db, userId, appId?) → Promise<Grant[]>` with `Grant = { appId, scope, grantedAt, revokedAt }`; `grantScopes(db, userId, appId, scopes[]) → Promise<void>` (upsert, `revoked_at = null`, `granted_at = now()`); `revokeScopes(db, userId, appId, scopes?) → Promise<void>` (sets `revoked_at`); each validates `appId` non-empty and every scope ∈ `KNOWN_SCOPES`, else throws an error that `socket.ts` maps to `validation_failed`.
- Ops: `valuguru.apps.grants.list {appId?}` → `{grants}`; `valuguru.apps.grants.grant {appId, scopes}` → `{ok:true}`; `valuguru.apps.grants.revoke {appId, scopes?}` → `{ok:true}`; all use `connectionUserId`.

- [ ] **Step 1: Write the failing tests** (with the in-memory/mocked db pattern the repo's other tests use; check `src/app-api/*.test.ts` for the fixture): `grant then list returns the scope unrevoked`; `revoke sets revokedAt and list still returns it`; `unknown scope is refused`; `list is scoped to the user`; `node scripts/migrations/check.mjs` accepts the new file.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the migration, module and the three switch cases.
- [ ] **Step 4: Run** → PASS; `npm run db:auto:check` → OK; `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(host): app grants table and valuguru.apps.grants ops`.

### Task 19: `client=host` connections (M3)

**Files:**
- Modify: `src/valuguru/connection-auth.ts:29-37,131-182` (`ValuguruAuth` gains `client?: 'host'`; `parseConnectionParams` returns `{ token, client }`), `src/index.ts` around 4963-5015 and 7352
- Read: `src/server-agents/session-tokens.ts` (`hasUserSessionToken`, how `invalidated_at` is exposed; add `isUserSessionTokenValid(userId): boolean` if nothing answers "present and not invalidated").
- Test: `src/valuguru/connection-auth.test.ts` (extend), `src/host/host-connection.test.ts` (new, if `index.ts` logic is extracted into `src/host/connection-policy.ts`: `shouldStoreSessionToken({ client, hasValidToken }) → boolean`, `shouldCloseIdleOnDisconnect({ client }) → boolean`).

**Interfaces:**
- `parseConnectionParams(url) → { token: string | null; client: 'host' | null }` (any other `client` value → `null`).
- `shouldStoreSessionToken({ client, hasValidToken })` → `client !== 'host' || !hasValidToken`; `shouldCloseIdleOnDisconnect({ client })` → `client !== 'host'`. `index.ts` uses both at the two sites.

- [ ] **Step 1: Write the failing tests**: `parseConnectionParams reads client=host and ignores other values`; policy `host connection does not overwrite a valid token`, `host connection stores when none or invalid`, `web connection always stores`, `host disconnect does not close the idle pooled socket`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; wire `index.ts`.
- [ ] **Step 4: Run** → PASS; `npm test` → PASS; `npm run build` → OK.
- [ ] **Step 5: Commit** `feat(host): client=host connections keep the user's pooled session`.

### Task 20: Pin valu-api and add the host build (M2/M5)

**Files:**
- Modify: `package.json` (`@arkeytyp/valu-api` → `github:Roomful/valu-api#<sha of Part A's branch head once merged to main>`, devDependency `esbuild`, script `"build:host": "node scripts/build-host.mjs"`, and `"build": "tsc && npm run build:host"`), `Dockerfile` (the `COPY src ./src` stage also copies `host ./host` and `scripts/build-host.mjs`; `dist/host` lands in the runtime image), `.dockerignore` if present
- Create: `host/index.html`, `host/consent.html`, `host/src/index.ts`, `host/src/consent.ts`, `scripts/build-host.mjs`, `src/host/static.test.ts`

**Interfaces:**
- `host/src/index.ts`: `import { createHost } from '@arkeytyp/valu-api/src/host/Host.js'; import io from 'socket.io-client'; createHost({ io, config: HOST_CONFIG })` where `HOST_CONFIG` comes from `host/src/config.ts` (`hostOrigin`, `signInOrigins`, `master`, `guruUrl`, `resolveBaseUrl`, `dev: process.env.HOST_DEV === '1'` baked at build time via esbuild `define`).
- `host/src/consent.ts`: `runConsentPage({ hostOrigin })`.
- `scripts/build-host.mjs`: esbuild `bundle: true, format: 'iife', target: 'es2020', minify: true, entryPoints: { index: 'host/src/index.ts', consent: 'host/src/consent.ts' }, outdir: 'dist/host/assets', entryNames: '[name]-[hash]'`, then copies `host/*.html` into `dist/host/` rewriting `<script src>` to the hashed names. `HOST_DEV=1` sets `dev:true` and `cspFrameAncestors` gains `http://localhost:* http://127.0.0.1:*` (Task 17's router reads an env `HOST_FRAME_ANCESTORS` override).
- Interim pin: until Part A is merged, pin the branch head sha of `feat/host-core` so the server can build; the final sha is set in Task 24.

- [ ] **Step 1: Write the failing test** `src/host/static.test.ts`: after `node scripts/build-host.mjs`, `dist/host/index.html` exists and references an existing `assets/index-*.js`; the bundle contains no `socket.io-client` dynamic import string and no `process.env` reference.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the pages, the entries, the build script, the package and Dockerfile changes; `npm ci`.
- [ ] **Step 4: Run** `npm run build` → OK, test → PASS; `docker build .` → OK (if Docker is available; otherwise note it for Task 24).
- [ ] **Step 5: Commit** `feat(host): build and serve the host page from valu-api`.

### Task 21: Local dev run of the host (M6 support)

- [ ] **Step 1:** `HOST_DEV=1 HOST_FRAME_ANCESTORS="https://*.valuguru.app http://localhost:* http://127.0.0.1:*" npm run dev` serves `http://localhost:3001/host/` with the dev build; verify `curl -sI http://localhost:3001/host/ | grep -i content-security-policy` shows the localhost entries and `curl -s "http://localhost:3001/api/host/v1/resolve?origin=https://x-ws-1.valuguru.app"` answers 404 JSON.
- [ ] **Step 2:** Document the two commands in `host/README.md`. Commit `docs(host): local dev run`.

---

## Part C — valusocial-web (`feat/host-signin`)

Worktree: `git -C /Library/Git/valusocial-web worktree add .claude/worktrees/host-signin -b feat/host-signin develop`. Tests: `npx vitest run src/Applications/AuthApplication`. A push to `develop` deploys the dev web (`texpo.io`): ask Pavlo first.

### Task 22: Host handoff helpers and the `/auth/host` page (M3)

**Files:**
- Create: `src/Applications/AuthApplication/pages/hostHandoff.js`, `src/Applications/AuthApplication/pages/hostHandoff.test.js`, `src/Applications/AuthApplication/pages/AuthHostPage.jsx`, `src/Configs/HostHandoffConfig.js`
- Modify: `src/Stores/Auth/AuthStore.js:17-26` (`Host: 'host'`), `src/Applications/AuthApplication/AuthApplication.jsx:87-125` (route the page; it must render **without** requiring `token`), `.valu-build.json` (per platform `"host": { "origin": "https://valuguru.texpo.io", "master": "api.roomful.net" }`), `packages/vite-extensions.js` (expose that object as `window.__BUILD_INFO__.host` next to the existing build info; follow `buildInfoPlugin`)
- Read: `AuthTokenPage.jsx:56-110` (how the page mints with `network.Post(MetaverseApi.auth.getOneTimeAuthToken, {}, …)` and reads `data.token`), `AuthAccountPage.jsx:56-62` (how `callback` is honoured), `src/Drivers/MetaverseApi/MetaverseApi.js:1-14` (`PROD_HOST`/`DEV_HOST` selection), `src/application.jsx:100` (auth hosts render only the Auth app).

**Interfaces:**
- `hostHandoff.js`: `export function postTokenToHost({ opener, token, master, hostOrigin }) → number` (posts `{type:'valu-host:token', token, master}` to every `opener.frames[i]` with `targetOrigin = hostOrigin`, returns the count; `opener` null → 0); `export function postCancelToHost({ opener, hostOrigin }) → number`; `export function appHostFromReferrer(referrer) → string|null` (hostname of `document.referrer`, null if empty/invalid).
- `HostHandoffConfig.js`: `export function hostHandoffConfig() → { origin, master }` from `window.__BUILD_INFO__.host`, falling back to `{ origin: 'http://localhost:3001', master: MetaverseApi host }` in dev.
- `AuthHostPage.jsx`: when `applicationStore.sessionId` is empty → `navigate('/auth/login?callback=/auth/host')`; else shows "Continue to <appHost>" (or "Continue" when unknown), Continue → mint → `postTokenToHost` → `window.close()`; Cancel → `postCancelToHost` → `window.close()`; errors shown with `Notice`.

- [ ] **Step 1: Write the failing tests** (jsdom): `postTokenToHost posts to every frame with the host origin and never with *`; `postTokenToHost returns 0 without an opener`; `appHostFromReferrer returns the hostname`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** helpers, config, page, routing and build config.
- [ ] **Step 4: Run** → PASS; `npm run lint` → clean; `npm run build` → OK and `dist` contains the page route (it is an SPA route; verify `AuthApplication` renders it in `vite preview` at `/auth/host`).
- [ ] **Step 5: Commit** `feat(auth): /auth/host page hands a one-time token to the valu-api host iframe`.

### Task 23: Dev-web deploy for M3 (needs Pavlo)

- [ ] **Step 1:** Rebase `feat/host-signin` on `develop`; ask Pavlo to approve the push to `develop` (deploys `texpo.io` and `dev.texpo.io`).
- [ ] **Step 2:** After deploy: `curl -s https://texpo.io/ | grep -o '__BUILD_INFO__[^<]*'` shows the `host` object; open `https://texpo.io/auth/host` signed out → redirected to login; signed in → the Continue page.
- [ ] **Step 3:** From the sample app (Task 16) with `createValuApp({ signInOrigin: 'https://texpo.io', hostOrigin: <dev or prod host> })`, complete a sign-in in Chrome, Safari macOS and the iOS simulator; record the outcome in the spec's M3 row.

---

## Part D — Integration and release (M7)

### Task 24: Pin, merge order, deploy

- [ ] **Step 1:** Part A merged to valu-api `main` (after review); note the sha.
- [ ] **Step 2:** valu-guru-server `package.json` pin → that sha; `npm ci`; `npm run build`; `npm test`; commit `chore: pin valu-api <sha>`.
- [ ] **Step 3:** Ask Pavlo; merge valu-guru-server `feat/host-core` to `main` (production deploy + migration). Watch `curl https://valuguru.texpo.io/version` for the new commit, then `curl -sI https://valuguru.texpo.io/host/ | grep -iE 'content-security-policy|x-content-type'` and `curl -s 'https://valuguru.texpo.io/api/host/v1/resolve?origin=https://test-app-ws-<ws>.valuguru.app'`.
- [ ] **Step 4:** Ask Pavlo about a production web deploy (`prod_deploy.yml`) so `live.valuverse.io` gets `/auth/host`; until then the sample app uses `signInOrigin: 'https://texpo.io'`.

### Task 25: Cross-browser and drop matrix

- [ ] **Step 1:** With the sample app on its `*.valuguru.app` host against production, run in Chrome, Safari macOS, iOS Safari (simulator), Firefox: sign-in (already signed in / signed out), reload keeps the session, basic call, consent call (allow and deny), Commerce `list-products` → `add-to-cart` → `get-cart` → `cart-updated`, sign-out, cancel, popup blocked (Chrome with popups blocked), master mismatch (`signInOrigin: 'https://dev.texpo.io'`).
- [ ] **Step 2:** Drop tests (§4.11): toggle Wi-Fi off/on during a call (held, then answered), sleep the laptop 2 minutes (reconnects, `connection` state visible), iOS airplane mode on/off, kill the host iframe from DevTools (`host_restarted` then recovery), revoke the session (sign out of Valu Social in another tab → `session_expired`).
- [ ] **Step 3:** Record the matrix in `docs/superpowers/specs/2026-10-20-m7-matrix.md` next to the spec; fix what fails in the owning task; commit.

---

## Self-review notes

- Spec coverage: §4.2 → Tasks 2–3; §4.3 → 9, 11, 17, 20; §4.4 → 5, 11, 15, 22; §4.5 → 1, 9, 10, 14; §4.6 → 4, 6, 10, 12, 18; §4.7 → 6, 9, 10; §4.8 → 7, 8, 14, 15; §4.9 → 17–20; §4.10 → 22; §4.11 → 2, 3, 11, 14, 25; §5 M0 → Milestone 0; §5 "Protocol versioning" → 9 (`protocol_unsupported`). M8–M10 get their own plans after M7.
- Interfaces named identically across tasks: `MasterConnection.{connect,emit,switchNetwork,onStateChange,onReconnected,socket,state}`, `GuruClient.{connect,request,onCommerceEvent,onStateChange,state,close}`, `SessionStore.{get,set,clear,onChange,storageMode}`, `HostAuth.{redeem,restore,signOut}`, `HostBridge.{start,stop,pendingConsent,resolveConsent,pushAuth,pushCommerce}`, `HostTransport.{open,callService,hostState,close}`, `createValuApp(...).{mode,auth,network,connection,ready,close}`.
- Review Focus 1–5 have tests in Tasks 11, 9, 2, 5, 9/14; the resolve spoofing case has one in Task 17.
