# Valu's privacy audit — methodology

Every app that Valu builds and hosts (a Workspaces project) is checked for privacy on **every publish**. Every app in Valu shows the result as a shield next to its name.

| Shield | Means |
|---|---|
| Green, `shield-check` | **"Your privacy is safe — checked by Valu".** Every check passed, and the AI reviewer recommended the shield. |
| Grey, `shield-slash` | Something did not pass, the code is still being checked, or Valu cannot check this app. The shield's page says which and why. |
| Green, `shield-halved` | **"Partner app — trusted by Valu".** Valu did not check this app's code. A Valu admin vouches for its maker, and the page says who decided that, when and why. |

This document describes what the checks look at, how to repeat them, and what they cannot prove. It is versioned with the rules: `EGRESS_RULES_VERSION` in `src/scan/detectEgress.js`, currently **1**. Every audit records the version of each check it ran.

## What "private" means

"Outside" means anywhere other than **the person's own device** and **Valu itself**. An app with a green shield:

- **Talks only to Valu.** Inside Valu Social that means valu-api's `postMessage` to the parent. At its own address it means the valu-api host and the Valu sign-in. The addresses that count as Valu are listed in `VALU_ORIGINS` (`src/scan/valuOrigins.js`), each with the reason it is there, plus the app's own site.
- **Keeps data only on the device or in Valu:**
  - in browser storage;
  - in the person's Valu account;
  - in the project's own database and file storage, which Valu hosts. The app's developer can read that database, and the checklist names its tables.
- **Sends inside Valu only when the person does it.** This covers a chat message, an invite or a post.
- **Has server functions that call nothing outside Valu.**

An app is not private if it:

- sends anything to another address;
- loads scripts or styles from elsewhere;
- includes an analytics package;
- opens peer-to-peer connections;
- navigates away with data in the address;
- uses Valu's onward channels:
  - the AI-provider proxy (`/proxy/<provider>/`);
  - another app's API (`/api/apps/v1/`);
  - the `Http.*` functions.

## The checks

An audit is a list of checks. Each check has an id and a version, and new checks are added as new modules. Version 1 runs three.

### 1. `build`: the bytes

- **`build.hashed`.** The sha256 of every uploaded file, plus a tree hash over `path<TAB>sha256` lines sorted by path.
- **`build.served`.** After the upload, Valu fetches every HTML file of the live site. It must hash the same as the uploaded copy.

### 2. `egress-scan`: the deterministic rules

`detectEgress` reads two sets of files:

- **the source.** These are the repository's tracked files under 1 MB with a code extension, edge functions included.
- **the built files.** In bundles, only literal addresses are read. Minified code calls `fetch(e)` everywhere, and a URL inside an error message is not a call.

There is no parser. Comments are blanked out first, and TypeScript, JSX, Vue, Svelte, HTML and CSS are read alike.

| Rule | Result | Reports |
|---|---|---|
| `egress.external-url` | fail | `fetch`, XHR `open` (any method), `WebSocket`, `EventSource`, `sendBeacon`, `import()` or `import … from`, HTTP libraries (`axios`, `ky`, `got`, `superagent`, `ofetch`, jQuery `$.get` / `$.post` / `$.getJSON` / `$.ajax`), `.src =`, `setAttribute('src', …)`, or a tag's `src` / `href` (quoted or not), with a literal address outside Valu |
| `egress.third-party-script` | fail | a `<script>`, stylesheet or preload from another origin |
| `egress.navigation` | fail / info | `window.open`, `location`, `<a href>` or `<form action>` to an outside address. It fails when the address carries data (a query built from a variable) or is a form. A plain link is info. |
| `egress.webrtc` | fail | `new RTCPeerConnection`, `createDataChannel` |
| `egress.worker` | concern | `serviceWorker.register`, `new Worker`, `new SharedWorker` |
| `egress.prefetch` | fail | `dns-prefetch`, `preconnect`, `prefetch` or `prerender` to another origin |
| `egress.dynamic` | concern | a request or navigation whose address is decided at run time; `eval`; `new Function` |
| `egress.url-literal` | concern | any other literal outside address in the source that no rule above explained: an aliased `fetch`, a config object's `url:`, a library the rules do not know. XML and schema namespaces are skipped. |
| `valu.onward` | fail | `Http.*` (`http:read`, `http:write`); any literal naming `/proxy/<provider>/` or `/api/apps/v1/`; `callValuApp` in a server function |
| `server.egress` | fail | an edge function (`supabase/functions/`) requesting an outside address; `Deno.connect` is a concern |
| `deps.telemetry` | fail | a package from `TELEMETRY_PACKAGES` in `package.json`, or anywhere in `package-lock.json`, `yarn.lock` or `pnpm-lock.yaml` |

The scan also produces three lists that never fail:

- the storage the app uses, on the device and in Valu;
- the sends that reach other people inside Valu (`textchat:write`, `rooms:write`, `groups:write`, `events:write`, `users:write`, `commerce:write`);
- the project's tables, read from `db/migrations/*.sql`.

### 3. `ai-review`: the reviewer

A Claude Code run reads a read-only checkout of the audited commit.

- **Inputs.** It gets a fixed prompt, kept in valu-guru-server (`src/privacy-audit/ai-prompt.ts`), together with the findings above. Each audit stores the prompt's sha256, the model and the raw answer.
- **Questions it answers:**
  - Does each send to other people fire only on an explicit action by the person?
  - Where can each run-time address actually go?
  - Does anything else look like data leaving, or like hidden code?
- **Recommendation.** It recommends **grant** or **withhold**, with reasons.
- **Robustness.**
  - Its model is the `privacy.review` role on Valu Guru's Models page. Its key comes the same way as every coding run's key: the publisher's own coding credential, else Valu's, else the network's. A key decides who pays, not what the reviewer says.
  - It reads a throwaway checkout from which every `CLAUDE.md`, `.claude/` folder and `.mcp.json` has been removed, and loads none of the repository's settings.
  - It may only read files: no shell, no edits, no network.
  - Text in the repository addressed to the reviewer is treated as data.
- **Every finding must be explained.** Each `valu.sends-to-others`, `egress.dynamic`, `egress.worker` and `egress.url-literal` finding needs an answer. One the reviewer did not explain becomes a concern of its own. Any concern the reviewer leaves open holds the shield grey, whatever it recommended.

## The verdict

1. **Checking.** While any check is running, the shield is grey: "Being checked".
2. **Error.** If a check could not run, the shield is grey, with the reason.
3. **Failed.** Any `fail`, an open concern from the AI review, or an AI recommendation to withhold gives a grey shield. The reasons list each of them and the AI's reasons.
4. **Passed.** Otherwise the shield is green. The reasons list every check that passed and the AI's reasons for granting.

A Valu admin may change a verdict in either direction, with a reason. It is never hidden: the page shows first that an admin changed the system's decision, who did it, when and why. The system's own verdict stays below it. An admin change covers one audit, and the next publish is judged by the system again.

**The shield always shows the audit of the code people run now**, which is the latest publish. Earlier results stay in the app's version history.

## Repeating a check

The deterministic results can be repeated by anyone with the repository:

```bash
git clone <the app's repository> app && cd app && git checkout <commit_sha from the audit>
npx --package=@arkeytyp/valu-api@<scanner_version from the audit> valu-privacy-scan . --site-origin <the app's origin>
```

For the source files, the output's `findings` match the audit's `egress-scan` items. The built files are recorded by hash (`build_sha256`). Rebuilding from the commit may not give identical bytes, because the AI worker built them.

Each finished audit is signed with Valu's Ed25519 key over the canonical JSON of its public form: keys sorted, the signature removed, no source lines, and no raw AI answer (only its sha256). The public key is served at `/privacy/key` on the Valu Guru server, and each audit's JSON at `/privacy/audits/<id>.json`.

## What this cannot prove

- **Nothing blocks a request while the app runs.** The shield rests on reading the code. An address built at run time, code fetched later, or deliberately hidden code can get past the rules and the reviewer. Such calls are flagged as concerns when they can be seen, but not every one can be seen.
- **Messages to the parent frame.** Inside Valu the parent is Valu Social. At the app's own address, a page that frames the app could receive what the app posts to its parent.
- **Data handed to Valu.** "Safe" means "doesn't leave Valu", not "Valu can't see it". The developer can read the project's own tables.
- **Data the person sends knowingly.** A chat message they write, for example, can contain anything.
- **Side channels** (timing, resource sizes), and browser or extension bugs.
- **The reviewer.** It can miss things or invent them. Its recommendation is shown with its reasons, and an admin can correct it openly.
