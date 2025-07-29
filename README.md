# Valu API

The `valu-api` package enables developers to build custom iframe applications for Valu Social.  
It provides tools to invoke functions on registered Valu applications, subscribe to their events, and communicate via intents.  
With features like API versioning, event handling, and console command execution, you can seamlessly integrate and extend functionality within the Valu Social ecosystem.

---

## Installation

```bash
npm install @arkeytyp/valu-api
```

---

## Usage

### Initialize ValuApi

On application startup, create an instance of `ValuApi` and subscribe to the `API_READY` event.  
This event is triggered only when your application is launched as an iframe within the Valu Verse application.

```javascript
import { ValuApi } from "@arkeytyp/valu-api";

const valuApi = new ValuApi();
valuApi.addEventListener(ValuApi.API_READY, async (e) => {
  console.log("API IS READY!");
});
```

---

## Running Application Intents

Intents are a powerful way to communicate with other applications inside Valu Social.  
They allow your application to request actions from other registered apps in a standardized way — for example, opening a chat, joining a meeting, or performing any supported operation.

Each Intent contains:

- **applicationId:** The target application’s ID.
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

---

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

#### Lifecycle Flow

```
[onCreate] → [onNewIntent] (0..N times) → [onDestroy]
```

---

## Using the System API

The **System API** allows your iframe app to interact directly with the Valu Social platform and its internal applications.  
It provides a unified way to:

- Access core platform features (apps, chat, etc.)
- Call commands on these features
- Subscribe to real-time events from the platform
- Run and test commands from the console for debugging

### 1. Get an API Pointer

Once the API is ready, you can get an `APIPointer` by specifying the API name and (optionally) the version.

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

---

## Sample Project

We've created a sample application integrated with Valu API.  
Check out the repository here and feel free to leave comments or feedback:

[https://github.com/Roomful/ValuSampleApp](https://github.com/Roomful/ValuSampleApp)
know if you want a **quick start** section, more real-world samples, or even a troubleshooting/FAQ block!