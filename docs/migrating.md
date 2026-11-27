---
title: Migrate to Valu API 2
description: How to move an app from valu-api 1.x or the old postMessage bridge to valu-api 2 (createValuApp). Written for AI coding agents; humans can follow it too.
---

# Migrate to Valu API 2

This page moves an app that runs inside Valu Social from **valu-api 1.x** (`new ValuApi()`, `getApi().run()`, `sendIntent`, `callService`, `runConsoleCommand`, `pushRoute`) or from **raw `postMessage`** (`api:run-intent`, `api:service-intent`, `api:create-pointer`) to **valu-api 2** and its typed functions on `createValuApp()`.

Valu Social is closing the old bridge. An app that still uses it stops getting answers once the bridge is closed for it.

It is written so you can hand it to an AI coding agent as is. Give the agent this page's address, https://docs.texpo.io/valu-api-migration.md, or the prompt below.

## Prompt for your AI agent

Copy this into Claude Code, Cursor or any coding agent, from the app's repository:

```text
This app runs inside Valu Social and talks to it through @arkeytyp/valu-api 1.x
or raw postMessage (the "old bridge"). Migrate it to valu-api 2.

Follow https://docs.texpo.io/valu-api-migration.md step by step:
1. Install @arkeytyp/valu-api@^2.5.0 from npm.
2. Read node_modules/@arkeytyp/valu-api/README.md, CHANGELOG.md and
   types/valu-api.d.ts + types/valu-services.d.ts before writing code.
3. Run the find-old-valu-calls.mjs script from that page to list every old call.
4. Replace each one with the typed function the page's table names.
   Use only functions that exist in the types; never guess a name.
   Where the old code used the answer directly, call valu.data.<Service>.<fn>().
5. Remove ValuApi, Intent, getApi, sendIntent, callService, runConsoleCommand,
   pushRoute/replaceRoute and every postMessage to the parent window.
6. Run the script again: it must report 0 old-bridge calls. Then build and run the tests.
Tell me about any call the table marks "similar, not the same" or has no replacement for.
```

## 1. Install valu-api 2

```bash
npm install @arkeytyp/valu-api@^2.5.0
```

If the app was installed from a GitHub commit (`github:Roomful/valu-api#…`), replace that with the npm version.

A page with no build step imports the package as an ES module:

```js
import { createValuApp } from 'https://cdn.jsdelivr.net/npm/@arkeytyp/valu-api@2/src/ValuApi.js';
```

The package carries its own docs for the version you installed. Read them before changing code:

- `node_modules/@arkeytyp/valu-api/README.md`: how `createValuApp()` works (the same text as [Valu API](https://docs.texpo.io/valu-api)).
- `node_modules/@arkeytyp/valu-api/CHANGELOG.md`: what changed in each release since 2.0.0.
- `node_modules/@arkeytyp/valu-api/types/valu-api.d.ts` and `types/valu-services.d.ts`: every function, its parameters and what it returns.
- [The service API](https://docs.texpo.io/valu-api-functions) and the [Functions explorer](https://docs.texpo.io/explorer/functions): the same functions, browsable.

## 2. Find every old call

Save this as `find-old-valu-calls.mjs` in the app's root and run `node find-old-valu-calls.mjs`. It uses the scanner inside valu-api 2 (the same one Valu uses to count old-bridge use) and prints each old call with the function that replaces it.

```js
// Lists every call this app makes over the old Valu bridge and what replaces it.
// Run from the app's root: node find-old-valu-calls.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { detectScopes, bridgeReplacement } from '@arkeytyp/valu-api/src/scan/index.js';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage']);
const EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte', '.html']);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (EXT.has(extname(name))) files.push({ path, text: readFileSync(path, 'utf8') });
  }
})('.');

const { findings, bridge } = detectScopes(files);
const old = [...findings, ...bridge].filter((f) => f.kind === 'bridge');
for (const f of old) {
  const use = f.message === 'pointer-run' && !f.name.includes('.')
    ? `check every .run(fn) on getApi('${f.name}'): look up ${f.name}.<fn> in the table`
    : bridgeReplacement(f.message, f.name) ?? 'no typed replacement: see the table';
  console.log(`${f.file}:${f.line}  ${f.message} ${f.name}  →  ${use}`);
}
console.log(`\n${old.length} old-bridge call(s).`);
```

Example output:

```text
src/app.js:3  pointer-run users  →  check every .run(fn) on getApi('users'): look up users.<fn> in the table
src/app.js:5  run-intent textchat.open-channel  →  valu.Chats.openChannel({...})
src/app.js:6  run-console network.id  →  valu.Networks.getCurrentNetwork() (similar, not the same)
src/app.js:7  run-command pushRoute  →  valu.route.push(path)
src/app.js:8  direct api:run-intent  →  the valu.* function for each intent
```

The scanner reads code as text. When a call is built dynamically (an API name in a variable, a wrapper around `sendIntent`), it may report only part of it or miss it. Also search the code yourself for `getApi(`, `.run(`, `sendIntent(`, `callService(`, `runConsoleCommand(`, `pushRoute(`, `replaceRoute(` and `postMessage(`.

## 3. Replace the calls

Create the Valu object once, at start-up, and use it everywhere:

```js
import { createValuApp } from '@arkeytyp/valu-api';

const valu = await createValuApp();
```

### Before and after

```js
// valu-api 1.x
import { ValuApi, Intent } from '@arkeytyp/valu-api';
const valuApi = new ValuApi();
const usersApi = await valuApi.getApi('users');
const me = await usersApi.run('current');
await valuApi.sendIntent(new Intent('textchat', 'open-channel', { userId: me.id }));
valuApi.pushRoute('/settings');
```

```js
// valu-api 2
import { createValuApp } from '@arkeytyp/valu-api';
const valu = await createValuApp();
const me = await valu.data.Users.current();
await valu.Chats.openChannel({ userId: me.id });
valu.route.push('/settings');
```

Raw `postMessage` code (`window.parent.postMessage({ name: 'api:run-intent', … })`) goes the same way: find what each message asks for in the table below and call that function instead.

### Rules for the replacement

- **Envelope or value.** `valu.Users.current()` answers an envelope, `{data}` or `{error}`, and never throws. `valu.data.Users.current()` answers the value itself and throws `ValuServiceError` on an error, like the old `.run()` did. The table writes the envelope form; put `.data` after `valu` wherever the old code used the answer directly. This applies to service functions (`valu.data.<Service>.<fn>`); app intents such as `valu.Chats.openChannel()` are called as written.
- **Check every function against the types** (`types/valu-services.d.ts`). The table names the function; the types give its exact parameters and return value. Some answers changed shape (for example `valu.Users.getIcon()` answers `{url}`, where the old `users.getIcon` answered a bare string).
- **"Similar, not the same"** means the new function does a related job but not exactly the old one (for example `app.close` → `valu.Application.closeApplication()` closes only the calling app). Read its description in the types and check the app still behaves as intended.
- **No replacement:** the old call has no typed function yet. Leave it, keep a comment on it, and report it to the Valu team rather than calling the old bridge some other way.
- **Permissions:** a call that needs a scope the app hasn't declared is refused. See [Permissions](https://docs.texpo.io/valu-api#permissions).

## 4. Check it

1. `node find-old-valu-calls.mjs` reports **0 old-bridge calls**, and the code no longer imports `ValuApi` or `Intent` and posts nothing to the parent window.
2. The app builds and its tests pass.
3. Open the app inside Valu Social: it loads, knows the user, and its routes and intents work.

After you deploy, Valu sees the app report valu-api 2 and stops counting old-bridge calls for it.

## Replacement table

Generated from valu-api 2.5.0 (`BRIDGE_REPLACEMENTS`). In code, `bridgeReplacement(kind, name)` from `@arkeytyp/valu-api/src/scan/index.js` answers the same thing. Parameters written `{...}` are the old call's parameters; their exact names are in the types.

### API pointers: `getApi(api)` then `.run(fn)`

Key: `api.fn`. `(await valuApi.getApi('users')).run('current')` is `users.current`.

| Old call | Use instead |
|---|---|
| `app.close` | `valu.Application.closeApplication()` (similar, not the same) |
| `app.expand` | `valu.Application.expandApplication()` (similar, not the same) |
| `app.getApplicationHeader` | `valu.Apps.getHeader(applicationId)` |
| `app.getApplications` | `valu.Apps.list()` |
| `app.getLoadedApplications` | `valu.Apps.loaded()` |
| `app.hasApplication` | `valu.Apps.has(applicationId)` |
| `app.isApplicationLoaded` | `valu.Apps.isLoaded(applicationId)` |
| `app.open` | `valu.Apps.open(appId)` |
| `network.get` | `valu.Networks.getCurrentNetwork()` (similar, not the same) |
| `network.id` | `valu.Networks.getCurrentNetwork()` (similar, not the same) |
| `resources.getResourceUrl` | `valu.Resources.generatePublicUrl({...})` (similar, not the same) |
| `resources.getThumbnailUrl` | `valu.Resources.getThumbnailUrl({...})` (similar, not the same) |
| `resources.listBotAvatars` | `valu.Resources.listBotAvatars({...})` |
| `rooms.getFullModel` | `valu.Rooms.getRoom({...})` (similar, not the same) |
| `rooms.getMeta` | `valu.Rooms.getRoom({...})` |
| `rooms.getPermissions` | `valu.Rooms.getPermissions({...})` |
| `rooms.getRoomPermissions` | `valu.Rooms.getPermissions({...})` |
| `u.acceptFriendRequest` | `valu.Users.acceptConnectionRequest({...})` |
| `u.cancelFriendshipRequest` | `valu.Users.cancelConnectionRequest({...})` |
| `u.current` | `valu.Users.current()` |
| `u.declineFriendRequest` | `valu.Users.declineConnectionRequest({...})` |
| `u.get` | `valu.Users.get({...})` |
| `u.getFollowersCount` | `valu.Users.searchUsers({...})` (similar, not the same) |
| `u.getIcon` | `valu.Users.getIcon({...})` |
| `u.requestFriendship` | `valu.Users.sendConnectionRequest({...})` |
| `users.acceptFriendRequest` | `valu.Users.acceptConnectionRequest({...})` |
| `users.cancelFriendshipRequest` | `valu.Users.cancelConnectionRequest({...})` |
| `users.current` | `valu.Users.current()` |
| `users.declineFriendRequest` | `valu.Users.declineConnectionRequest({...})` |
| `users.get` | `valu.Users.get({...})` |
| `users.getFollowersCount` | `valu.Users.searchUsers({...})` (similar, not the same) |
| `users.getIcon` | `valu.Users.getIcon({...})` |
| `users.requestFriendship` | `valu.Users.sendConnectionRequest({...})` |
| `ux.colorScheme` | `valu.theme.scheme` |
| `ux.toggleColorScheme` | `valu.theme.toggle()` |

### Console commands: `runConsoleCommand('api fn …')`

Key: the first two words, as `api.fn`. `runConsoleCommand('users current')` is `users.current`.

| Old command | Use instead |
|---|---|
| `app.close` | `valu.Application.closeApplication()` (similar, not the same) |
| `app.expand` | `valu.Application.expandApplication()` (similar, not the same) |
| `app.getApplicationHeader` | `valu.Apps.getHeader(applicationId)` |
| `app.getApplications` | `valu.Apps.list()` |
| `app.getLoadedApplications` | `valu.Apps.loaded()` |
| `app.hasApplication` | `valu.Apps.has(applicationId)` |
| `app.isApplicationLoaded` | `valu.Apps.isLoaded(applicationId)` |
| `app.open` | `valu.Apps.open(appId)` |
| `network.get` | `valu.Networks.getCurrentNetwork()` (similar, not the same) |
| `network.id` | `valu.Networks.getCurrentNetwork()` (similar, not the same) |
| `resources.getResourceUrl` | `valu.Resources.generatePublicUrl({...})` (similar, not the same) |
| `resources.getThumbnailUrl` | `valu.Resources.getThumbnailUrl({...})` (similar, not the same) |
| `resources.listBotAvatars` | `valu.Resources.listBotAvatars({...})` |
| `rooms.getFullModel` | `valu.Rooms.getRoom({...})` (similar, not the same) |
| `rooms.getMeta` | `valu.Rooms.getRoom({...})` |
| `rooms.getPermissions` | `valu.Rooms.getPermissions({...})` |
| `rooms.getRoomPermissions` | `valu.Rooms.getPermissions({...})` |
| `u.acceptFriendRequest` | `valu.Users.acceptConnectionRequest({...})` |
| `u.cancelFriendshipRequest` | `valu.Users.cancelConnectionRequest({...})` |
| `u.current` | `valu.Users.current()` |
| `u.declineFriendRequest` | `valu.Users.declineConnectionRequest({...})` |
| `u.get` | `valu.Users.get({...})` |
| `u.getFollowersCount` | `valu.Users.searchUsers({...})` (similar, not the same) |
| `u.getIcon` | `valu.Users.getIcon({...})` |
| `u.requestFriendship` | `valu.Users.sendConnectionRequest({...})` |
| `users.acceptFriendRequest` | `valu.Users.acceptConnectionRequest({...})` |
| `users.cancelFriendshipRequest` | `valu.Users.cancelConnectionRequest({...})` |
| `users.current` | `valu.Users.current()` |
| `users.declineFriendRequest` | `valu.Users.declineConnectionRequest({...})` |
| `users.get` | `valu.Users.get({...})` |
| `users.getFollowersCount` | `valu.Users.searchUsers({...})` (similar, not the same) |
| `users.getIcon` | `valu.Users.getIcon({...})` |
| `users.requestFriendship` | `valu.Users.sendConnectionRequest({...})` |
| `ux.colorScheme` | `valu.theme.scheme` |
| `ux.toggleColorScheme` | `valu.theme.toggle()` |

### Intents: `sendIntent(new Intent(app, action))` and `callService(new Intent(service, action))`

Key: `target.action`. `new Intent('textchat', 'open-channel', …)` is `textchat.open-channel`. Any app opened with `new Intent('<app>')` (no action) is `valu.Apps.open('<app>')`.

| Old intent | Use instead |
|---|---|
| `AiGuru.get-application-header` | `valu.Apps.getHeader(applicationId)` |
| `AiGuru.get-applications` | `valu.Apps.list()` |
| `AiGuru.get-loaded-applications` | `valu.Apps.loaded()` |
| `AiGuru.has-application` | `valu.Apps.has(applicationId)` |
| `AiGuru.is-application-loaded` | `valu.Apps.isLoaded(applicationId)` |
| `Application.close-application` | `valu.Application.closeApplication()` |
| `Application.close_all` | `valu.Application.closeAll()` |
| `Application.expand-application` | `valu.Application.expandApplication()` |
| `Application.get-identity-token` | `valu.Application.getIdentityToken()` |
| `CMS.file-search` | `valu.CMS.fileSearch({...})` |
| `CMS.pick-resource` | `valu.CMS.pickResource({...})` |
| `Commerce.add-to-cart` | `valu.Commerce.addToCart({...})` |
| `Commerce.archive-product` | `valu.Commerce.archiveProduct({...})` |
| `Commerce.check-entitlements` | `valu.Commerce.checkEntitlements({...})` |
| `Commerce.checkout` | `valu.Commerce.checkout({...})` |
| `Commerce.clear-cart` | `valu.Commerce.clearCart()` |
| `Commerce.create-discount-code` | `valu.Commerce.createDiscountCode({...})` |
| `Commerce.create-product` | `valu.Commerce.createProduct({...})` |
| `Commerce.create-store` | `valu.Commerce.createStore({...})` |
| `Commerce.delete-discount-code` | `valu.Commerce.deleteDiscountCode({...})` |
| `Commerce.delete-product` | `valu.Commerce.deleteProduct({...})` |
| `Commerce.end-sale` | `valu.Commerce.endSale({...})` |
| `Commerce.get-analytics` | `valu.Commerce.getAnalytics({...})` |
| `Commerce.get-cart` | `valu.Commerce.getCart()` |
| `Commerce.get-display` | `valu.Commerce.getDisplay()` |
| `Commerce.get-my-product` | `valu.Commerce.getMyProduct({...})` |
| `Commerce.get-my-store` | `valu.Commerce.getMyStore()` |
| `Commerce.get-order` | `valu.Commerce.getOrder({...})` |
| `Commerce.get-product` | `valu.Commerce.getProduct({...})` |
| `Commerce.get-purchase-contents` | `valu.Commerce.getPurchaseContents({...})` |
| `Commerce.list-categories` | `valu.Commerce.listCategories()` |
| `Commerce.list-my-products` | `valu.Commerce.listMyProducts({...})` |
| `Commerce.list-network-access` | `valu.Commerce.listNetworkAccess()` |
| `Commerce.list-orders` | `valu.Commerce.listOrders({...})` |
| `Commerce.list-products` | `valu.Commerce.listProducts({...})` |
| `Commerce.list-promotions` | `valu.Commerce.listPromotions()` |
| `Commerce.list-purchases` | `valu.Commerce.listPurchases({...})` |
| `Commerce.list-seller-products` | `valu.Commerce.listSellerProducts({...})` |
| `Commerce.mark-purchase-file-seen` | `valu.Commerce.markPurchaseFileSeen({...})` |
| `Commerce.open-cart` | `valu.Commerce.openCart({...})` |
| `Commerce.open-order` | `valu.Commerce.openOrder({...})` |
| `Commerce.open-products` | `valu.Commerce.openProducts({...})` |
| `Commerce.open-purchase-in-media` | `valu.Commerce.openPurchaseInMedia({...})` |
| `Commerce.open-purchases` | `valu.Commerce.openPurchases({...})` |
| `Commerce.preview-promo` | `valu.Commerce.previewPromo({...})` |
| `Commerce.preview-purchase` | `valu.Commerce.previewPurchase({...})` |
| `Commerce.publish-product` | `valu.Commerce.publishProduct({...})` |
| `Commerce.quote-bundle` | `valu.Commerce.quoteBundle({...})` |
| `Commerce.rate-product` | `valu.Commerce.rateProduct({...})` |
| `Commerce.remove-from-cart` | `valu.Commerce.removeFromCart({...})` |
| `Commerce.remove-volume-tier` | `valu.Commerce.removeVolumeTier({...})` |
| `Commerce.request-network-access` | `valu.Commerce.requestNetworkAccess({...})` |
| `Commerce.set-donation-tiers` | `valu.Commerce.setDonationTiers({...})` |
| `Commerce.set-sale` | `valu.Commerce.setSale({...})` |
| `Commerce.set-volume-tier` | `valu.Commerce.setVolumeTier({...})` |
| `Commerce.subscribe-events` | `valu.Commerce.subscribeEvents({...})` |
| `Commerce.unlist-product` | `valu.Commerce.unlistProduct({...})` |
| `Commerce.unsubscribe-events` | `valu.Commerce.unsubscribeEvents({...})` |
| `Commerce.update-cart-item` | `valu.Commerce.updateCartItem({...})` |
| `Commerce.update-discount-code` | `valu.Commerce.updateDiscountCode({...})` |
| `Commerce.update-product` | `valu.Commerce.updateProduct({...})` |
| `DataProvider.pick-multiple` | `valu.DataProvider.pickMultiple({...})` |
| `DataProvider.pick-single` | `valu.DataProvider.pickSingle({...})` |
| `Developer.list-application-apis` | `valu.Developer.listApplicationApis()` |
| `Developer.list-my-application-apis` | `valu.Developer.listMyApplicationApis()` |
| `RoomPoints.create-room-point` | `valu.RoomPoints.createRoomPoint({...})` |
| `RoomPoints.delete-room-point` | `valu.RoomPoints.deleteRoomPoint({...})` |
| `RoomPoints.edit-room-point` | `valu.RoomPoints.editRoomPoint({...})` |
| `RoomPoints.list-room-points` | `valu.RoomPoints.listRoomPoints({...})` |
| `RoomPoints.save-room-point` | `valu.RoomPoints.saveRoomPoint({...})` |
| `RoomZones.assign-zone` | `valu.RoomZones.assignZone({...})` |
| `RoomZones.claim-zone` | `valu.RoomZones.claimZone({...})` |
| `RoomZones.list-room-zones` | `valu.RoomZones.listRoomZones({...})` |
| `RoomZones.release-zone` | `valu.RoomZones.releaseZone({...})` |
| `RoomZones.zone-occupancy` | `valu.RoomZones.zoneOccupancy({...})` |
| `Users.get-icon` | `valu.Users.getIcon({...})` |
| `cart.add-to-cart` | `valu.MyCart.addToCart({...})` |
| `cart.open-cart` | `valu.MyCart.openCart({...})` |
| `cart.open-order` | `valu.MyCart.openOrder({...})` |
| `cart.open-orders` | `valu.MyCart.openOrders({...})` |
| `cart.open-product` | `valu.MyCart.openProduct({...})` |
| `cart.open-purchased` | `valu.MyCart.openPurchased({...})` |
| `cart.open-section` | `valu.MyCart.openSection({...})` |
| `cms.preview-resource` | `valu.Files.previewResource({...})` |
| `cms.show-application-storage` | `valu.Files.showApplicationStorage({...})` |
| `cms.show-chat-channel` | `valu.Files.showChatChannel({...})` |
| `cms.show-community-channel` | `valu.Files.showCommunityChannel({...})` |
| `cms.show-folder` | `valu.Files.showFolder({...})` |
| `cms.show-my-files` | `valu.Files.showMyFiles({...})` |
| `cms.show-resource` | `valu.Files.showResource({...})` |
| `community.create-channel` | `valu.Social.createChannel({...})` |
| `community.create-post` | `valu.Social.createPost({...})` |
| `community.open-community` | `valu.Social.openCommunity({...})` |
| `community.show-channel` | `valu.Social.showChannel({...})` |
| `community.show-post` | `valu.Social.showPost({...})` |
| `contacts.show-user-connections` | `valu.Contacts.showUserConnections({...})` |
| `content-studio.navigate` | `valu.ContentStudio.navigate({...})` |
| `content-studio.open-create` | `valu.ContentStudio.openCreate({...})` |
| `content-studio.open-edit` | `valu.ContentStudio.openEdit({...})` |
| `content-studio.open-search` | `valu.ContentStudio.openSearch({...})` |
| `events.open-calendar` | `valu.Calendar.openCalendar({...})` |
| `games.open` | `valu.ValuGames.open({...})` |
| `groups.open` | `valu.Groups.open({...})` |
| `hubs.enter-room` | `valu.Metaverse2D.enterRoom({...})` |
| `hubs.find-people` | `valu.Metaverse2D.findPeople({...})` |
| `hubs.open` | `valu.Metaverse2D.open({...})` |
| `merchant.open-product` | `valu.MerchantConsole.openProduct({...})` |
| `merchant.open-products` | `valu.MerchantConsole.openProducts({...})` |
| `merchant.open-section` | `valu.MerchantConsole.openSection({...})` |
| `metaverse.open-room` | `valu.Metaverse.openRoom({...})` |
| `metaverse.preview-prop` | `valu.Metaverse.previewProp({...})` |
| `metaverse.set-route` | `valu.Metaverse.setRoute({...})` |
| `preview.preview` | `valu.ResourcesViewer.preview({...})` |
| `profile.open-profile-with-mode` | `valu.Profile.openProfileWithMode({...})` |
| `profile.show-current-user` | `valu.Profile.showCurrentUser({...})` |
| `profile.show-user` | `valu.Profile.showUser({...})` |
| `puzzles.start-puzzle` | `valu.ValuPuzzles.startPuzzle({...})` |
| `rooms.invite-to-room` | `valu.Rooms.inviteToRoom({...})` |
| `rooms.open` | `valu.Rooms.open({...})` |
| `rooms.show-room` | `valu.Rooms.showRoom({...})` |
| `textchat.close-channel` | `valu.Chats.closeChannel({...})` |
| `textchat.get-ui-state` | `valu.Chats.getUiState({...})` |
| `textchat.open-channel` | `valu.Chats.openChannel({...})` |
| `textchat.open-room-ai-chat` | `valu.Chats.openRoomAiChat({...})` |
| `textchat.options` | `valu.Chats.options({...})` |
| `textchat.send-message` | `valu.Chats.sendMessage({...})` |
| `textchat.share-card` | `valu.Chats.shareCard({...})` |
| `user-card.show` | `valu.UserCard.show({...})` |
| `valuguru.create-chatbot` | `valu.ValuGuru.createChatbot({...})` |
| `valuguru.open` | `valu.ValuGuru.open({...})` |
| `valuguru.open-agent` | `valu.ValuGuru.openAgent({...})` |
| `valuguru.open-chat` | `valu.ValuGuru.openChat({...})` |
| `valuguru.open-chatbot` | `valu.ValuGuru.openChatbot({...})` |
| `valuguru.show-agents` | `valu.ValuGuru.showAgents({...})` |
| `valuguru.start-session` | `valu.ValuGuru.startSession({...})` |
| `videochat.connect-to-meeting` | `valu.Calls.connectToMeeting({...})` |
| `videochat.leave-meeting` | `valu.Calls.leaveMeeting({...})` |
| `videochat.open-source-picker` | `valu.Calls.openSourcePicker({...})` |

### Routing: `pushRoute` / `replaceRoute`

| Old command | Use instead |
|---|---|
| `pushRoute` | `valu.route.push(path)` |
| `replaceRoute` | `valu.route.replace(path)` |
### Raw postMessage

| Old message | Use instead |
|---|---|
| `api:run-intent` | the `valu.*` function for the intent (Intents table) |
| `api:service-intent` | the `valu.*` function for the service intent (Intents table) |
| `api:create-pointer` then `api:run` | the `valu.*` function for each API call (API pointers table) |
