# Valu API — Giving Your App a REST API

Your Valu app runs in an iframe, and other apps can already hand it work through
intents. But an intent only arrives **while your app is open in someone's
browser**. A REST API is the other door: it answers when nobody has your app
open — to Valu Guru, to a scheduled agent, to another app's backend.

This is entirely optional. An app with no REST API works exactly as it does
today.

For the Valu API reference, see the [official README](https://github.com/Roomful/valu-api/blob/main/README.md).
For the caller's side — how to *use* someone else's API — see **Application REST
APIs** in the Developer Portal's SDK guide.

> **Status: live.** The gateway, the token endpoint, the key set and the
> trusted-host door are served by the Valu Guru server —
> `valu-guru-server/docs/application-rest-api.md` is the caller's reference.
> The manifest block and the verification algorithm below are the contract.

---

## What You Are Signing Up For

Five things, and only the first two are work:

1. Serve an **OpenAPI document** describing your endpoints.
2. **Verify a JWT** on every request — about twelve lines.
3. Return errors in the platform's envelope.
4. Answer a health check.
5. Add an `api` block to your manifest and publish a version.

No OAuth server. No key exchange with each app that wants to call you. No
registration per caller. You verify one signature against one public key set,
and you are done.

---

## 1. Where Your API Lives

By convention, at your app's own origin:

```
https://your-app.com/valu/v1/…
```

If your iframe is served from `https://your-app.com/`, that is where the
platform will look, and you declare nothing. If your API lives somewhere else —
a separate host, a different path — say so in the manifest (§5).

Callers do not use that URL. They use a standardized one:

```
https://<valu-guru-host>/api/apps/v1/your-app-id/…
```

The gateway holds the mapping and forwards. This means your API's public address
never changes even if you move hosts, and it means you are not reachable by the
open internet without a valid token.

**Two kinds of caller reach you through it, and you verify both the same way.**
A backend mints a token from its client credentials. A PAGE — Valu Social
itself, or a workspace app served from its own host under the platform's site
domain — cannot hold a secret, so the gateway admits it by its `Origin` (a host
the platform owns) and mints the token on its behalf: the **trusted-host door**.
Either way what arrives at your API is a token the platform signed, with your
address as `aud`. The difference is in `sub`: an application id for a backend,
`host:<hostname>` (e.g. `host:wallet-ws-4fc02391.valuguru.app`, a workspace
app's own host) for a page. Narrow `callers` (§5) to admit one or the other. A
page's signed-in user rides as `act.sub` exactly as a backend's does, and only
when the platform verified them — so `userContext: "required"` is the way to
insist a page caller is a real person.

The SDK wraps the page side: `createAppApiClient({ gatewayBase, network,
identityToken })` from `@arkeytyp/valu-api` sends the two headers the door
reads and the identity token, and parses the error envelope. Nothing on YOUR
side changes for it.

**If Valu Guru built your app for a workspace, that address carries one more
segment** — `/api/apps/v1/{workspace}/your-app-id/…` — because such an app's id
is its project slug, which is unique only inside its own workspace. The whole
string is **your app's ADDRESS**, and §2 is where it matters: the address is what
you verify as the token's `aud`. The Developer Portal's REST API tab prints it
for your app under **Token audience**, and a project chat's own context names it
`apiAudience`. Everything else in this guide is identical either way.

---

## 2. Verify the Token

Every request carries `Authorization: Bearer <jwt>`. Verify it or you have no
API — you have a public endpoint with extra steps.

```bash
npm install jose
```

```js
import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = process.env.VALU_ISSUER;        // e.g. https://valuguru.texpo.io
const MY_AUDIENCE = 'notes';                   // YOUR app's ADDRESS (see §1)
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

export async function verifyValuToken(authorizationHeader) {
  const token = (authorizationHeader || '').replace(/^Bearer /i, '');
  if (!token) throw new Error('no token');

  const { payload } = await jwtVerify(token, JWKS, {
    issuer:     ISSUER,
    audience:   MY_AUDIENCE,    // never a wildcard, never from the request
    algorithms: ['RS256'],
  });

  return {
    callerAppId: payload.sub,                                        // who is calling
    userId:      payload.act?.sub ?? null,                           // who they act for, if anyone
    networkId:   payload.net,                                        // which network
    scopes:      String(payload.scope || '').split(' ').filter(Boolean),
  };
}
```

`jose` caches the key set and refetches on an unknown `kid`, so key rotation
needs nothing from you.

**`audience: MY_AUDIENCE` is the line that matters.** It is what stops a token
minted for some other app being replayed against yours. Never read the expected
audience from the request.

For an app Valu Guru serves for a workspace, that value is
`{workspace}/your-app-id` and **not** the bare id (§1). Pin the bare id there and
the signature verifies, the audience check fails, and every call the platform
makes comes back `401` — with nothing in it naming which of two similar strings
was wrong.

Fail closed on every branch. A token you cannot verify is a request you refuse —
not one you let through with a warning.

Not on Node? Any JWT library does this. Verify RS256 against
`{ISSUER}/.well-known/jwks.json`, require `iss`, require `aud == your app's
address`, require `exp` in the future. There is no Valu-specific cryptography.

---

## 3. A Complete API

```js
import express from 'express';
import { verifyValuToken } from './valu-auth.js';

const app = express();
app.use(express.json());

// --- The description. Public: an API's shape is not a secret. ---------------
app.get('/valu/v1/openapi.json', (req, res) => res.json(OPENAPI));
app.get('/valu/v1/health',       (req, res) => res.json({ ok: true }));

// --- Everything else needs a token. ----------------------------------------
app.use('/valu/v1', async (req, res, next) => {
  try {
    req.valu = await verifyValuToken(req.headers.authorization);
    next();
  } catch (err) {
    res.status(401).json({ error: { code: 'auth_required', message: 'Invalid token' } });
  }
});

const needs = (scope) => (req, res, next) =>
  req.valu.scopes.includes(scope)
    ? next()
    : res.status(403).json({ error: { code: 'forbidden', message: `Scope ${scope} is required` } });

app.get('/valu/v1/notes', needs('notes.read'), async (req, res) => {
  if (!req.valu.userId) {
    return res.status(403).json({
      error: { code: 'forbidden', message: 'This endpoint acts on a user and none was named' },
    });
  }
  // Scope your data by BOTH the user and the network. Same app, two networks,
  // two separate worlds — the same rule the iframe bridge already asks of you.
  const notes = await db.notes({ userId: req.valu.userId, networkId: req.valu.networkId });
  res.json({ notes });
});

app.post('/valu/v1/notes', needs('notes.write'), async (req, res) => {
  const { title } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim()) {
    return res.status(422).json({
      error: { code: 'validation_failed', message: '`title` must be a non-empty string' },
    });
  }
  const note = await db.createNote({
    userId: req.valu.userId, networkId: req.valu.networkId, title: title.trim(),
  });
  res.status(201).json({ note });
});

app.listen(3000);
```

That is the whole integration.

---

## 4. Describe It

OpenAPI 3.1 at `{baseUrl}/openapi.json`. Annotate each operation with the scope
it needs, under `x-valu`:

```jsonc
{
  "openapi": "3.1.0",
  "info": { "title": "Notes", "version": "1.0.0" },
  "paths": {
    "/notes": {
      "get": {
        "operationId": "listNotes",
        "summary": "List the acting user's notes",
        "x-valu": { "scopes": ["notes.read"] },
        "responses": { "200": { "description": "The user's notes" } }
      },
      "post": {
        "operationId": "createNote",
        "summary": "Create a note for the acting user",
        "x-valu": { "scopes": ["notes.write"] },
        "responses": { "201": { "description": "The created note" } }
      }
    }
  }
}
```

This document is not paperwork. Valu Guru reads it and turns each operation into
a tool its agents can find and call — so `operationId` and `summary` are what
decides whether the AI picks your endpoint for the right job. Write them for a
reader who has never seen your app. A `summary` of "list notes" and one of "list
the notes the acting user has written in this network, newest first" produce
measurably different behaviour.

---

## 5. Declare It

A declaration is **two links**: the gateway, where your API is served, and the
OpenAPI document, which is how anything discovers what it can do. The Portal's
REST API tab asks for exactly those two and nothing else — it has no buttons on
it, because a link is a thing you type or a thing somebody writes for you, and
everything else a declaration carries is a fact your document already states.
An app that fills in neither declares no API.

In your Developer Portal manifest:

```jsonc
"api": {
  "baseUrl": "https://api.notes.example.com/v1",
  "spec": "/openapi.json",
  "scopes": [
    { "name": "notes.read",  "description": "Read the acting user's notes" },
    { "name": "notes.write", "description": "Create and edit notes" }
  ],
  "userContext": "required"
}
```

That is a complete declaration for the common case. Everything has a default:

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | `origin(iframe.url)` + `/valu/v1` | Where your API lives. Declare it only if it is somewhere else. For an app Valu Guru built, this is the **gateway address** itself (`…/api/apps/v1/{workspace}/your-app-id`) — where the function behind it runs is recorded on the server and published nowhere. |
| `spec` | `/openapi.json` | Your OpenAPI document — the second link. A path under `baseUrl`, or an absolute URL when the description is served somewhere else; an absolute value is taken as given, never joined onto the base. Never an address on the Valu Guru host: the document served there is produced by reading yours, so naming it is a loop and it is refused. An app Valu Guru built always carries both this and `baseUrl` explicitly. |
| `scopes` | `[]` | What you offer. A caller can only be granted a scope you declared. |
| `callers` | `["*"]` | Who may call you. Replace with explicit entries to narrow it: an application id admits that app's backend, `host:<hostname>` (e.g. `host:wallet-ws-4fc02391.valuguru.app` — a workspace app is served from a host of its own, `{slug}-{workspace}.valuguru.app`) admits pages served from that host through the trusted-host door. |
| `availability` | both | `["ai", "developer"]` — whether AI agents, other applications (and pages), or both may call. |
| `userContext` | `"optional"` | `"required"` refuses calls with no acting user; `"none"` says you never use one. |
| `direct` | `false` | Whether you also accept calls straight at your own origin, bypassing the gateway. |
| `docsUrl`, `contact` | — | Shown to developers browsing your app in the Portal. |

Then save a version and submit it for review, the same as any manifest change.
Because your base URL is part of the manifest, **repointing your API at a new
host goes through review** — which is also what stops anyone else repointing it.

---

## 6. Errors

One envelope, one vocabulary, shared with every other REST surface on the
platform:

```json
{ "error": { "code": "validation_failed", "message": "`title` must be a non-empty string" } }
```

| Code | HTTP | Use it for |
|---|---|---|
| `auth_required` | 401 | The token is missing, malformed, expired or unverifiable. |
| `forbidden` | 403 | Verified, but not allowed — missing scope, no acting user, not your data. |
| `not_found` | 404 | No such thing. |
| `validation_failed` | 422 | Malformed request: bad shape, missing field, bad enum. |
| `rate_limited` | 429 | Your own limit, if you have one. Send `retry-after`. |
| `internal_error` | 500 | Something broke. A fixed message — log the real one. |

Never return a raw database error. `message` is read by a developer and,
increasingly, by a model deciding what to do next.

---

## 7. Test It

Before you publish, prove the two halves separately.

**The API, without the platform.** Mint yourself a token with a local key pair,
point `VALU_ISSUER` at a local JWKS, and curl your own endpoints. Every JWT
library can do this in ten lines; the token your app verifies in production is
not special.

**The declaration, with the platform.** The Developer Portal probes your
descriptor when you save the manifest and reports what it saw: whether the URL
answered, whether the document parsed, which operations it found, and which
scopes they name. It also tells you what it *cannot* determine from a browser —
believe that part too.

Then publish, and check your app appears in `list-application-apis` from another
app in the same network.

---

## 8. The Rules That Bite

- **Scope by network, always.** `networkId` is in every token. The same app in
  two networks is two separate worlds, and a query that forgets this leaks
  across the line that the platform is most careful about.
- **`act.sub` is optional and its absence is meaningful.** No acting user means
  a machine called you — an agent, a job. If your endpoints only make sense for
  a person, declare `userContext: "required"` and let the gateway refuse them
  before they reach you.
- **A caller's app id is not a permission.** `sub` tells you which app is
  calling. It does not tell you that app may see this user's data. Authorize on
  the scope and the acting user, then decide.
- **Do not verify tokens in the browser.** Verification is a backend job. A
  browser-side check proves nothing to anyone.
- **Your API is versioned by your app's version.** The gateway resolves your
  *released* manifest on every call, so rolling a release back rolls your API
  back with it.

---

## Quick Reference

| Thing | Where |
|---|---|
| Your API | `https://your-app.com/valu/v1/…` |
| Your OpenAPI document | `{baseUrl}/openapi.json` |
| Your health check | `{baseUrl}/health` |
| Your descriptor (optional) | `https://your-app.com/.well-known/valu-app.json` |
| What callers use | `https://<valu-guru-host>/api/apps/v1/{yourAddress}/…` — your id, or `{workspace}/{id}` for an app Valu Guru built (§1) |
| Keys you verify against | `{ISSUER}/.well-known/jwks.json` |
| Token claims | `iss`, `sub` (caller app), `aud` (you), `scope`, `net`, `act.sub` (user), `exp` (≤5 min) |
