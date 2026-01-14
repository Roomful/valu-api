The `valu-api` package enables developers to build custom iframe applications for Valu Social.  
It provides tools to invoke functions on registered Valu applications, subscribe to their events, and communicate via intents.  
With features like API versioning, event handling, and console command execution, you can seamlessly integrate and extend functionality within the Valu Social ecosystem.

## Installation

```bash
npm install @arkeytyp/valu-api
```

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
## Invoking Services

Invoking a Service works almost the same way as running an Application Intent.  
You still use the same `Intent` object with `applicationId`, `action`, and optional `params` — the key difference is **what the `applicationId` points to and how the call affects the UI**.

When calling a **Service Intent**:

- **`applicationId`** refers to the **service name** (e.g., `ApplicationStorage`), not a visible UI application.
- Services run entirely **in the background**.
- Invoking a service **does not change** the currently opened applications.
- Service Intents are ideal for performing background logic such as:
  - Running searches  
  - Fetching or processing data  
  - Triggering non-visual workflows  
  - Performing system-level operations

This makes Services a parallel mechanism to Application Intents, with the difference that they target **non-UI services** instead of interactive apps.

---

### Example: Querying the `ApplicationStorage` Service

Below is an example of using an `Intent` to query the `ApplicationStorage` service to search for resources:

```ts
const intent = new Intent('ApplicationStorage', 'resource-search', {
  size: 10,
});

const result = await valuApi.callService(intent);
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

# Routing in Valu iFrame Applications

Valu Social allows third‑party developers to register **mini‑applications** that are rendered inside the platform using **iframes**.

Each mini‑app:

* Has a unique **application ID / slug**
* Is mounted under a dedicated URL namespace in Valu Social
* Can manage its own internal routing (for example using React Router)

The host application (Valu Social) and the iframe application must stay **route‑synchronized** to ensure:

* Correct deep‑linking
* Proper browser navigation (back / forward)
* Shareable URLs

---

## Application Configuration

A mini‑application is registered with a configuration similar to the following:

```json
{
  "id": "demo-app",
  "slug": "demo-app",
  "iframe": {
    "url": "https://sample.texpo.io"
  }
}
```

Key fields:

* **id / slug** – determines the public URL under valu-social.com
* **iframe.url** – the base URL loaded inside the iframe

---

## Host → Iframe Route Mapping

Valu Social automatically maps routes from the host URL to the iframe URL.

### Base Route

When a user opens:

```
https://valu-social.com/demo-app
```

Valu Social loads the iframe at:

```
https://sample.texpo.io/
```

---

### Nested Routes

When a user opens:

```
https://valu-social.com/demo-app/page/1
```

Valu Social loads the iframe at:

```
https://sample.texpo.io/page/1
```

📌 **Rule:**

```
/valu-social/<app-slug>/<path>
→
<iframe-base-url>/<path>
```

No additional configuration is required for this behavior.

---

## Iframe → Host Route Synchronization

If your mini‑application uses **client‑side routing** (for example React Router), route changes **inside the iframe** are not automatically reflected in the Valu Social URL.

To keep the host URL in sync, your app must explicitly report route changes using:

```ts
valuApi.pushRoute(pathname);
```

This ensures:

* The browser URL updates correctly
* Deep links work as expected
* Page refresh restores the correct internal state

---

## React Router Integration (Recommended)

### Valu Router Bridge Component

Below is a small helper component that listens for route changes and reports them to Valu Social.

```ts
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useValuAPI } from "@/Hooks/useValuApi";

export function ValuRouterBridge() {
  const valuApi = useValuAPI();
  const { pathname } = useLocation();

  // Iframe → Host
  useEffect(() => {
    if (!valuApi) return;
    valuApi.pushRoute(pathname);
  }, [valuApi, pathname]);

  return null;
}
```

What this does:

* Listens to internal route changes via `useLocation()`
* Pushes the current pathname to Valu Social
* Keeps host and iframe URLs aligned

---

## Example Application Setup

Below is an example of how the bridge is used inside a React application with React Router:

```tsx
export default function Home() {
  return (
    <BrowserRouter>
      <ValuRouterBridge />

      <div className="flex flex-col min-h-screen">
        <TopBar isIFrame={false} />

        <main className="flex-grow w-full px-4 py-8">
          <div className="max-w-[1400px] mx-auto">
            <Routes>
              <Route path="/" element={<Navigate to="/console" replace />} />

              <Route
                path="/console"
                element={
                  <>
                    <Console />
                    <SampleApiCalls />
                  </>
                }
              />

              <Route path="/storage" element={<ApplicationStorage />} />
              <Route path="/documentation" element={<Documentation />} />
            </Routes>
          </div>
        </main>

        <Footer />
      </div>
    </BrowserRouter>
  );
}
```
---

## Best Practices

* Always report route changes using `valuApi.pushRoute`
* Use relative paths (e.g. `/console`, `/page/1`)
* Ensure your app can handle being opened directly on any route

## Sample Project

We've created a sample application integrated with Valu API.  
Check out the repository here and feel free to leave comments or feedback:

[https://github.com/Roomful/ValuSampleApp](https://github.com/Roomful/ValuSampleApp)
know if you want a **quick start** section, more real-world samples, or even a troubleshooting/FAQ block!
