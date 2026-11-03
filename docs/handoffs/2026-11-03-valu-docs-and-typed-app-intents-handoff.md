# Handoff: Valu Docs after valu-api 2, and typed app intents (2026-11-03)

## What started this

Pavlo asked whether the Valu Docs app needs updating after the move to the
valu-api package. The Valu Docs app is the `valu_docs` iframe app in Valu
Social: `docs.texpo.io`, also at `texpo.io/valu_docs/...`. Its source is the
public repo `Roomful/valu-docs` (VitePress), cloned at `/Library/Git/valu-docs`.
Pushing to `main` deploys it.

It did need updating, and that led to a bigger task: Valu Social will later
close the **intents bridge** for framed apps (`api:run-intent`,
`api:service-intent`, API pointers, console), and only `api:call` stays. So
the docs must explain intents only as valu-api functions, and the package must
offer them as functions first.

## Done: local commits, nothing pushed

| Repo / branch | Where | Commit | What |
|---|---|---|---|
| valu-api `docs/readme-create-valu-app` | worktree `/Library/Git/valu-api/.claude/worktrees/docs-readme` | 0e2297a | README leads with `createValuApp`; install from `github:Roomful/valu-api#b951fb7` (npm still has 1.1.3); Permissions and Developing Locally sections; `valu-routing.md` note; `notify_docs.yaml` uses `curl --fail-with-body` and also fires on `valu-routing.md` |
| valu-docs `docs/valu-api-2` | `/Library/Git/valu-docs` | d3898fc | sync fixed (`scripts/sync-valu-api-docs.mjs`; there is no `Roomful/valu-routing` repo); snippets (`useValu`, `useValuAuth`, sign-in), identity token, CMS (`valu.data.CMS.*`), overview rewritten; Explorer snippets use `valu.`; `vitepress build` passes |
| valu-api `feat/typed-app-intents` | worktree `/Library/Git/valu-api/.claude/worktrees/typed-app-intents` | b0bb5f9 | design: `docs/superpowers/specs/2026-11-03-typed-app-intents-design.md` |

The README examples were type-checked with `tsc --strict` against the
package's own `types/` (clean; a wrong name is caught).

**Why the live page is stale.** valu-api's `DOCS_DISPATCH_TOKEN` secret gets
401 (`Bad credentials`), so the README has not synced since 2026-09-04. The run
showed green because curl had no `-f`. **Pavlo must renew the token.**

**Merge order:** valu-api first (with a merge commit; consumers pin shas),
then valu-docs. The valu-docs branch already contains the synced copy, so
merging it alone updates the site.

## The design: typed app intents over `api:call`

Status: draft, **not approved**. Nothing is built: the brainstorming gate
holds until Pavlo approves. After that, `superpowers:writing-plans`.

In short:
- The 62 Valu Social application intents become typed functions,
  `valu.Chats.openChannel({ userId })`, generated from a new
  `application-manifests.snapshot.json`.
- Every typed intent goes over `api:call` with an `intent: {target, id}` field
  when `api:ready.valuApi.intents === true`, and over the old bridge otherwise.
- Valu Social answers through the frame server's new `intents` runner and the
  same permission gate.
- The docs Explorer's Intents and Service Intents pages become one Functions
  page, generated from valu-api's catalogue.

Pavlo's decisions (2026-11-03):
1. Expose every app intent except the internal ones: `auth.logout`, LLM
   Debug, staging Content Studio, Metaverse 2D `agent-*`.
2. Namespace by the app's title (`Chats`, `Media`, `MyCart` …). Where a
   service has the same name, the app's intents join it (`Rooms`, `Profile`,
   `Groups`).
3. Mode at the app's own address: the 2026-10-30 rule (`window` /
   `embedded-only` / `embedded-served` / `both`).
4. **Do not close the bridge now**; only prepare for it.

My calls, marked in the doc, explained to Pavlo, not objected to:
- the identity token passes the frame server's leak guard for its own
  function only;
- intents do not depend on the Workspaces app lookup;
- app intents accept `route` / `pushToHistory` but not `predefinedDock` /
  `predefinedLayout`.

**Open: Pavlo's answer needed (§10 of the spec):**
1. Keep "open any app by id" and intents to framed apps as
   `valu.Apps.open(appId, {route})` and `valu.Apps.send(appId, action, params)`?
   Or retire them?
2. Does `api:run-command` (`pushRoute` / `replaceRoute`) close too? If yes,
   add `valu.route.push/replace` and `valu.onRoute` in this work.

## Also noted, not acted on

- The docs Explorer's REST APIs page calls `Developer.*` over the bridge. The
  unmerged forbidden tier (valusocial-web `fix/valu-api-native-only`) would
  refuse it.
- Developer Portal `sdkArticles.js` pins `valu-api#f1af8f5`, while
  web/backend/skills use `b951fb7`.
- The Workspaces worker skill must learn typed app intents. Switch it on only
  once production serves them, checked by a unique marker string (spec §6).
