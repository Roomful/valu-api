The `valu-api` package enables developers to create custom iframe applications for Valu Social. It provides tools to invoke functions of registered Valu applications and subscribe to their events. With features like API versioning, event handling, and console command testing, developers can seamlessly integrate and extend functionality within the Valu Social ecosystem.

# Installation

```bash
npm install @arkeytyp/valu-api
```

# Usage

## Initialize ValuApi

On your application startup, create an instance of `ValuApi` and subscribe to the `API_READY` event. This event will be triggered only when your application is launched as an iframe within the Valu Verse application.

```javascript
import { ValuApi } from 'valu-api';

const valuApi = new ValuApi();
valuApi.current.addEventListener(ValuApi.API_READY, async (e) => {
  console.log("API IS READY!!!");
});
```

# Running Application Intents

Intents are a powerful way to communicate with other applications inside the Valu Social ecosystem. They allow your application to request actions from other registered Valu apps in a standardized way — for example, opening a chat, joining a meeting, or performing any predefined operation supported by another app.

Each Intent contains:

* **applicationId:** The target application’s ID.
* **action:** The action you want to perform (e.g., `open`, `connect-to-meeting`).
* **params:** Optional parameters for the action (e.g., room IDs, configuration data).

Here’s an example of creating and running an intent to connect to a video meeting:

```javascript
import { Intent } from 'valu-api';

const intent = new Intent(
  'videochat',              // Target application ID
  'connect-to-meeting',     // Action to perform
  {
    roomId: '<room-id>',    // Additional parameters
    withLocalTracks: true
  }
);

await valuApi.sendIntent(intent);
```

# Handling Application Lifecycle

The `valu-api` package provides a way to handle **application lifecycle events** inside your iframe application. By implementing a `ValuApplication` class and registering it with `ValuApi`, you can easily respond to events such as when your app is created, receives a new intent, or is destroyed.

This allows you to **separate application logic from API wiring** and makes it simple to handle incoming intents and return values back to the caller.

## 1. Create Your Application Class

Extend the `ValuApplication` class and override its lifecycle methods:

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

  async onDestroy() {
    console.log('App is shutting down');
  }
}
```

## 2. Register Your Application with ValuApi

Set your application instance within `ValuApi`:

```javascript
import { ValuApi } from '@arkeytyp/valu-api';

const valuApi = new ValuApi();
valuApi.setApplication(new MyApp());
```

Once registered, the `ValuApi` will call the appropriate lifecycle methods when events are received from the host (e.g., app launch, new intent, app close).

## Lifecycle Methods

* **`onCreate(intent)`** – Triggered when the application is first launched with an Intent. You can return an optional value to send back to the caller.
* **`onNewIntent(intent)`** – Triggered when a new Intent is sent to the application while it is already running. The return value will be sent back to whoever triggered the Intent.
* **`onDestroy()`** – Triggered when the application is about to be destroyed. Use this to clean up resources.

### Lifecycle Flow

```
[onCreate] → [onNewIntent] (many times) → [onDestroy]
```

# Using System API

The **System API** allows your iframe application to interact directly with the Valu Social platform and its internal applications.

This API provides a unified way to:

* Access core platform features (apps, chat, etc.)
* Call specific commands on these features
* Subscribe to real-time events emitted by the platform
* Run and test commands from the console for debugging

This makes it easy to extend the functionality of Valu Social and integrate your iframe application with other parts of the ecosystem.

## 1. Get an API Pointer

Once the API is ready, you can create an `APIPointer` instance by specifying the name and version of the API you want to use. The version parameter is optional, and if omitted, the latest version will be used.

```javascript
const appApi = valuApi.getApi('app', 1); // Specific version
const appApiLatest = valuApi.current.getApi('app'); // Latest version
```

## 2. Invoke API Commands

After obtaining the API pointer, you can invoke commands on the API. Here's an example of opening the `text_chat` on the app API:

```javascript
await appApi.run('open', 'text_chat');
```

For interacting with other APIs, like the chat API:

```javascript
const chatApi = valuApi.current.getApi('chat');
await chatApi.run('open-channel', { roomId: 'room123', propId: 'prop456' });
```

## 3. Subscribe to Events

You can subscribe to events emitted by the API. For example, if you want to listen for the `app-open` event:

```javascript
appApi.addEventListener('app-open', (event) => {
  console.log(event);
});
```

## 4. Run Console Commands (For Testing)

You can use the `runConsoleCommand` method to execute commands directly in the console environment. This method processes the output and returns a resolved promise on success or an error message if the command fails.

```javascript
let command = 'app open text_chat';
let reply = await valuApi.current.runConsoleCommand(command);
console.log(reply);

command = 'chat open-channel roomId xz21wd31tx83kk propId 812t26xbq5424b';
reply = await valuApi.current.runConsoleCommand(command);
console.log(reply);
```

## Example Workflow

```javascript
import { ValuApi } from 'valu-api';

const valuApi = new ValuApi();

valuApi.current.addEventListener(ValuApi.API_READY, async () => {
  console.log("API IS READY!!!");

  const appApi = valuApi.current.getApi('app');

  await appApi.run('open', 'text_chat');

  appApi.addEventListener('app-open', (event) => {
    console.log('App opened:', event);
  });

  let command = 'app open text_chat';
  let reply = await valuApi.current.runConsoleCommand(command);
  console.log(reply);
});
```