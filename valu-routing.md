# Valu API — Routing

Routing is **completely optional**. Your app works inside Valu without any routing code at all.

For the full Valu API reference, see the [official README](https://github.com/Roomful/valu-api/blob/main/README.md).

---

## What Valu Does Out of the Box

Valu automatically maps host URLs to iframe URLs with **zero configuration**:

```
https://valu-social.com/your-app/page/1
→ loads iframe at →
https://your-app.com/page/1
```

This means if your app uses any standard router (React Router, Vue Router, etc.), the correct page will render automatically when Valu opens it. **No Valu API code is needed for this to work.**

---

## What Is Optional

Both directions of route synchronization are opt-in. You choose what your app needs:

| Feature | Required? | What it does |
|---|---|---|
| Reading the initial URL | No | Your app can just always show the same page |
| Listening to `ON_ROUTE` events | No | Only needed if you want to react when Valu changes the route while your app is already open |
| Calling `pushRoute` / `replaceRoute` | No | Only needed if you want Valu's browser URL to update when the user navigates inside your app |

You can implement **none**, **one**, or **both** — depending on your app's needs.

---

## When You Might Want Routing

- **Multi-page app** — your app has tabs or views and you want deep links to work
- **Shareable URLs** — users should be able to copy/share a link that opens a specific page
- **Back/forward navigation** — browser back button should navigate within your app

If your app is a single page or doesn't need any of the above, skip routing entirely.

---

## Implementation Options

### Option A: React Router + ValuRouterBridge (Recommended)

Use your standard React Router setup. Add a small bridge component that reports route changes to Valu:

```tsx
import { useEffect } from "react";
import { useLocation } from "react-router-dom";

export function ValuRouterBridge() {
  const valuApi = useValuAPI();
  const { pathname } = useLocation();

  useEffect(() => {
    if (!valuApi) return;
    valuApi.pushRoute(pathname);
  }, [valuApi, pathname]);

  return null;
}
```

Then place it inside your `BrowserRouter`:

```tsx
<BrowserRouter>
  <ValuRouterBridge />
  <Routes>
    <Route path="/" element={<Home />} />
    <Route path="/settings" element={<Settings />} />
  </Routes>
</BrowserRouter>
```

This approach works because Valu already passes the correct path in the iframe URL — React Router picks it up automatically. The bridge just keeps Valu's URL bar in sync when the user navigates inside your app.

### Option B: Manual State-Based Routing

If you prefer not to use a client-side router, manage routing with simple state:

```tsx
const [route, setRoute] = useState(
  () => window.location.pathname || "/home"
);

// Optional: listen for Valu route changes
useEffect(() => {
  if (!valuApi) return;
  const handler = (r: string) => setRoute(r);
  valuApi.addEventListener(ValuApi.ON_ROUTE, handler);
  return () => valuApi.removeEventListener(ValuApi.ON_ROUTE, handler);
}, [valuApi]);

// Optional: notify Valu on internal navigation
function navigate(path: string) {
  setRoute(path);
  valuApi?.pushRoute(path);
}

// Render
if (route.startsWith("/settings")) return <Settings />;
return <Home />;
```

---

## Opening an App with a Specific Route via Intent

You can open another Valu application (or your own) at a specific route by passing a `route` parameter in the Intent. If the target app is already open, its route will be updated instead.

```ts
import { Intent } from "@arkeytyp/valu-api";

const intent = new Intent("cms", Intent.ACTION_OPEN, {
  route: "room/all"
});
await valuApi.sendIntent(intent);
```

By default, this **does not** add a history entry. If you want the route change to be added to the navigation history, pass `pushToHistory: true`:

```ts
const intent = new Intent("cms", Intent.ACTION_OPEN, {
  route: "room/all",
  pushToHistory: true
});
await valuApi.sendIntent(intent);
```

| Parameter | Default | Description |
|---|---|---|
| `route` | — | The route to open the app at (e.g. `"room/all"`, `"settings/profile"`) |
| `pushToHistory` | `false` | When `true`, adds a history entry so the user can navigate back |

---

## API Quick Reference

For full documentation, see the [Valu API README](https://github.com/Roomful/valu-api/blob/main/README.md).

| Method / Event | Direction | Description |
|---|---|---|
| `valuApi.pushRoute(path)` | App -> Valu | Notify Valu of a navigation. Adds a history entry. |
| `valuApi.replaceRoute(path)` | App -> Valu | Same, but replaces the current history entry (use for redirects). |
| `ValuApi.ON_ROUTE` event | Valu -> App | Fires when Valu changes the route externally. **Listening is optional.** |
| `onUpdateRouterContext(context)` | Valu -> App | Lifecycle callback for layout context changes (main/side/modal). Not related to page navigation. |
