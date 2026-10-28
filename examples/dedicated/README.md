# Dedicated-mode sample

One static page that shows a page on its own origin using Valu through a host
(`docs/connecting.md`, "Dedicated mode"). It signs a user in through a popup,
reads who they are, and makes one call of each kind the host tells apart:

| button | what it is | what the host needs |
|---|---|---|
| Sign in | `valu.auth.signIn()`, from the click | nothing: it opens the sign-in window |
| Users.current() | a service function, `users:read` | a signed-in user |
| Rooms.searchMyRooms() | a service function, `rooms:read` | the user's consent for this app |
| Commerce list-products | `callService(new Intent('Commerce', 'list-products', {}))`, `commerce:read` | the user's consent for this app, which the page asks for itself (below) |

The page shows `valu.auth.state` and `valu.connection.state` live (it re-renders on
both `change` events) and prints each answer into the box at the bottom: an `ok`
or `refused: code, message` line, then the ack itself. A key that looks like a
credential (`token`, `secret`, `session` ...) is printed as `[hidden]`.

There is no `Rooms.list()` in the catalogue; `Rooms.searchMyRooms({ filter: 'all', size: 5 })`
is the rooms read the button runs. It is a service function, so the library does the
consent: the first time it is clicked the host refuses it `consent_required`, the client
opens the consent window from the click and, once the user allows it, repeats the call
once. If the browser blocks that window, click the button again.

A Commerce intent is different: the client does not retry intents, so `callService` gets the
host's refusal as it is, `{success: false, code: 'consent_required', scope}`. The Commerce
button handles that itself, from the same click: it calls
`valu.auth.requestConsent([scope])`, and when that resolves `true` it repeats the intent
once. The box prints the refusal, the consent outcome and the second ack.

No bundler, no dependencies: `index.html` loads `app.js`, which imports
`../../src/ValuApi.js`. Serve the repository root, not this folder, so that path resolves.

## Query parameters

All optional, and honoured only when the page is served from `localhost` or
`127.0.0.1`: anywhere else the sample ignores them and uses the defaults, so a link
cannot point a deployed copy at another host or sign-in page.

| parameter | is | default |
|---|---|---|
| `host` | where the host is served (`hostOrigin`) | `https://valuguru.texpo.io` |
| `hostPath` | where on that origin the host page is (`hostPath`); `/` for the web host | `/host/` |
| `signin` | the Valu brand the sign-in popup opens on (`signInOrigin`) | `https://live.valuverse.io` |
| `app` | the app's address, `<workspace>/<slug>` (`app`) | none |
| `hostOrigins` | embedded only: the origins of the Valu Social that frames the page, comma-separated (`hostOrigins`) | the Valu origins the host trusts for sign-in |

`app` is for a dev host only: a host built in dev mode serves a page on `localhost`
under the address it is given. A production host ignores it and finds the app from
the page's origin.

## Run it against the local dev host

You need three things running: the host on `http://localhost:3001`, the sign-in
page on `http://localhost:3006`, and this page.

1. **The host.** In the valu-guru-server checkout (branch `feat/host-core`), follow
   `host/README.md`, "Local development": build a dev bundle with
   `HOST_DEV=1 HOST_ORIGIN=http://localhost:3001 HOST_RESOLVE_BASE_URL=http://localhost:3001`,
   add `HOST_SIGN_IN_ORIGINS=http://localhost:3006` to that build so the host accepts
   a token from the sign-in page, and run the server with `HOST_FRAME_ANCESTORS` and
   `HOST_STATIC_DIR` as it says. A `HOST_DEV=1` build is what lets a `localhost`
   page name its app.
2. **The sign-in page.** In the valusocial-web checkout on branch `feat/host-signin`
   (it has the `/auth/host` page), run `npx vite --port 3006`. Its dev server hands
   the token to a host on `http://localhost:3001`, which is why the host above is on
   that port: the two origins belong together
   (`docs/connecting.md`, "The two origins belong together").
3. **This page.** From this repository's root:

```sh
npx serve . -p 5173 --no-clipboard
```

Then open

```
http://localhost:5173/examples/dedicated/?host=http://localhost:3001&signin=http://localhost:3006&app=ws_057a1a6e/valu-api-sample
```

The dev app address is `ws_057a1a6e/valu-api-sample`. Without `app` the dev host
asks the server who `http://localhost:5173` is, gets no answer, and the page shows
`createValuApp failed` with `resolve_unavailable` (or `unknown_app`).

Signed out, the connection reads `signed_out` and every call prints a refusal with
`sign_in_required`. Press Sign in, finish the popup, and the Auth tile shows the user.

To try it embedded, have a local Valu Social on `http://localhost:3007` frame the page at `http://localhost:5174/examples/dedicated/?hostOrigins=http://localhost:3007`: a local origin is not trusted with the service calls unless the page names it.

## Run it against production

The production host finds the app from the page's own origin, so the page has to be
served from an origin that is published as an app's address. Copy `examples/dedicated/`
and `src/` to that origin, keeping the relative path `../../src/`, and open the page
with no query string:

```
https://<the app's published origin>/examples/dedicated/
```

A `localhost` page is not a published origin, so it cannot use the production host
(`docs/connecting.md`, "What the host serves"). `?host=`, `?signin=`, `?app=` and `?hostOrigins=` are
conveniences of this sample for development, and they only work on `localhost` and
`127.0.0.1`; on a published origin the page always uses the defaults. A real app
passes its options in code (`signInOrigin: 'https://chabaduniverse.com'` for a
Chabad-network app) or takes the defaults.

## Verified

Verified: 2026-10-21 in Chromium (Playwright) against the local dev host on :3001 (dev bundle, Guru on the same local server) and the sign-in page on :3006. Sign-in through `/auth/host`; the session kept across a reload; `Users.current()` (basic tier); `Rooms.searchMyRooms()` through the consent window (a `rooms:read` grant stored); the Commerce intent through the page's explicit `requestConsent` (a `commerce:read` grant stored). Not yet verified: the production host, Safari, iOS.
