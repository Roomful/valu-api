The `valu-api` package enables developers to build custom iframe applications for Valu Social.
It provides tools to invoke functions on registered Valu applications, subscribe to their events, and communicate via intents.
With features like API versioning, event handling, and console command execution, you can seamlessly integrate and extend functionality within the Valu Social ecosystem.

## Installation

```bash
npm install @arkeytyp/valu-api
```

## Quick Start: Full Example

Below is a complete example that initializes the API, gets the current user, and retrieves their avatar. This is the most common starting pattern for any Valu iframe app.

```javascript
import { ValuApi } from "@arkeytyp/valu-api";

// Use a singleton — store on globalThis to avoid duplicate instances
let valuApi = globalThis.valuApi;
if (!valuApi) {
  valuApi = globalThis.valuApi = new ValuApi();
}

// If already connected, proceed immediately; otherwise wait for the event
if (valuApi.connected) {
  onReady();
} else {
  valuApi.addEventListener(ValuApi.API_READY, onReady);
}

async function onReady() {
  // getApi() returns a Promise — always use await
  const usersApi = await valuApi.getApi('users');
  const currentUser = await usersApi.run('current');

  if (!currentUser) {
    console.error('Could not get current user');
    return;
  }

  console.log('User:', currentUser.id, currentUser.firstName, currentUser.lastName);

  // Avatar requires a separate call
  const avatarUrl = await usersApi.run('get-icon', { userId: currentUser.id });
  console.log('Avatar URL:', avatarUrl);
}
```

## Usage

### Initialize ValuApi

On application startup, create an instance of `ValuApi` and subscribe to the `API_READY` event.
This event is triggered only when your application is launched as an iframe within the Valu Verse application.

> **Important:** `ValuApi.API_READY` is a **string constant** (event name), not a Promise.
> Always use it with `addEventListener()`. Do **not** call `.then()` on it.

> **Important:** `getApi()` returns a **Promise**. Always `await` the result before calling `.run()`.

```javascript
import { ValuApi } from "@arkeytyp/valu-api";

const valuApi = new ValuApi();
valuApi.addEventListener(ValuApi.API_READY, async (e) => {
  console.log("API IS READY!");
});
```

**Recommended singleton pattern** — prevents duplicate connections if your init code runs more than once (e.g., React strict mode):

```javascript
let valuApi = globalThis.valuApi;
if (!valuApi) {
  valuApi = globalThis.valuApi = new ValuApi();
}

if (valuApi.connected) {
  // Already connected — safe to make API calls immediately
} else {
  valuApi.addEventListener(ValuApi.API_READY, () => {
    // Now connected — safe to make API calls
  });
}
```

## Users API Reference

The `users` API provides commands for retrieving user information.

### Get Current User

```javascript
const usersApi = await valuApi.getApi('users');
const currentUser = await usersApi.run('current');
```

**Returns an object with the following fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique user identifier |
| `firstName` | `string` | User's first name |
| `lastName` | `string` | User's last name |
| `companyTitle` | `string` | User's role or title |

> **Note:** There is no `name` or `avatar` field on the user object.
> Use `firstName` and `lastName` for the display name. Use `get-icon` (below) for the avatar.

### Get User Avatar

Avatar is retrieved with a **separate API call**, not from the user object:

```javascript
const usersApi = await valuApi.getApi('users');
const avatarUrl = await usersApi.run('get-icon', { userId: currentUser.id });
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `userId` | `string` | The ID of the user whose avatar to retrieve |

**Returns:** A URL string pointing to the user's avatar image.

## Running Application Intents

Intents are a powerful way to communicate with other applications inside Valu Social.
They allow your application to request actions from other registered apps in a standardized way — for example, opening a chat, joining a meeting, or performing any supported operation.

Each Intent contains:

- **applicationId:** The target application's ID.
- **action:** The action to perform (e.g., `open`, `connect-to-meeting`).
- **params:** Optional parameters for the action (e.g., room IDs, configuration data).

### Example: Open a Video Chat

```javascript
import { Intent } from "@arkeytyp/valu-api";

const intent = new Intent('videochat');
await valuApi.sendIntent(intent);
```

### Example: Open a Text Channel for the Current User

First, get the current user ID using the `users` API:

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

## Invoking Services

Invoking a Service works almost the same way as running an Application Intent.
You still use the same `Intent` object with `applicationId`, `action`, and optional `params` — the key difference is **what the `applicationId` points to and how the call affects the UI**.

When calling a **Service Intent**:

- **`applicationId`** refers to the **service name** (e.g., `ApplicationStorage`), not a visible UI application.
- Services run entirely **in the background**.
- Invoking a service **does not change** the currently opened applications.

### Example: Querying the `ApplicationStorage` Service

```javascript
import { Intent } from "@arkeytyp/valu-api";

const intent = new Intent('ApplicationStorage', 'resource-search', {
  size: 10,
});

const result = await valuApi.callService(intent);
```

## Commerce

Your app can sell through Valu Social's shared cart, show the user what they bought, and run the signed-in seller's store — its products, promotions and sales numbers.
All of it is the **`Commerce` service**, and you reach it with **service intents over the bridge**: `callService(new Intent('Commerce', action, params))`.
Commerce is not one of this package's service functions (see [The service SDK](#the-service-sdk) below) — the Valu Social application serves it, so you ask for it by name.

### Example: Sell a Product

```javascript
import { Intent } from "@arkeytyp/valu-api";

const { products } = await valuApi.callService(
  new Intent('Commerce', 'list-products', { query: 'starter', sort: 'popular' })
);

const added = await valuApi.callService(
  new Intent('Commerce', 'add-to-cart', { productId: products[0].id, qty: 1 })
);
if (added.success === false) {
  console.warn(added.code, added.error); // e.g. not_available_in_network, out_of_stock
}

// Unlock what the user owns: entitlements are the receipt your app can trust.
const { entitlements } = await valuApi.callService(
  new Intent('Commerce', 'check-entitlements', { productIds: [products[0].id] })
);
if (entitlements[products[0].id]) unlockPurchase();
```

- **A refusal is an answer, not an exception:** `{success: false, code, error}`. Branch on `code`.
- **Some calls ask the user first.** Anything that costs them money, gives goods away, cannot be undone or speaks for them in public — publishing a product, starting a sale, creating a discount code, rating a product — opens a platform dialog over your app, and the call resolves when they answer. If they close it you get `code: 'cancelled'` and nothing was written: do not ask again on your own. While another dialog from your app is open the call is refused `busy`, and where the platform cannot draw one, `unsupported`. Your app cannot draw, reach or click that dialog.
- **Cart writes touch your app's own rows only.** `update-cart-item` and `remove-from-cart` refuse another app's row with `not_yours`, and `clear-cart` removes only yours (saved-for-later included). Reading the cart (`get-cart`) shows everything in it, from every app.
- **The seller is a person, not a store.** Buyers see the store's owner: show `get-my-store`'s `sellerName`, and draw the avatar from `sellerUserId`.
- **The list of actions moves without this package.** The Valu Social application's manifest is the authority: an action it adds works through `callService` as it is, with no new version of this package. [docs/api-pointers.md](docs/api-pointers.md) lists the Commerce intents with their params as of the last manifest sync.

### Paying: Always in My Cart

**Your app never takes a payment.** Every payment goes through My Cart, always — a free order too — so no intent creates an order, pays one or shows a payment code.
To let the buyer pay for what your app put in the cart, hand them to My Cart with `Commerce.checkout`:

```javascript
const result = await valuApi.callService(
  new Intent('Commerce', 'checkout', { promoCode: 'SPRING' })
);

if (result.success === false) {
  // A refusal, and nothing opened. 'empty': none of your items is selected in the cart.
  showRefusal(result.code);
} else if (result.outcome === 'paid') {
  unlockPurchase();                    // a free order counts as paid
} else if (result.outcome === 'pending') {
  waitForPayment(result.orderId);      // follow it with get-order or the order-updated event
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
To simply show the cart, use `Commerce.open-cart`; to send the buyer to one order — to resume a pending payment, or read a receipt — use `Commerce.open-order`.

### Commerce Events

Your app can react when the cart, an order, the network's shelf or the seller's own store changes.
Events are **opt-in**: listen for `ValuApi.ON_COMMERCE`, then subscribe to the events you want with `Commerce.subscribe-events`.

```javascript
import { ValuApi, Intent } from "@arkeytyp/valu-api";

valuApi.addEventListener(ValuApi.ON_COMMERCE, ({ event, ...data }) => {
  if (event === 'order-updated') refreshOrder(data.orderId);
  if (event === 'catalogue-updated') refreshShelf();
});

// Every time the app starts, once connected (ValuApi.API_READY):
await valuApi.callService(new Intent('Commerce', 'subscribe-events', {
  events: ['catalogue-updated', 'order-updated'],
}));
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
- **A dedicated app subscribes the same way**, and nothing arrives without it: `valu.onCommerceEvent(handler)` only listens, `valu.callService(new Intent('Commerce', 'subscribe-events', { events }))` subscribes (`commerce:read`, which needs the user's consent). The host holds the subscription for the signed-in session, so a sign-out, a reload or a revoked consent ends it: subscribe after every start and every sign-in ([docs/connecting.md](docs/connecting.md#what-the-host-serves)).
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
By extending `ValuApplication` and registering it with `ValuApi`, you can respond when your app is created, receives a new intent, or is destroyed.

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

### 2. Register Your Application with ValuApi

```javascript
import { ValuApi } from '@arkeytyp/valu-api';

const valuApi = new ValuApi();
valuApi.setApplication(new MyApp());
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
| `ValuApi.API_READY.then(...)` | `API_READY` is a string, not a Promise | `valuApi.addEventListener(ValuApi.API_READY, callback)` |
| `valuApi.getApi('users').run(...)` | `getApi()` returns a Promise | `const api = await valuApi.getApi('users')` then `api.run(...)` |
| `currentUser.name` | Field doesn't exist | Use `currentUser.firstName` and `currentUser.lastName` |
| `currentUser.avatar` | Field doesn't exist | Use `await usersApi.run('get-icon', { userId: currentUser.id })` |
| Creating multiple `new ValuApi()` | Causes duplicate connections | Store singleton on `globalThis` |
| Building your own checkout or payment screen | Apps never take payments — My Cart does | `await valuApi.callService(new Intent('Commerce', 'checkout'))` |
| Listening for `ValuApi.ON_COMMERCE` without subscribing | Commerce events are opt-in; nothing arrives otherwise | `callService(new Intent('Commerce', 'subscribe-events', { events: [...] }))` |
| Reading the new state from a Commerce event | Events say what changed, not what it is now | Re-read with the matching intent (`get-cart`, `list-products`, …) |

## Sample Project

We've created a sample application integrated with Valu API.
Check out the repository here and feel free to leave comments or feedback:

[https://github.com/Roomful/ValuSampleApp](https://github.com/Roomful/ValuSampleApp)

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
Valu Social application, and a process the user ran. A framed third-party
application asks the Valu Social application for its intents through the bridge
(its service functions answer `501` there), and gets a socket of its own when it
can be handed a scoped, revocable token
([docs/authorization.md](docs/authorization.md)). A top-level app runs the
functions through the **host** instead, with `createValuApp()`: the host keeps the
session and checks the app's grants before every call
([docs/connecting.md](docs/connecting.md#dedicated-mode--createvaluapp)). Service
functions run over a connection or over the host bridge; the bare postMessage
bridge serves none.

**Anything the Valu Social application serves itself is not a function here** —
opening a dock, expanding a pane, showing a picker, and anything a *different*
server answers on a socket this package does not hold (the Commerce catalogue
and the knowledge-base search, which are the Valu Guru server's). The
application registers its intents at runtime, so this package declares none of
them and you ask for one by name instead, over the bridge above
([Commerce](#commerce) is the worked example):

```javascript
await api.callService(new Intent('Commerce', 'open-cart'));
```

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
