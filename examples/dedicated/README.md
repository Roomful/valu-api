# Dedicated-mode sample

One static page that shows a page on its own origin using Valu through a host
(`docs/connecting.md`, "Dedicated mode"). It signs a user in through a popup,
reads who they are, and makes one call of each kind the host tells apart:

| button | what it is | what the host needs |
|---|---|---|
| Sign in | `valu.auth.signIn()`, from the click | nothing: it opens the sign-in window |
| Users.current() | a service function, `users:read` | a signed-in user |
| Rooms.searchMyRooms() | a service function, `rooms:read` | the user's consent for this app |
| Commerce list-products | `callService(new Intent('Commerce', 'list-products', {}))`, `commerce:read` | the user's consent for this app |

The page shows `valu.auth.state` and `valu.connection.state` live (it re-renders on
both `change` events) and prints each answer into the box at the bottom: an `ok`
or `refused: code, message` line, then the ack itself. A key that looks like a
credential (`token`, `secret`, `session` ...) is printed as `[hidden]`.

There is no `Rooms.list()` in the catalogue; `Rooms.searchMyRooms({ filter: 'all', size: 5 })`
is the rooms read the button runs. The consent window opens by itself the first time
a consent call is clicked (the client repeats the call once the user allows it); if the
browser blocks that window, click the button again.

No bundler, no dependencies: `index.html` loads `app.js`, which imports
`../../src/ValuApi.js`. Serve the repository root, not this folder, so that path resolves.

## Query parameters

All optional.

| parameter | is | default |
|---|---|---|
| `host` | where the host is served (`hostOrigin`) | `https://valuguru.texpo.io` |
| `signin` | the Valu brand the sign-in popup opens on (`signInOrigin`) | `https://live.valuverse.io` |
| `app` | the app's address, `<workspace>/<slug>` (`app`) | none |

`app` is for a dev host only: a host built in dev mode serves a page on `localhost`
under the address it is given. A production host ignores it and finds the app from
the page's origin.

## Run it against the local dev host

The host is the Part B dev bundle on `http://localhost:3001`, and the sign-in page
is `http://localhost:3006`. From the repository root:

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

## Run it against production

The production host finds the app from the page's own origin, so the page has to be
served from an origin that is published as an app's address. Copy `examples/dedicated/`
and `src/` to that origin, keeping the relative path `../../src/`, and open the page
with no query string:

```
https://<the app's published origin>/examples/dedicated/
```

A `localhost` page is not a published origin: production answers it `unknown_app`.
Pass `?host=` or `?signin=` only to point at another host or another Valu brand
(`?signin=https://chabaduniverse.com` for a Chabad-network app).

## Verified

Verified: pending (controller runs the signed-in check)
