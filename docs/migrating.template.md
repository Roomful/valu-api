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
1. Install @arkeytyp/valu-api@^{{VERSION}} from npm.
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
npm install @arkeytyp/valu-api@^{{VERSION}}
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

Generated from valu-api {{VERSION}} (`BRIDGE_REPLACEMENTS`). In code, `bridgeReplacement(kind, name)` from `@arkeytyp/valu-api/src/scan/index.js` answers the same thing. Parameters written `{...}` are the old call's parameters; their exact names are in the types.

{{REPLACEMENT_TABLE}}
### Raw postMessage

| Old message | Use instead |
|---|---|
| `api:run-intent` | the `valu.*` function for the intent (Intents table) |
| `api:service-intent` | the `valu.*` function for the service intent (Intents table) |
| `api:create-pointer` then `api:run` | the `valu.*` function for each API call (API pointers table) |
