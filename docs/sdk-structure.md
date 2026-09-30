# What this package is, and what it deliberately is not

One sentence: **this package is a library of functions over the socket, and
everything that only the Valu Social application can do stays a dynamic intent
call with no function at all.**

That is the structure you described, and this release is the package rearranged
to match it. What follows is where each thing now lives, what moved, and the
three places the answer is not clean.

## Two surfaces, one rule

| | **service functions** | **application intents** |
|---|---|---|
| how many | 78 | 15 declared here, and however many the app adds next |
| what they are | data and actions a server can answer: users, rooms, communities, commerce, chat, resources | things that happen to a rendered page: open a dock, expand a pane, show a picker, mint an identity token |
| what serves them | the Roomful socket, the Valu Guru socket, or the SDK itself | the Valu Social application, and nothing else |
| the call | `valu.Users.current()` | `api.intents.run('AiGuru.open', { applicationId })` |
| a function per one? | **yes** — that is the package | **no** — and that is the point |
| where it runs | Valu Social, a frame application, the Valu Guru server, any Node process with a socket | inside a Valu Social frame only |

The rule that decides which side something is on: **can this package run it
itself, given a connection?** If yes it is a function. If it can only be asked
for, it is an intent, and asking is one call that takes a name.

## Why there are no `close()` or `createApplication()` functions

There were, until this release — `FrameCommands` had a method for each of the
fifteen — and your objection is the correct one: those are reference
application intents, and they are **dynamic**. The application registers its
intents at runtime and knows the full list; a package that ships a method per
intent is a copy of that list which goes stale the moment the app declares a
sixteenth, and no consumer finds out except by not having a method.

So the fifteen methods are gone and one call replaced them:

```javascript
const api = new ValuApi();

await api.intents.run('AiGuru.open', { applicationId: 'cart' });
await api.intents.run('Application.close-application');
const picked = await api.intents.run('DataProvider.pick-single', { providers: ['contacts'] });

// including an intent this package has never heard of — no release needed
await api.intents.run('Weather.forecast-tomorrow', { city: 'Kyiv' });
```

Nothing changed on the wire: it is the same `api:service-intent` message the
fifteen methods sent, and the same one a frame app has always sent.

The catalogue still carries all 92 declared intents, but now as **documentation
rather than as a gate** — `api.intents.list()` and `.describe(name)` are there
for a frame app, or a chat session generating its tools on the fly, to read the
params and descriptions out of. The application's own registry is the
authority; this is a snapshot of it, and `npm run measure:consumers` fails the
moment the two differ.

| was | is |
|---|---|
| `api.frame.openApplication(id)` | `api.intents.run('AiGuru.open', { applicationId: id })` |
| `api.frame.closeSelf()` | `api.intents.run('Application.close-application')` |
| `api.frame.closeAll()` | `api.intents.run('Application.close_all')` |
| `api.frame.expandSelf()` | `api.intents.run('Application.expand-application')` |
| `api.frame.pickSingle(opts)` | `api.intents.run('DataProvider.pick-single', opts)` |
| `api.frame.pickMultiple(opts)` | `api.intents.run('DataProvider.pick-multiple', opts)` |
| `api.frame.getApplications()` | `api.intents.run('AiGuru.get-applications')` |
| `api.frame.hasApplication(id)` | `api.intents.run('AiGuru.has-application', { applicationId: id })` |
| `api.frame.isApplicationLoaded(id)` | `api.intents.run('AiGuru.is-application-loaded', { applicationId: id })` |
| `api.frame.closeApplication(id)` | `api.intents.run('AiGuru.close', { applicationId: id })` |
| `api.frame.openCart()` | `api.intents.run('Commerce.open-cart')` |
| `api.frame.openPurchases()` | `api.intents.run('Commerce.open-purchases')` |
| `api.frame.openProducts()` | `api.intents.run('Commerce.open-products')` |
| `api.frame.getIdentityToken()` | `api.intents.run('Application.get-identity-token')` |
| `api.frame.getLogs(format)` | `api.intents.run('Logging.get-logs', { format })` |
| `FrameCommands` | `ApplicationIntents` |

One consequence worth stating plainly, because it is a behaviour change:
`client.call('AiGuru.open')` **used to work inside a frame** and now answers 501
naming `intents.run`. The application would in fact have served it — it is the
one transport that can — and it is refused anyway, because a function on
`services` is a promise that the SDK can run it *anywhere*, and nothing here can
open a dock.

## The service functions

These are the ones you asked for: functions that wrap the socket connection, the
same in all three places.

```javascript
import { createValuServices, NodeSocketAdapter } from '@arkeytyp/valu-api';

// the Valu Guru server, or any Node process
const valu = createValuServices({ socket: new NodeSocketAdapter({ connection }) });
// a frame application, over the bridge it already has
const valu = createValuServices({ transport: new ValuApi().transport });
// or, inside a frame, it is already built: new ValuApi().services

const me       = await valu.data.Users.current();
const requests = await valu.data.Users.listConnectionRequests();
const rooms    = await valu.data.Rooms.searchRooms({ query: 'design', size: 5 });
```

`valu.X.y()` answers the `{data} | {error}` envelope and never rejects;
`valu.data.X.y()` returns the payload and throws. Both are the same client
underneath — same param validation, same cache, same retry policy — so a method
is the string call with the name resolved early, not a second code path.

The whole tree, one line per function, is
[**service-api.md**](service-api.md). What each one is *for* is
[socket-functions.md](socket-functions.md); what a non-browser runtime has to
supply before some of them work is [server-functions.md](server-functions.md).

## "Get friend requests" — the one your example exposed

Of your three examples, two were already declared: `Users.current` and
`Rooms.search-rooms`. The third was not, anywhere. `SERVICE_MANIFESTS` declares
all four connection-request transitions — send, accept, decline, cancel — and no
way to **see** a request, so an agent could accept a request it had no way to
learn about. No API pointer covers it either.

The RPC exists and the Contacts screen has always used it
(`request:listRequests`), so this package declares the function itself:

```javascript
const { requests, users, hasMore } = await valu.data.Users.listConnectionRequests();
// category: 'received' (default) | 'sent', status: 'pending' (default), offset, size
```

It resolves everybody named in the page in **one** batched lookup, which is one
better than the app does it.

That makes `SERVICE_MANIFESTS` no longer the only source of functions, so the
two counts are kept apart everywhere and every descriptor carries a
`declaredBy`:

- **92** — what the application declares. A fact about `valusocial-web`; it does
  not move when this package adds something.
- **1** — what this package declares ([`scripts/extensions.js`](../scripts/extensions.js)).
- **78** — service functions, which is what a consumer actually gets.

The bar for a second one is in that file, and it is deliberately high: the RPC
must already exist and the app must already call it, the socket must serve it
for any authenticated caller, no declared intent may cover it, and **the app
should declare it** — an entry there is a gap being carried, not a fork. Three
candidates that meet the first three tests and not the fourth are listed at the
bottom of it, each a decision about what an agent may *do* rather than see:
removing a connection, follow/unfollow, and listing community invitations.

## What this means for the Valu Guru server

Today its agent tools are hand-written socket wrappers: a tool definition and a
handler per tool, 39 of them, each repeating the RPC name, the `{data}`
envelope rule and its own error mapping. This package is those handlers,
already written, already tested against both a browser socket and a node
socket.

```typescript
// before — src/valu-tools/users.ts, one of 39
const ack = await ctx.socket.emit("social:getUsersSimpleInfo", { ids: [selfId] });
if (ack.error?.status) return { success: false, error: ackError(ack, "failed to load current user") };
const user = ack.data?.users?.find((u) => u.id === selfId) ?? null;
if (!user) return { success: false, error: "current user not found" };
return { success: true, user };

// after
const ack = await valu.Users.current();
return ack.error ? { success: false, error: ackErrorMessage(ack) } : { success: true, ...ack.data };
```

The tool *definitions* come off the same descriptors — `valu.toolDefinitions()`
returns them in the shape the server already hands the model — so a tool's
schema and the validator that enforces it stop being two things that can drift.

Two things it must **not** adopt, both already in
[transition.md](transition.md):

1. **The 11 `valuguru`-channel functions.** That server *is* the Valu Guru
   socket — it registers `valuguru.commerce.*` and `rag_search` itself. Routing
   them through this package would be the server calling itself over a socket
   it is serving. Adoptable there is `roomful` + `local` = 62, of which it
   already has 31, so an agent gains **31** functions.
2. **The 15 application intents.** There is no bridge in a headless process and
   no frame to command, so `ApplicationIntents` refuses a socket transport at
   construction rather than failing fifteen times at run time.

## API pointers, and why they have no functions either

Your reading is right, and it is the same rule from the other side. An API
pointer is the older, generic path over the same bridge:

```javascript
const usersApi = await valuApi.getApi('users');
const me = await usersApi.run('current');
```

`run` takes a string and an object and nothing checks either side, here or in
the application. This package gives pointers no catalogue and no per-function
method — not an omission: a pointer call is a message forwarded to code this
package has never seen, so there is nothing to wrap. The services SDK has a
function per function *because* it carries the implementation.

They are unchanged by all of this, and 41 of the app's 63 pointer functions have
no declared intent at all — theming, resize, network switching, modals, logout,
removing a connection — so a pointer is still the only way to reach those. The
full inventory, and which ones now have a service function instead, is
[api-pointers.md](api-pointers.md).

## Where the answer is not clean

Three, stated rather than smoothed over:

1. **Five functions are `binding: socket` with no RPC behind them** — the two
   AiGuru histories, the two Developer Portal calls, `VerusWallet.get-balance`.
   The manifest declares them like any other data intent; the answer is in the
   application's memory. They are on the function tree, and a runtime that does
   not hold that state gets an ack naming the single capability it wanted.
   `channel: 'app-state'` is how the catalogue says so
   ([postmessage-vs-socket.md](postmessage-vs-socket.md)).
2. **`Commerce.open-cart` and its two siblings are intents, not functions**,
   while the other nine Commerce calls are functions. One service, both
   surfaces — because "open the cart drawer" is a thing that happens to a page
   and "list my products" is not.
3. **Inside a frame, every service function still travels over postMessage.**
   The application serves it from its own socket. Nothing is bypassed and no
   second connection is opened; `channel` only starts to matter when there is
   no application around you.

## The counts

| | n |
|---|---|
| intents the application declares | 92 |
| functions this package declares itself | 1 |
| **service functions — the library** | **78** |
| … on the Roomful socket | 54 |
| … on the Valu Guru socket | 11 |
| … answered from application state | 5 |
| … answered locally by the SDK | 8 |
| **application intents — no function, one dynamic call** | **15** |
| API pointer functions (generic, untyped) | 63 |

Every number here is read back out of the catalogue by
`test/sdk-structure.test.js`, so this page fails the build rather than going
quietly out of date.
