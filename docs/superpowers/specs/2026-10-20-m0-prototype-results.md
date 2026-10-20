# M0 prototype results (2026-10-20, evening)

Throwaway prototype per spec §6: a host page with only the socket core and
storage, a popup page, and a test app. Served from `http://localhost:8080`
(host) and `http://127.0.0.1:8081` / `http://localhost:8081` (app), which
gives a cross-site and a same-site case without publishing anything. Tokens
were minted from the signed-in `localhost:3005` page (user `68vc5c06642t84`,
network `roomful`). Browsers: the Claude in-app browser (Chromium 10_15 UA),
Playwright Chromium 1228, iOS Safari on the iPhone 17 Pro simulator (iOS 26.4).
Not yet measured: Safari macOS, a browser restart, 24 h in Safari, the popup
on iOS (needs a tap; Pavlo tests in M7).

## Answers to the four questions

| # | Question | Answer |
|---|---|---|
| 1 | Session survives a reload? | **Yes everywhere tried.** Chrome top-level: yes. Chrome **same-site** iframe (`localhost:8081` framing `localhost:8080`): the iframe sees the session stored by the top-level visit, i.e. same-site = first-party storage. Chrome **cross-site** iframe (`127.0.0.1:8081` framing `localhost:8080`): the iframe does **not** see the top-level session (partitioned), and a session stored inside the partition **survives reloads**. iOS Safari cross-site iframe: partitioned and survives reloads (checked at +45 s). |
| 2 | Does the `{sessionId}` door connect to the real master, and in which network? | **Yes**: `user_info` arrives in 0.7–0.8 s in Chrome and iOS Safari; `Users.current()` answers in ~190 ms; the Guru socket opens in 0.6–1.1 s and answers `valuguru.commerce.cart.get` with `{items: []}`. `user_info.network.id` is `roomful`, the minting session's network: **the redeemed session keeps its network**. |
| 3 | Is `checkOneTimeAuthToken`'s `session_token` the minting session or a new one? | **The same session**: its SHA-256 prefix equals the `localhost:3005` session's (`b894a5cf0f18`, 36 chars). Consequences: sign-out in the host must only clear the host's storage (revoking would sign the user out of Valu Social); a host Guru connection does not change `vg_session_tokens` (same token); the `network:switch {requestNewSessionId:true}` path must create a *separate* session, which it does by design. |
| 4 | Popups | Chromium: `window.open` from a sync click opens; opened **after a 1.5 s await it still opens** (within the transient-activation window); `window.opener.frames[i].postMessage(token, hostOrigin)` reaches the host iframe (`source is parent? false`), the host redeems and connects, and the popup closes itself. The Claude in-app browser turns popups into same-tab navigations (`opener` null), so it cannot test this; Playwright can. iOS: not tapped yet. |

## Bugs and facts for the core

- **`fetchImpl` must be bound.** Passing `fetch` unbound makes `init.client` fail with "Illegal invocation" (Chrome) / "Can only call … on instances of Window" (WebKit). `ValuSocketConnection`'s own default binds it; the host must pass `fetch.bind(globalThis)` or omit it. The connection still became ready because `init.client` is best-effort.
- `auth/check` answers 200 with `error.status:false` and no `data` for a valid session.
- `checkOneTimeAuthToken` answers 200 for a valid token with `error:{status:false, code:200}` and `data.{user_id, session_token, is_new, need_verification}`.
- `location.ancestorOrigins` is available in Chrome and iOS Safari and reports the framing origin.
- The in-app browser is Chromium and fine for everything except popups.
- Remote logging (`POST /log`) from the pages to the prototype server worked from the iOS simulator over `localhost`.

## Decision

Continue. Nothing killed the approach. The same-site finding strengthens the
later option of a same-site host (`host.valuguru.app`) for Workspaces apps:
it would share storage with every app on the site without partitioning.
