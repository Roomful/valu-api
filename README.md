# Valu API

`@arkeytyp/valu-api` is the JavaScript package a Valu app uses to talk to Valu: the signed-in user, rooms, chat, resources, Commerce, and Valu Social's own windows and docks.
The same code runs in both places an app lives:

- **Inside Valu Social** (*embedded*): Valu Social frames the app. The user is Valu Social's, and Valu Social answers the app's calls. Nothing is asked of the user.
- **At its own address** (*dedicated*): a `*.valuguru.app` page, or a page on your own domain. The package signs the user in through a Valu popup and runs every call through a hidden Valu host, which checks the app's permissions. No session or token ever reaches your page.

One entry point covers both: `createValuApp()`.

## Installation

```bash
npm install @arkeytyp/valu-api@^2
```

A page with no build step imports the same version as an ES module:
`https://cdn.jsdelivr.net/npm/@arkeytyp/valu-api@2/src/ValuApi.js`.
Version 1 (`1.1.3` and older) has no `createValuApp` and none of what follows.

## Quick Start

```javascript
import { createValuApp } from '@arkeytyp/valu-api';

// Framed by Valu Social it is embedded; a top-level page is dedicated. Same code.
const valu = await createValuApp();
await valu.ready;

valu.auth.on('change', render);
render(valu.auth.state);

async function render({ signedIn }) {
  if (!signedIn) {
    // Only at the app's own address: inside Valu Social the user is already signed in.
    signInButton.hidden = false;
    return;
  }
  signInButton.hidden = true;

  const { user } = await valu.data.Users.current();   // the payload; throws on an error
  show(user, valu.network);                            // {id, name} of the user's network
}

// The browser opens the sign-in popup only from a click: call signIn() first thing in the handler.
signInButton.onclick = () => valu.auth.signIn().catch((error) => showError(error.code));
```

- `valu.Users.current()` resolves the envelope `{data} | {error}` and never rejects; `valu.data.Users.current()` resolves the payload and throws `ValuServiceError`. Every service function comes in both forms.
- `valu.mode` is `'embedded'` or `'dedicated'`. Hide controls that only make sense inside Valu Social (expand, close, the dock pickers) when it is `'dedicated'`.
- Every function, with its params and what it returns: [docs/service-api.md](docs/service-api.md). The options, sign-in, consent, errors and connection states: [docs/connecting.md](docs/connecting.md).

## Calling Valu

Everything is on the object `createValuApp()` returns, in both modes:

| What | How |
|---|---|
| **Service functions**: users, rooms, communities, chat, resources, events, CMS, storage … | `valu.data.Networks.getCurrentNetwork()`, `valu.data.CMS.resourceSearch({ communityId, channelId })` |
| **Valu Social's intents as functions**: Commerce, the identity token, expand/close, the pickers | `valu.data.Commerce.getCart()`, `valu.Commerce.openCart()`, `valu.data.Application.getIdentityToken()`, `valu.CMS.pickResource({ sources })` |
| **Other apps' intents as functions**: open a chat, a room, a profile, Calendar, My Cart … | `valu.Chats.openChannel({ userId })`, `valu.Rooms.showRoom({ roomId })`, `valu.Calendar.openCalendar({ source })`, `valu.MyCart.openCart()`: the app's title is the namespace, the action the method. Every one also takes `route` |
| **Any app, by id** | `valu.Apps.open(appId, { route })`, `valu.Apps.send(appId, action, params)` (a framed or Developer Portal app too), `valu.Apps.isLoaded(appId)`, `valu.Apps.list()`, `valu.Apps.has(appId)` |
| **Your app's own route inside Valu Social** | `valu.route.push(path)`, `valu.route.replace(path)`, `valu.onRoute(handler)` |
| **A call by name** (an LLM tool call, a string from config) | `valu.call('Rooms.searchMyRooms', params)` (envelope) or `valu.invoke(...)` (payload) |
| **The user and the network** | `valu.auth.state` (`{signedIn, user, network}`), `valu.auth.on('change', handler)`, `valu.network` |
| **Commerce events** | `valu.onCommerceEvent(handler)`, after subscribing (see [Commerce Events](#commerce-events)) |
| **Lifecycle** | `valu.bridge.setApplication(app)` (see [Handling Application Lifecycle](#handling-application-lifecycle)) |

Write function names and app ids as literals (`valu.data.Users.current()`, `valu.Apps.open('events')`): the permission check reads your source for them (see [Permissions](#permissions)).

An intent at the app's own address does what its mode says (each function's line in [docs/service-api.md](docs/service-api.md) names it): one that opens a window opens Valu Social in a tab (call it from a click), one that means something only beside Valu Social's own screens is skipped, and the rest answer `not_available`. Inside Valu Social every one runs.

> **Being retired.** `valu.sendIntent(new Intent(...))`, `valu.callService(new Intent(...))`, API pointers (`getApi(...).run(...)`), console commands (`runConsoleCommand`) and `bridge.pushRoute` / `replaceRoute` are Valu Social's older bridge. They still work, but Valu Social will close that bridge to apps: use the functions above, which keep working when it does.

### Example: Open a Text Channel for the Current User

```javascript
import { createValuApp } from '@arkeytyp/valu-api';

const valu = await createValuApp();
const { user } = await valu.data.Users.current();

// Inside Valu Social the chat opens beside the app; at the app's own address, in a Valu Social tab.
// Call it from a click: a browser opens a tab only from one.
openChatButton.onclick = () => valu.Chats.openChannel({ userId: user.id });
```

### Example: An Identity Token for Your Backend

```javascript
const { token } = await valu.data.Application.getIdentityToken();

await fetch('https://your-backend.example.com/api/data', {
  headers: { Authorization: `Bearer ${token}` },
});
```

The token is a JWT valid for five minutes, in both modes. How your backend checks it: [Identity Token Validation](https://docs.texpo.io/identity-token-validation).

## Permissions

Every function and intent has a scope (`rooms:read`, `commerce:write` …). Inside Valu Social nobody is asked anything: there are no tiers and no consent. At the app's own address the host checks the scope's tier on every call:

- **Basic** scopes (`users:read`, `networks:read`, `resources:read`, `applicationstorage:*`, `application:identity` …) work for any signed-in user.
- **Consent** scopes (`rooms:read`, `textchat:write`, `cms:write`, `commerce:read` …) need the user's yes once per app. A call made from a click opens the consent window and is repeated once when the user allows it; otherwise it answers `403 consent_required` and the app asks from its own click with `valu.auth.requestConsent([scope])`.
- **Forbidden** scopes (`cbac:write`, `veruswallet:*`, `developer:*`) are never allowed to an app.

Declare the scopes your app uses, each with one sentence a reviewer can check, in `valu-permissions.json`: a Workspaces app keeps it at the repository root; any other app serves it at `/.well-known/valu-permissions.json`. The file binds in both modes: a call to an undeclared scope is refused `permission_not_declared`, inside Valu Social too. The fix is a line in the file, never a retry.

```json
{
  "permissions": [
    { "scope": "rooms:read", "why": "Lists your rooms on the home screen." },
    { "scope": "commerce:read", "why": "Shows the products in your shop." }
  ]
}
```

The full tier table and how the file is enforced: [docs/connecting.md](docs/connecting.md#declaring-permissions).

## Developing Locally

- **Inside a local Valu Social**: name it, or the package will not trust it with your calls: `createValuApp({ hostOrigins: ['http://localhost:3005'] })`. Do not ship that list.
- **At your own address**: the production host serves only published `*.valuguru.app` origins, so a `localhost` page needs a local dev host. See [examples/dedicated/README.md](examples/dedicated/README.md).
- An app that sends its own `Content-Security-Policy` must allow the host in `frame-src`: `frame-src https://valuguru.texpo.io`.

## Commerce

Your app can sell through Valu Social's shared cart, show the user what they bought, and run the signed-in seller's store — its products, promotions and sales numbers.
All of it is the **`Commerce` service**, which the Valu Social application serves.
Call it as typed functions on the app object: `valu.data.Commerce.listProducts(...)`, `valu.Commerce.addToCart(...)`, `valu.Commerce.openCart()`. They work in both modes; the windows (`openCart`, `checkout` …) open Valu Social in a tab when the app runs at its own address.
A refusal comes back in the envelope every function answers: `{error: {code, message, description}}`, where `message` is the refusal's own name (`out_of_stock`, `cancelled`); `valu.data.Commerce.*` throws it instead. (The older form, `valu.callService(new Intent('Commerce', action, params))`, still works and answers `{success: false, code, error}`; it is being retired with the rest of the older bridge.)

### Example: Sell a Product

```javascript
const { products } = await valu.data.Commerce.listProducts({ query: 'starter', sort: 'popular' });

const added = await valu.Commerce.addToCart({ productId: products[0].id, qty: 1 });
if (added.error) {
  console.warn(added.error.message, added.error.description); // e.g. not_available_in_network, out_of_stock
}

// Unlock what the user owns: entitlements are the receipt your app can trust.
const { entitlements } = await valu.data.Commerce.checkEntitlements({ productIds: [products[0].id] });
if (entitlements[products[0].id]) unlockPurchase();
```

- **A refusal is an answer, not an exception:** `{error: {message}}` names it. Branch on `message`.
- **Some calls ask the user first.** Anything that costs them money, gives goods away, cannot be undone or speaks for them in public — publishing a product, starting a sale, creating a discount code, rating a product — opens a platform dialog over your app, and the call resolves when they answer. If they close it you get `code: 'cancelled'` and nothing was written: do not ask again on your own. While another dialog from your app is open the call is refused `busy`, and where the platform cannot draw one, `unsupported`. Your app cannot draw, reach or click that dialog.
- **Cart writes touch your app's own rows only.** `update-cart-item` and `remove-from-cart` refuse another app's row with `not_yours`, and `clear-cart` removes only yours (saved-for-later included). Reading the cart (`get-cart`) shows everything in it, from every app.
- **The seller is a person, not a store.** Buyers see the store's owner: show `get-my-store`'s `sellerName`, and draw the avatar from `sellerUserId`.
- **Every action is a function** on `valu.Commerce`, with its params and its scope: [docs/service-api.md](docs/service-api.md#commerce).

### Paying: Always in My Cart

**Your app never takes a payment.** Every payment goes through My Cart, always — a free order too — so no intent creates an order, pays one or shows a payment code.
To let the buyer pay for what your app put in the cart, hand them to My Cart with `Commerce.checkout`:

```javascript
const { data: result, error } = await valu.Commerce.checkout({ promoCode: 'SPRING' });

if (error) {
  // A refusal, and nothing opened. 'empty': none of your items is selected in the cart.
  showRefusal(error.message);
} else if (result.outcome === 'paid') {
  unlockPurchase();                    // a free order counts as paid
} else if (result.outcome === 'pending') {
  waitForPayment(result.orderId);      // follow it with getOrder or the order-updated event
}
// 'cancelled' — the order will not be paid (cancelled, expired or failed: `status` says
//               which), and its items are back in the cart
// 'dismissed' — the buyer closed My Cart without making an order
// 'opened'    — My Cart docked instead of opening over your app; there is nothing to wait for
```

`checkout` opens My Cart's own cart over your app, showing your items with the promo code typed in and applied.
The buyer presses Pay and scans there — only My Cart creates the order — and the call resolves with `{success: true, outcome, orderId?, status?}` when they close it.
With `popup: false`, or where there is no popup to draw, My Cart docks instead and the call resolves at once with `outcome: 'opened'`.
A second `checkout` while one is open replaces it.
At the app's own address, call the windows as typed functions from a click (`valu.Commerce.checkout({ promoCode })`, `valu.Commerce.openCart()`): they open Valu Social in a tab, and the outcome reaches the app through the Commerce events.
To simply show the cart, use `Commerce.open-cart`; to send the buyer to one order — to resume a pending payment, or read a receipt — use `Commerce.open-order`.

### Commerce Events

Your app can react when the cart, an order, the network's shelf or the seller's own store changes.
Events are **opt-in**: listen with `valu.onCommerceEvent(handler)`, then subscribe to the events you want with `Commerce.subscribe-events`.

```javascript
valu.onCommerceEvent(({ event, ...data }) => {
  if (event === 'order-updated') refreshOrder(data.orderId);
  if (event === 'catalogue-updated') refreshShelf();
});

// After every start and every sign-in (a sign-out or reload ends the subscription):
await valu.Commerce.subscribeEvents({ events: ['catalogue-updated', 'order-updated'] });
```

| Event | Data | When |
|-------|------|------|
| `cart-updated` | `{count}` | The cart changed. `count` is the badge number — never which items. |
| `order-updated` | `{orderId, status}` | An order holding at least one of your app's items changed: `pending_payment`, `paid`, `failed`, `expired`, `cancelled` or `deleted`. Orders without your items are never sent to you. |
| `delivery-updated` | `{orderId, status}` | That order's files: `delivered` (they are in the buyer's Media), `unavailable` or `failed`. |
| `catalogue-updated` | `{productId, change}` | A product was `added` to, `updated` on or `removed` from this network's shelf. `productId: null` means re-read the whole shelf. |
| `seller-product-updated` | `{productId, change}` | One of the signed-in seller's own products: `created`, `updated`, `content-updated`, `published`, `unlisted`, `archived`, `deleted`, `broken`, `sale-started`, `sale-ended`, `blocked` or `unblocked`. |
| `seller-store-updated` | `{change, networkId?}` | The seller's store: `created`, `updated`, `donation-updated` or `network-access-updated` (with the network's id). |
| `seller-promotions-updated` | `{change}` | A promotion changed: `sale`, `tier` or `code`. |

- **An event says what changed, never the new state.** Re-read with the matching intent (`get-cart`, `list-products`, …). A missed event costs a stale screen, never a wrong charge.
- **`subscribe-events` replaces your set** — send the full list each time; `events: []` stops them all, as does `unsubscribe-events` with no `events`. It answers `{success: true, events}`, your whole set now. An unknown name is refused `validation_failed` and nothing changes; a caller that is neither an embedded app nor a dedicated one (`createValuApp`), with no frame to post to, is refused `unsupported`.
- **Subscribe every time your app starts.** A subscription lasts until `unsubscribe-events`, or until your frame closes or reloads — and moving the app to another dock reloads it.
- **A dedicated app subscribes the same way**, and nothing arrives without it: `valu.onCommerceEvent(handler)` only listens, `valu.Commerce.subscribeEvents({ events })` subscribes (`commerce:read`, which needs the user's consent). The host holds the subscription for the signed-in session, so a sign-out, a reload or a revoked consent ends it: subscribe after every start and every sign-in ([docs/connecting.md](docs/connecting.md#what-the-host-serves)).
- If your app extends `ValuApplication`, `onCommerceEvent(event)` receives the same events, after the listeners.

### Without the Package

Nothing above needs this package. The bridge is plain `window.postMessage`, and an app with no dependencies at all speaks it directly — `callService` posts exactly this `api:service-intent` message, and `ON_COMMERCE` is the `api:trigger` message with `action: 'commerce'`:

```javascript
let host;                 // the Valu Social application — known from api:ready
const pending = new Map();
let nextRequestId = 0;

window.addEventListener('message', (event) => {
  const { target, name, message, requestId } = event.data ?? {};
  if (target !== 'valuApi') return;

  if (name === 'api:ready') {
    host = { window: event.source, origin: event.origin };
    callService('Commerce', 'subscribe-events', { events: ['cart-updated'] });
  }
  if (name === 'api:run-console-completed' && pending.has(requestId)) {
    pending.get(requestId)(message);   // a service intent's answer
    pending.delete(requestId);
  }
  if (name === 'api:trigger' && message.action === 'commerce') {
    console.log(message.data);         // e.g. {event: 'cart-updated', count: 3}
  }
});

function callService(applicationId, action, params = {}) {
  return new Promise((resolve) => {
    const requestId = ++nextRequestId;
    pending.set(requestId, resolve);
    host.window.postMessage(
      { name: 'api:service-intent', message: { applicationId, action, params, requestId } },
      host.origin,
    );
  });
}
```

## Handling Application Lifecycle

The `valu-api` package lets your iframe app handle **application lifecycle events**.
By extending `ValuApplication` and registering it on the bridge (`valu.bridge.setApplication(...)`), you can respond when your app is created, receives a new intent, or is destroyed.

This helps you **separate application logic from API wiring** and makes handling incoming intents straightforward.

### 1. Create Your Application Class

```javascript
import { ValuApplication } from '@arkeytyp/valu-api';

class MyApp extends ValuApplication {
  async onCreate(intent) {
    console.log('App created with:', intent);
    return { status: 'initialized' };
  }

  async onNewIntent(intent) {
    console.log('New intent received:', intent);
    return { handled: true, data: { message: 'Processed successfully' } };
  }

  onDestroy() {
    console.log('App is shutting down');
  }
}
```

### 2. Register Your Application

```javascript
import { createValuApp } from '@arkeytyp/valu-api';

const valu = await createValuApp();
valu.bridge.setApplication(new MyApp());
```

**Lifecycle Methods:**
- `onCreate(intent)` — Triggered when the application is first launched with an intent.
- `onNewIntent(intent)` — Triggered when a new intent is sent while the application is already running.
- `onDestroy()` — Triggered when the application is about to be destroyed.
- `onCommerceEvent(event)` — Triggered with a Commerce event your app subscribed to (see [Commerce Events](#commerce-events)).

#### Lifecycle Flow

```
[onCreate] → [onNewIntent] (0..N times) → [onDestroy]
```


## Using the System API

> **Being retired.** API pointers and console commands are Valu Social's older bridge, which it will close to apps. What apps use them for is a function now: `network.id` is `valu.Networks.getCurrentNetwork()`, `app.isApplicationLoaded` is `valu.Apps.isLoaded(appId)`, `app.open` is `valu.Apps.open(appId)`. Do not start new code on them.
>
> **Inside Valu Social only.** API pointers and console commands belong to the Valu Social application. At the app's own address the host answers them `not_available`, and the permission check refuses every console command. For data, use the service functions above; the examples below take `valuApi = valu.bridge`.

The **System API** allows your iframe app to interact directly with the Valu Social platform and its internal applications.
It provides a unified way to:

- Access core platform features (apps, chat, etc.)
- Call commands on these features
- Subscribe to real-time events from the platform
- Run and test commands from the console for debugging

### 1. Get an API Pointer

Once the API is ready, you can get an `APIPointer` by specifying the API name and (optionally) the version.

> **Important:** `getApi()` is asynchronous — always use `await`.

```javascript
const appApi = await valuApi.getApi('app', 1); // Specific version
const appApiLatest = await valuApi.getApi('app'); // Latest version
```

### 2. Invoke API Commands

After obtaining the API pointer, you can invoke commands.
For example, to get the current network id:

```javascript
const networkApi = await valuApi.getApi('network');
const networkId = await networkApi.run('id');
console.log(networkId);
```

### 3. Subscribe to Events

You can subscribe to events emitted by the API.
For example, listen for the `app-open` event:

```javascript
const appApi = await valuApi.getApi('app');
appApi.addEventListener('app-open', (event) => {
  console.log(event);
});
```

### 4. Run Console Commands (For Testing)

Use `runConsoleCommand` to execute commands directly in the console environment.

```javascript
const reply = await valuApi.runConsoleCommand('network id');
console.log(reply);
```

#### Run Intents via Console Commands

You can also use the console to run intents — the following two examples achieve the same result:

**Via API:**

```javascript
import { Intent } from "@arkeytyp/valu-api";

const usersApi = await valuApi.getApi('users');
const currentUser = await usersApi.run('current');
if (!currentUser) {
  console.error('Something went wrong');
  return;
}

const intent = new Intent('textchat', 'open-channel', { userId: currentUser.id });
await valuApi.sendIntent(intent);
```

**Via Console:**

```javascript
const currentUser = await valuApi.runConsoleCommand('users current');
const reply = await valuApi.runConsoleCommand(
  `app run -applicationId textchat -action open-channel -userId ${currentUser.id}`
);
console.log(reply);
```

## Common Mistakes

| Mistake | Why it's wrong | Correct approach |
|---------|---------------|-----------------|
| `npm install @arkeytyp/valu-api@1` (or an old lockfile) | Version 1 has no `createValuApp` | `npm install @arkeytyp/valu-api@^2` |
| `new ValuApi()` + `getApi('users')` in a new app | Works only inside Valu Social; a top-level page gets nothing | `const valu = await createValuApp()` |
| `valu.sendIntent(new Intent('textchat', 'open-channel', …))` | The older bridge, being retired; the check cannot read a name hidden in a helper | `valu.Chats.openChannel({ userId })` |
| Polling `getApi('app').run('isApplicationLoaded', id)` | An API pointer, being retired | `valu.Apps.isLoaded(appId)` |
| Calling `valu.auth.signIn()` after an `await` | The browser blocks a popup that is not opened in the click's own turn | Call it first thing in the click handler |
| Treating `consent_required` as a failure | At the app's own address a consent scope needs the user's yes once | Call from a click (the dialog opens itself), or `valu.auth.requestConsent([scope])` from a click |
| A scope missing from `valu-permissions.json` | Undeclared scopes are refused `permission_not_declared` in both modes | Add the scope with a `why` |
| Building a function name at run time (`valu[service][fn]()`) | The publish check cannot read it, and the reviewer will ask | Write the call as a literal |
| `currentUser.name` from `getApi('users').run('current')` | That older object has `firstName`/`lastName`, no `name` | Use `firstName` and `lastName` |
| Building your own checkout or payment screen | Apps never take payments — My Cart does | `valu.Commerce.checkout()` (from a click) |
| Listening for Commerce events without subscribing | Commerce events are opt-in; nothing arrives otherwise | `valu.Commerce.subscribeEvents({ events: [...] })` |
| Reading the new state from a Commerce event | Events say what changed, not what it is now | Re-read with the matching call (`getCart`, `listProducts`, …) |

## Sample Project

We've created a sample application integrated with Valu API.
Check out the repository here and feel free to leave comments or feedback:

[https://github.com/Roomful/ValuSampleApp](https://github.com/Roomful/ValuSampleApp)

For `createValuApp` in both modes (sign-in, consent, Commerce), see [examples/dedicated](examples/dedicated/): one page, no bundler.

---

## The service SDK

Alongside the application bridge, the package carries **65 service functions** —
users, rooms, communities, chat, resources, events — as functions you call.
Every one of them runs over the **Roomful platform socket**, the one connection
this package holds, so the same 65 work from a Valu Social build, from a Node
script, from a server-side agent and from an iframe application that has a
socket.

```javascript
import { createValuServices, BrowserSocketAdapter } from '@arkeytyp/valu-api';

const socket = new BrowserSocketAdapter({ socket: webSocketService, userId, networkId });
const valu = createValuServices({ socket });

const ack   = await valu.Users.get({ userId });        // {data} | {error}, never rejects
const user  = await valu.data.Users.get({ userId });   // the payload, throws on error
const same  = await valu.call('Users.get', { userId }); // by name, for a tool call
const rooms = await valu.data.Rooms.searchRooms({ query: 'design' });
```

Headless it is the same call with the other adapter:

```javascript
import { createValuServices, NodeSocketAdapter } from '@arkeytyp/valu-api';

const valu = createValuServices({ socket: new NodeSocketAdapter({ connection }) });
```

A name resolves by any form the platform already writes — `Users.get`,
`Users.get_user`, `Users.getUser` or `service__Users__get`.

### Getting the socket

Two ways, and the same 65 functions after either
([docs/connecting.md](docs/connecting.md)):

```javascript
import { connectValuServices } from '@arkeytyp/valu-api';

// 1. You already have an authorized connection — pass the instance. The
//    package works out which adapter it needs; it opens nothing and closes
//    nothing, because the connection is yours.
const valu = await connectValuServices({ socket: webSocketService, userId });

// 2. You have a session and no connection. The package opens the socket,
//    authorizes it, waits for the platform's `user_info`, and owns it.
import io from 'socket.io-client';
const valu = await connectValuServices({ sessionId, io });
await valu.close();
```

Pass `io`: socket.io-client is deliberately **not** a dependency of this package
— every runtime with a Roomful connection already has one, and a second copy in
your bundle is a second connection pool.

The `sessionId` door is for runtimes that already hold the user's session: the
Valu Social application, and a process the user ran. An app calls
`createValuApp()`, and the same code runs in both places an app lives. A top-level
app runs the functions through the **host**: the host keeps the session and checks
the app's grants before every call
([docs/connecting.md](docs/connecting.md#dedicated-mode--createvaluapp)). A framed
one runs them through Valu Social, which answers them with valu-api's own
functions over its connection, with no permissions to ask for
([docs/connecting.md](docs/connecting.md#inside-valu-social)); a socket of its own
waits on a scoped, revocable token ([docs/authorization.md](docs/authorization.md)). Service
functions always run over a connection (yours, the host's or Valu Social's); the
intents bridge (`ValuApi.callService`) runs intents by name, not functions.

**What the Valu Social application serves itself is not a socket function** —
Commerce, opening a dock or another app, expanding a pane, showing a picker. An
app still calls the common ones as typed functions on the `createValuApp()`
object (`valu.Commerce.getCart()`, `valu.Application.expandApplication()`,
`valu.Chats.openChannel({ userId })`, `valu.Apps.open(appId)`; see
[Calling Valu](#calling-valu)), which send the intent underneath.

- [docs/socket-functions.md](docs/socket-functions.md) — every function, the
  feature it provides and what it needs. **Start here.** (generated)
- [docs/connecting.md](docs/connecting.md) — **connecting**: `createValuApp`, the
  one entry point for an app (a dedicated page on its own origin through the
  host, or a page inside Valu Social), and getting a socket: open one from a
  session id, or share the one your runtime already has
- [docs/socket-adapters.md](docs/socket-adapters.md) — what a socket is here,
  what the three adapters do, and how to supply one
- [docs/service-api.md](docs/service-api.md) — the same functions, as the call
  you would write (generated)
- [docs/sdk.md](docs/sdk.md) — what the package is, the architecture, and how to
  add a function
- [docs/api-pointers.md](docs/api-pointers.md) — the bridge: API pointers, and
  any application intent by name (generated)
- [docs/callbacks-policy.md](docs/callbacks-policy.md) — the answer shape,
  timeouts, retry, ordering and reconnect. **Frozen.**
- [docs/authorization.md](docs/authorization.md) — app tokens, scopes, and why
  an application never receives the user's session
- [docs/parity.md](docs/parity.md) — who implements what, and the known
  behaviour deltas (generated)
- [docs/transition.md](docs/transition.md) — how Valu Social and the Valu Guru
  server adopt this, measured against both checkouts
- [valu-app-api.md](valu-app-api.md) — giving your app a REST API that other
  Valuverse applications and AI agents can call while nobody has it open
- `createAppApiClient` (`src/AppApi.js`) — calling another application's REST
  API from a page on a Valu host, through the Valu Guru gateway's trusted-host
  door: two headers and the identity token, no client secret
