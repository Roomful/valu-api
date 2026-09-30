// ===========================================================================
// Generate the service catalogue from the manifest snapshot.
//
//   node scripts/generate.mjs           # write
//   node scripts/generate.mjs --check   # fail if the committed output differs
//
// One descriptor per declared function. Everything downstream — the runtime
// validator, the TypeScript types, the docs, the LLM tool definitions — is
// derived from these descriptors, so the manifest stops being documentation
// and becomes the thing that decides whether a call is allowed.
// ===========================================================================
import { readFileSync, writeFileSync } from 'node:fs';
import {
  APPLICATION_ONLY, LOCAL, SERVER_TOOLS, SERVER_ONLY_TOOLS, mutates, defaultCache,
} from './bindings.js';
import {
  VALUGURU_CHANNEL, APP_STATE_CHANNEL, RETURNS, SERVER_ONLY_RECONCILIATION, KNOWN_DELTAS,
  REQUIREMENTS,
} from './functions.js';
import {
  API_POINTER_MODULES, API_POINTER_FUNCTIONS, DUPLICATE_DECLARATIONS, pointerSummary,
} from './apiPointers.js';
import { SDK_DECLARED, SDK_DECLARED_CANDIDATES } from './extensions.js';
// The registry the SDK actually loads. Importing it is what lets the parity
// matrix report implementation status instead of asserting it.
import { serviceRegistry } from '../src/services/registry.js';
import '../src/services/impl/index.js';

const root = new URL('../', import.meta.url);
const check = process.argv.includes('--check');

const snapshot = JSON.parse(
  readFileSync(new URL('manifests/service-manifests.snapshot.json', root), 'utf8'),
);

const applicationOnly = new Set(APPLICATION_ONLY);
const local = new Set(LOCAL);
const serverTools = new Set(SERVER_TOOLS);
const valuguru = new Set(VALUGURU_CHANNEL);
const appStateChannel = new Set(APP_STATE_CHANNEL);

/**
 * WHICH connection serves a function — the only axis left, and the one a
 * handler actually needs (scripts/functions.js).
 *
 * There used to be a second axis, `binding`, whose third value was
 * `postmessage`. It is gone with the intents it described: this package
 * declares nothing it cannot run itself over a connection, so every descriptor
 * now names the connection that answers it.
 */
function channelFor(key) {
  if (local.has(key)) return 'local';
  if (valuguru.has(key)) return 'valuguru';
  if (appStateChannel.has(key)) return 'app-state';
  return 'roomful';
}

const snake = (action) => action.replace(/-/g, '_');
const camel = (action) => action.replace(/[-_](\w)/g, (_, c) => c.toUpperCase());

/**
 * One descriptor, from a service header and one of its intents.
 *
 * @param {object} service The manifest service — the SDK-declared functions
 *   reuse it rather than inventing a service of their own.
 * @param {object} intent
 * @param {'manifest'|'sdk'} declaredBy WHO says this function exists. The app's
 *   manifest declares 92; scripts/extensions.js declares the rest, and every
 *   count downstream can separate the two because this is on the descriptor.
 */
function buildDescriptor(service, intent, declaredBy) {
  const key = `${service.id}.${intent.action}`;
  const channel = channelFor(key);
  const isMutation = mutates(key, intent.action);
  return {
    key,
    service: service.id,
    action: intent.action,
    fn: snake(intent.action),
    method: camel(intent.action),
    toolName: `service__${service.id}__${snake(intent.action)}`,
    serviceTitle: service.title,
    serviceDescription: service.description,
    source: service.source,
    description: intent.description,
    availability: intent.availability,
    permissions: intent.permissions,
    // No manifest intent declares permissions today, so the scope a caller
    // needs is derived: one read scope and one write scope per service.
    scopes: [`${service.id.toLowerCase()}:${isMutation ? 'write' : 'read'}`],
    mutates: isMutation,
    cache: defaultCache(key, isMutation, intent.params, channel),
    channel,
    returns: RETURNS[key] ?? { type: 'unknown', description: '' },
    params: intent.params,
    declaredBy,
    implementedBy: serverTools.has(key) ? `service__${service.id}__${snake(intent.action)}` : null,
  };
}

// The catalogue is what this package can RUN. An intent only the Valu Social
// application can serve gets no descriptor at all — an iframe application asks
// for it by name over the bridge, and the application's own registry is the
// authority for what those names are (docs/api-pointers.md).
const descriptors = [];
const applicationOnlyIntents = [];
for (const service of snapshot.services) {
  for (const intent of service.intents) {
    const key = `${service.id}.${intent.action}`;
    if (applicationOnly.has(key)) {
      applicationOnlyIntents.push({ key, service: service.id, ...intent });
      continue;
    }
    descriptors.push(buildDescriptor(service, intent, 'manifest'));
  }
}

// A name on the exclusion list that the manifest no longer declares is a stale
// decision, and a silent one: the generator would simply never exclude it.
const excludedFound = new Set(applicationOnlyIntents.map((i) => i.key));
for (const key of applicationOnly) {
  if (!excludedFound.has(key)) {
    throw new Error(`bindings.js excludes ${key}, which the manifest no longer declares — drop it from APPLICATION_ONLY`);
  }
}
applicationOnlyIntents.sort((a, b) => a.key.localeCompare(b.key));

// The functions this package declares itself (scripts/extensions.js). They are
// service functions in every respect that matters at runtime — the only thing
// that separates them is `declaredBy`, and the only thing that separates them
// HERE is that the service header has to be borrowed from the manifest, which
// is also what stops an extension inventing a service.
const declaredKeysFromManifest = new Set(descriptors.map((d) => d.key));
for (const extension of SDK_DECLARED) {
  const service = snapshot.services.find((s) => s.id === extension.service);
  if (!service) {
    throw new Error(`extensions.js declares ${extension.service}.${extension.intent.action} on a service the manifest does not have`);
  }
  const key = `${extension.service}.${extension.intent.action}`;
  if (declaredKeysFromManifest.has(key)) {
    throw new Error(`extensions.js declares ${key}, which the manifest now declares too — drop the extension`);
  }
  descriptors.push(buildDescriptor(service, extension.intent, 'sdk'));
}

descriptors.sort((a, b) => a.key.localeCompare(b.key));

/** Counts that keep "what the app declares" and "what the SDK offers" apart. */
const declaredCount = descriptors.filter((d) => d.declaredBy === 'manifest').length;
const sdkDeclaredCount = descriptors.filter((d) => d.declaredBy === 'sdk').length;

// --- src/services/catalog.generated.js -------------------------------------
const banner = `// GENERATED by scripts/generate.mjs from manifests/service-manifests.snapshot.json.
// Do not edit by hand: run \`npm run build\`. The decisions that are not in the
// manifest (which connection serves it, mutates, cache) come from
// scripts/bindings.js — including which declared intents are NOT here because
// only the Valu Social application can serve them.
`;

const catalogJs = `${banner}
/** @typedef {import('./descriptors.js').ServiceDescriptor} ServiceDescriptor */

/** @type {ServiceDescriptor[]} */
export const SERVICE_DESCRIPTORS = ${JSON.stringify(descriptors, null, 2)};

/** Declared intents only the Valu Social application can serve — asked for by
 * name over the postMessage bridge, never functions of this package. */
export const APPLICATION_ONLY_INTENTS = ${JSON.stringify(applicationOnlyIntents.map((i) => i.key), null, 2)};

/** Server tools that implement no declared intent. */
export const SERVER_ONLY_TOOLS = ${JSON.stringify(SERVER_ONLY_TOOLS, null, 2)};

/** Phase 2b — what happens to each of them, and why (scripts/functions.js). */
export const SERVER_ONLY_RECONCILIATION = ${JSON.stringify(SERVER_ONLY_RECONCILIATION, null, 2)};
`;

// --- types/valu-services.d.ts ----------------------------------------------
const tsType = (type) => ({
  string: 'string', number: 'number', boolean: 'boolean', object: 'Record<string, any>',
  array: 'any[]', 'string[]': 'string[]', 'object[]': 'Record<string, any>[]',
  FileList: 'FileList',
}[type] ?? 'any');

const paramType = (param) =>
  param.options ? param.options.map((o) => JSON.stringify(o)).join(' | ') : tsType(param.type);

const jsdoc = (indent, lines) =>
  `${indent}/**\n${lines.filter(Boolean).map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */`;

const byService = new Map();
for (const d of descriptors) {
  if (!byService.has(d.service)) byService.set(d.service, []);
  byService.get(d.service).push(d);
}

// Every descriptor is a service function now — the catalogue holds nothing
// else — so this is the same map as `byService`, kept separate only because
// the docs below still ask both questions.
const serviceByService = new Map();
for (const d of descriptors) {
  if (!serviceByService.has(d.service)) serviceByService.set(d.service, []);
  serviceByService.get(d.service).push(d);
}

let dts = `${banner}
// Typed surface of every declared Valu service function.

// The package's hand-written declarations are an AMBIENT module, so this
// names the package rather than the file: both are in the same program
// (\`npm run typecheck\`), and a relative import of an ambient module does not
// resolve.
import type { ValuAck } from '@arkeytyp/valu-api';

/** Which connection answers a function. There is no 'postmessage': this
 * package declares only what it can run itself. */
export type ServiceChannel = 'roomful' | 'valuguru' | 'app-state' | 'local';
export type IntentAvailability = 'ai' | 'developer';

`;

/** The declared return shape, as TypeScript. `object` is an open record. */
const returnType = (returns) => (returns?.type && returns.type !== 'unknown'
  ? returns.type.replace(/\bobject\b/g, 'Record<string, any>')
  : 'any');

const resultName = (d) => `${d.service}${d.method[0].toUpperCase()}${d.method.slice(1)}Result`;

for (const [service, fns] of serviceByService) {
  for (const d of fns) {
    const all = [...d.params.required.map((p) => [p, true]), ...d.params.optional.map((p) => [p, false])];
    dts += `${jsdoc('', [`${d.key} — ${d.returns.description || d.description}`])}\n`;
    dts += `export type ${resultName(d)} = ${returnType(d.returns)};\n\n`;
    dts += `${jsdoc('', [`${d.key} — ${d.description}`])}\n`;
    dts += `export interface ${service}${d.method[0].toUpperCase()}${d.method.slice(1)}Params {\n`;
    for (const [p, required] of all) {
      dts += `${jsdoc('  ', [p.description])}\n`;
      dts += `  ${p.name}${required ? '' : '?'}: ${paramType(p)};\n`;
    }
    dts += `}\n\n`;
  }
}

dts += `/** Every service, with each SERVICE function as a method. */\nexport interface ValuServices {\n`;
for (const [service, fns] of serviceByService) {
  dts += `${jsdoc('  ', [fns[0].serviceDescription])}\n  ${service}: {\n`;
  for (const d of fns) {
    const hasParams = d.params.required.length + d.params.optional.length > 0;
    const required = d.params.required.length > 0;
    const paramsName = `${service}${d.method[0].toUpperCase()}${d.method.slice(1)}Params`;
    dts += `${jsdoc('    ', [d.description, `@channel ${d.channel}`, `@scope ${d.scopes.join(' ')}`])}\n`;
    dts += `    ${d.method}(${hasParams ? `params${required ? '' : '?'}: ${paramsName}` : ''}): Promise<ValuAck<${resultName(d)}>>;\n`;
  }
  dts += `  };\n`;
}
dts += `}\n\nexport type ServiceName = keyof ValuServices;\n`;

// The same tree with the envelope taken off. `client.call` answers an ack and
// `client.invoke` throws; the function surface offers both, and this is the
// type of the second one — derived, so a function cannot appear on one tree
// and not the other.
dts += `
/** \`ValuAck<T>\` off every method: what \`api.data\` returns, throwing on error. */
export type UnwrapService<S> = {
  [F in keyof S]: S[F] extends (...args: infer A) => Promise<ValuAck<infer R>>
    ? (...args: A) => Promise<R>
    : never;
};

/** Every service, with each function returning its DATA and throwing on error. */
export type ValuServicesData = { [S in keyof ValuServices]: UnwrapService<ValuServices[S]> };
`;

// Counts by channel, used by the docs below.
const counts = descriptors.reduce((acc, d) => ({ ...acc, [d.channel]: (acc[d.channel] ?? 0) + 1 }), {});

// --- docs/parity.md + docs/parity-matrix.csv --------------------------------
// THE PARITY MATRIX, generated rather than maintained. The plan shipped it as
// a spreadsheet; a spreadsheet cannot notice that a function was implemented,
// so this is built from the catalogue AND from the registry — `npm run
// check:generated` fails when the two drift, which is the only way a parity
// table stays true after the week it was written.
const implemented = new Set(serviceRegistry.implemented());

const STATUS = (d) => (implemented.has(d.key) ? 'implemented' : 'declared only');

const byChannel = counts;
const implementedCount = descriptors.filter((d) => implemented.has(d.key)).length;

let parity = `<!-- GENERATED by scripts/generate.mjs. Do not edit: run \`npm run build\`. -->
# Parity matrix

Every declared function, what serves it, and whether this package implements
it. Generated from the catalogue and from the registry the SDK actually loads,
so a function listed \`implemented\` here has a handler — the two cannot drift
without \`npm run check:generated\` failing.

| | count |
|---|---|
| functions in the catalogue | **${descriptors.length}** |
| — of them declared by the application's manifest | ${declaredCount} |
| — of them declared by this package (scripts/extensions.js) | ${sdkDeclaredCount} |
| implemented in this package | **${implementedCount}** |
| declared intents excluded (only the application can serve them) | **${applicationOnlyIntents.length}** |
| server tools with no declared intent | **${SERVER_ONLY_TOOLS.length}** |

## Channels

Every function in this catalogue is one this package runs itself, given a
connection. \`channel\` says WHICH connection — the distinction a handler needs,
and the one a caller has to satisfy before the call can work.

| channel | count | what serves it |
|---|---|---|
| \`roomful\` | ${byChannel.roomful ?? 0} | the Roomful platform socket — \`ValuSocket.emit(ns, payload)\` |
| \`valuguru\` | ${byChannel.valuguru ?? 0} | the Valu Guru server's \`data_request\` channel — \`valuguru.*\` ops |
| \`app-state\` | ${byChannel['app-state'] ?? 0} | no RPC exists; the runtime holding that state supplies it |
| \`local\` | ${byChannel.local ?? 0} | computed by the SDK |

## Functions

| service | function | channel | mutates | cache | server tool | status |
|---|---|---|---|---|---|---|
`;
for (const d of descriptors) {
  parity += `| ${d.service} | \`${d.action}\` | \`${d.channel}\` | ${d.mutates ? 'write' : 'read'} `
    + `| \`${d.cache.mode}\` | ${d.implementedBy ? `\`${d.implementedBy}\`` : '—'} | ${STATUS(d)} |\n`;
}

parity += `
## Declared, and deliberately not here

${applicationOnlyIntents.length} intents in the application's manifest get no descriptor, no method
and no tool definition. No RPC serves any of them — they open a dock, render a
picker, or read the application's own log buffer — so a function here would be
a method that fails everywhere this library is meant to run.

They are not unreachable. An iframe application asks for any intent **by name**
over the postMessage bridge, and the application's own registry (not this
snapshot) is the authority for what those names are:
[api-pointers.md](api-pointers.md).

${applicationOnlyIntents.map((i) => `- \`${i.key}\` — ${i.description}`).join('\n')}
`;

parity += `
## Server-only tools — the Phase 2b decisions

${SERVER_ONLY_TOOLS.length} tools in valu-guru-server implement no declared intent. Each one is
resolved below rather than left as a gap.

`;
for (const entry of SERVER_ONLY_RECONCILIATION) {
  parity += `### \`${entry.tool}\` — ${entry.disposition}\n\n${entry.decision}\n\n`;
  if (entry.declared.length) {
    parity += `Declared equivalent: ${entry.declared.map((k) => `\`${k}\``).join(', ')}.\n\n`;
  }
}

parity += `## Known behaviour deltas

Parity is not identical behaviour. These are the places this package knowingly
differs from the app, each one a decision rather than an oversight.

`;
for (const entry of KNOWN_DELTAS) {
  parity += `### \`${entry.key}\`\n\n${entry.delta}\n\n`;
}

// The same table as data, for anything that would rather diff than read.
let csv = 'service,function,channel,mutates,cache,scopes,server_tool,status,returns\n';
for (const d of descriptors) {
  const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
  csv += [
    d.service, d.action, d.channel, d.mutates ? 'write' : 'read', d.cache.mode,
    d.scopes.join(' '), d.implementedBy ?? '', STATUS(d), d.returns.type,
  ].map(cell).join(',') + '\n';
}

// --- docs/socket-functions.md ----------------------------------------------
// THE reference: every function in the catalogue, the feature it provides, the
// connection that answers it, what the runtime must supply, and its params.
//
// It used to be three documents — services.md (what the platform declares),
// server-functions.md (what a runtime must supply) and socket-functions.md
// (what you can do over a socket). The catalogue no longer holds anything but
// socket functions, so all three were describing the same list from three
// angles, and a reader had to hold the difference between them in their head.
const implementedFns = descriptors.filter((d) => implemented.has(d.key));
const onSocket = implementedFns.filter((d) => d.channel === 'roomful' || d.channel === 'valuguru');
const appStateFns = descriptors.filter((d) => d.channel === 'app-state');
const localFns = descriptors.filter((d) => d.channel === 'local');
const roomfulCount = descriptors.filter((d) => d.channel === 'roomful').length;
const guruCount = descriptors.filter((d) => d.channel === 'valuguru').length;

const SOCKET_LABEL = {
  roomful: 'Roomful socket', valuguru: 'Valu Guru socket',
  'app-state': 'application state', local: 'local',
};

/** `{roomId, networkId?}` — the call's shape at a glance. */
const paramList = (d) => {
  const all = [
    ...d.params.required.map((p) => p.name),
    ...d.params.optional.map((p) => `${p.name}?`),
  ];
  return all.length ? `\`{${all.join(', ')}}\`` : '`()`';
};

const signature = (d) => {
  const all = [
    ...d.params.required.map((p) => p.name),
    ...d.params.optional.map((p) => `${p.name}?`),
  ];
  return all.length ? `{${all.join(', ')}}` : '—';
};

/** The runtime requirements of a function: its channel, plus anything extra. */
const requirementsOf = (d) => {
  const channelReq = { roomful: '`socket`', valuguru: '`guru`', 'app-state': null, local: null }[d.channel];
  const extra = (REQUIREMENTS[d.key] ?? []).map((r) => `\`${r}\``);
  return [channelReq, ...extra].filter(Boolean).join(', ') || '—';
};

/** What the cache does to this function, in the words a caller cares about. */
const cacheNote = (d) => {
  const { mode, ttlMs } = d.cache;
  if (mode === 'read-through') return `cached ${Math.round((ttlMs ?? 0) / 1000)}s`;
  if (mode === 'seeded') return 'cache seeded by push';
  if (d.mutates) return 'invalidates the cache';
  return 'not cached';
};

/**
 * What this function needs BEYOND its connection, if anything.
 *
 * `VerusWallet.transfer` is the reason this is here: it emits on the Roomful
 * socket, so it is listed under one, but it cannot start without the wallet
 * identity only the application's own state can resolve. A socket-only reader
 * would not guess that, and test/server-functions.test.js sweeps these tags
 * against the handlers so the column cannot rot.
 */
const alsoNeeds = (d) => {
  const extra = (REQUIREMENTS[d.key] ?? []).filter((r) => r !== 'fetch' || d.channel !== 'local');
  if (!extra.length) return '';
  const label = (r) => (r.endsWith('?') ? `\`${r.slice(0, -1)}\` (optional)` : `\`${r}\``);
  return ` **also needs ${extra.map(label).join(', ')}.**`;
};

/** One bullet: the function, its shape, and the feature it provides. */
const featureLine = (d) => {
  const answers = !d.returns.description ? ''
    : d.returns.type === 'void' ? ` ${d.returns.description}`
      : ` Answers ${d.returns.description.charAt(0).toLowerCase()}${d.returns.description.slice(1)}`;
  const unimplemented = implemented.has(d.key) ? '' : ' *(declared, not implemented yet — answers 501)*';
  return `- **\`${d.key}\`** ${paramList(d)} → \`${d.returns.type}\`\n`
    + `  ${d.description}${answers}${alsoNeeds(d)} *(${cacheNote(d)}; scope \`${d.scopes.join(' ')}\`)*${unimplemented}\n`;
};

/** The params of one function, as a table — types, requiredness, descriptions. */
const paramTable = (d) => {
  const all = [...d.params.required.map((p) => [p, true]), ...d.params.optional.map((p) => [p, false])];
  if (!all.length) return '';
  let table = `| param | type | required | description |\n|---|---|---|---|\n`;
  for (const [p, required] of all) {
    const type = p.options ? p.options.map((o) => `\`${o}\``).join(' \\| ') : `\`${p.type}\``;
    table += `| \`${p.name}\` | ${type} | ${required ? 'yes' : 'no'} | ${p.description.replace(/\|/g, '\\|')} |\n`;
  }
  return table;
};

const docByService = new Map();
for (const d of descriptors) {
  if (!docByService.has(d.service)) docByService.set(d.service, []);
  docByService.get(d.service).push(d);
}

let socketMd = `<!-- GENERATED by scripts/generate.mjs. Do not edit: run \`npm run build\`. -->
# Socket functions

The ${descriptors.length} functions this package answers **itself**, given a connection — and
the feature each one provides.

That is the whole of this package's function surface. A socket points *away*
from the browser: it is a connection this library holds to a server and speaks
itself, so the same call runs in the Valu Social application, in a Valu Guru
server agent, in a Node script, and in an iframe application that has one. No
Valu Social application is needed at any point.

${roomfulCount} run on the **Roomful socket** and ${guruCount} on the **Valu Guru socket**.
${appStateFns.length} read state a socket cannot produce and ${localFns.length} need no connection at
all; both are below.

Where to read what:

| doc | question it answers |
|---|---|
| **this file** | what can I do, and what does each function need? |
| [service-api.md](service-api.md) | the whole tree as calls, one line each |
| [parity.md](parity.md) | what is implemented today, and what is knowingly different |
| [api-pointers.md](api-pointers.md) | the postMessage bridge: any application intent, by name |
| [callbacks-policy.md](callbacks-policy.md) | timeouts, retries, error codes, what a reconnect does |

## The two sockets

| socket | functions | what it is | how you supply it | without it |
|---|---|---|---|---|
| Roomful | ${roomfulCount} | the platform's own WebSocket — every RPC the app's services already use | \`createValuServices({ socket })\` | \`SocketTransport\` refuses to construct |
| Valu Guru | ${guruCount} | the Valu Guru server's \`data_request\` channel — a different server, envelope and auth | \`createValuServices({ socket, guru })\` | those ${guruCount} answer 503 **by name**, before the handler runs |

Both are the same contract to a handler
([\`ValuSocket\`](../src/socket/ValuSocket.js)), and both come in a browser and
a headless flavour, so a function written once runs in either runtime. What the
socket carries is the platform's own RPC, unchanged: \`Users.get\` emits
\`social:getUsersSimpleInfo\`, \`Rooms.get-permissions\` emits
\`room:permissions\` — the same messages the Valu Social app emits for the same
data.

A Valu Guru server must NOT route the ${guruCount} \`valuguru\` functions through this
package: that server *is* the other end of that channel, and calling them there
is a server talking to itself over its own socket.

## What a runtime must supply

| requirement | what it is | what happens without it |
|---|---|---|
| \`socket\` | a [\`ValuSocket\`](../src/socket/ValuSocket.js) — \`NodeSocketAdapter\` over a \`RoomfulConnectionManager\`, or \`BrowserSocketAdapter\` over the app's WebSocket service | \`SocketTransport\` refuses to construct |
| \`guru\` | a [\`ValuGuruSocket\`](../src/socket/ValuGuruSocket.js) — the Valu Guru server's \`data_request\` channel | the ${guruCount} \`valuguru\` functions answer 503 **by name**, before the handler runs |
| \`appState\` | an [\`AppState\`](../src/app-state/AppState.js): state no RPC can produce, held by the Valu Social application or by your own runtime | the function answers 501 naming the capability it wanted |
| \`applicationId\` | WHICH application is calling, stamped by the runtime and never read from a caller's params | the functions scoped to an app answer 403 |
| \`config\` | \`{ webBase, apiGate }\` — the origins a resource URL is built on | defaults are used; a share link may point at the wrong deployment |
| \`fetch\` | outbound HTTP, for the local HTTP functions and the upload pipeline's bucket PUT | \`globalThis.fetch\`, if the runtime has one |

## ${appStateFns.length} functions no socket can answer

These are declared like any other intent, but there is no RPC behind them: the
answer is in the memory of whatever is running the application. A runtime that
holds it passes it in as \`{ appState }\`; one that does not gets an ack naming
the capability it wanted, never a guess.

| function | the state it reads | \`appState\` capability |
|---|---|---|
| \`AiGuru.get-chat-history\` | the session's in-memory message list | \`getChatHistory\` |
| \`AiGuru.get-agent-history\` | an agent's in-memory message list | \`getAgentHistory\` |
| \`Developer.list-applications\` | the Developer Portal's application list | \`listDeveloperApplications\` |
| \`Developer.create-application\` | the same store, plus the app registry | \`createDeveloperApplication\` |
| \`VerusWallet.get-balance\` | the balance the store cached off a push | \`getAgentWallet\` |

## ${localFns.length} functions with no connection at all

Answered inside the SDK from configuration, the clock or \`fetch\`:
${localFns.map((d) => `\`${d.key}\``).join(', ')}.

## Errors

Every function resolves an ack — \`{data}\` or \`{error}\` — and never throws;
\`invoke\` is the throwing wrapper. The codes a caller must handle are in
[callbacks-policy.md](callbacks-policy.md); the ones specific to a missing
runtime piece are 503 (no such channel), 501 (no \`appState\` capability, or a
declared function with no handler yet) and 403 (no application identity).

## The functions, by service

Read functions first, then writes — the split matters, because a write bypasses
the cache on the way out and invalidates it on the way back, **including when
it fails** (a timed-out write may still have landed).

A few of them want something past the connection — an \`applicationId\` the
runtime stamps, a \`config\` origin, a \`fetch\`, or a piece of \`appState\`. Those
say so in bold, because without it the call answers 403 or 501 rather than
working partially.

`;

for (const [service, fns] of [...docByService].sort()) {
  const channels = [...new Set(fns.map((d) => SOCKET_LABEL[d.channel]))].join(' + ');
  socketMd += `### ${service} · ${fns.length} function${fns.length === 1 ? '' : 's'} · ${channels}\n\n`;
  socketMd += `${fns[0].serviceDescription}\n\nSource: \`${fns[0].source}\`\n\n`;
  const missing = applicationOnlyIntents.filter((i) => i.service === service);
  if (missing.length) {
    socketMd += `*${missing.length} more \`${service}\` intent${missing.length === 1 ? '' : 's'} `
      + `(${missing.map((i) => `\`${i.key.split('.')[1]}\``).join(', ')}) `
      + `${missing.length === 1 ? 'is' : 'are'} served only by the Valu Social application — `
      + `ask for ${missing.length === 1 ? 'it' : 'them'} by name over the bridge `
      + `([api-pointers.md](api-pointers.md)).*\n\n`;
  }
  socketMd += `| function | params | returns | mode | requires | cache |\n|---|---|---|---|---|---|\n`;
  for (const d of fns) {
    socketMd += `| \`${d.key}\` | ${signature(d)} | \`${d.returns.type}\` `
      + `| ${d.mutates ? 'write' : 'read'} | ${requirementsOf(d)} | \`${d.cache.mode}\` |\n`;
  }
  socketMd += `\n`;

  const reads = fns.filter((d) => !d.mutates);
  const writes = fns.filter((d) => d.mutates);
  if (reads.length) socketMd += `**Reads**\n\n${reads.map(featureLine).join('')}\n`;
  if (writes.length) socketMd += `**Writes**\n\n${writes.map(featureLine).join('')}\n`;

  const withParams = fns.filter((d) => d.params.required.length + d.params.optional.length > 0);
  if (withParams.length) {
    socketMd += `<details>\n<summary>Parameters — ${withParams.length} of these take some</summary>\n\n`;
    for (const d of withParams) {
      socketMd += `\`${d.key}\`\n\n${paramTable(d)}\n`;
    }
    socketMd += `</details>\n\n`;
  }
}

socketMd += `## Calling them

\`\`\`javascript
import { createValuServices, NodeSocketAdapter } from '@arkeytyp/valu-api';

const valu = createValuServices({
  socket: new NodeSocketAdapter({ connection }), // the Roomful socket — required
  guru,                                          // the Valu Guru socket — for the ${guruCount} above
  appState,                                      // state no socket can produce
  applicationId,                                 // WHO is calling; the runtime stamps it
  config: { webBase, apiGate },                  // origins for the URL builders
  fetchImpl: fetch,
});

const ack  = await valu.Users.get({ userId });        // { data } | { error }
const user = await valu.data.Users.get({ userId });   // the payload, throws on error
const same = await valu.call('Users.get', { userId }); // by name, for a tool call
\`\`\`

Every function is on \`valu.<Service>.<method>\` — [service-api.md](service-api.md)
is the whole tree, one line each. A function resolves by any name the platform
already writes — \`Users.get\`, \`Users.get_user\`, \`Users.getUser\`,
\`service__Users__get\`.

${SERVER_ONLY_TOOLS.length} tools in valu-guru-server implement no declared intent and are not
functions of this package. [parity.md](parity.md) records the decision for each
one: ${SERVER_ONLY_TOOLS.map((t) => `\`${t}\``).join(', ')}.
`;

// --- docs/api-pointers.md --------------------------------------------------
// The OTHER way over the postMessage bridge, written down. This package gives API
// pointers no catalogue and no per-function method, so the only description of
// the surface is the app's source — which is why the inventory is vendored in
// scripts/apiPointers.js and checked by `npm run measure:api-pointers`.
const pointers = pointerSummary();
// A pointer may map to a service function OR to an application intent — both
// are things the application knows how to do; only one of them is a function
// of this package.
const declaredKeys = new Set([...descriptors.map((d) => d.key), ...applicationOnly]);
for (const f of API_POINTER_FUNCTIONS) {
  // A mapping to a function the catalogue does not declare is a typo, and a
  // typo here sends a reader to a function that does not exist.
  if (f.sdk && !declaredKeys.has(f.sdk)) {
    throw new Error(`api pointer ${f.module}.${f.fn} maps to unknown function ${f.sdk}`);
  }
  if (f.sdk && !f.via) throw new Error(`api pointer ${f.module}.${f.fn} names an SDK function but no 'via'`);
  if (!f.sdk && f.via) throw new Error(`api pointer ${f.module}.${f.fn} has a 'via' but no SDK function`);
}

const VIA_LABEL = {
  same: '✅ same',
  close: '⚠️ close',
};

let pointerMd = `<!-- GENERATED by scripts/generate.mjs from scripts/apiPointers.js. Do not edit: run \`npm run build\`. -->
# API pointers

The **older** way over the postMessage bridge, and the one this package
deliberately did not replace. An API pointer is a name and a version; you ask
the Valu Social application for one and then call functions on it by string:

\`\`\`javascript
const usersApi = await valuApi.getApi('users');   // → api:create-pointer
const me = await usersApi.run('current');         // → api:run
\`\`\`

There is **no per-function API** for any of this, here or anywhere: \`run\` takes
a string and an object, the application looks the string up in its own registry, and
nothing checks either side. That is the difference the service SDK makes — it
has a function per service because it *carries the implementations*, and a
pointer carries nothing but the string you passed.

What that costs, concretely:

- **No parameter validation.** A misspelled field is a successful call that
  answers nothing useful.
- **No consistent argument shape.** \`APIBridge.registerFunction\` refuses a
  function of more than one parameter, so every pointer function takes exactly
  one — but \`users.get\` takes a bare \`userId\` string while \`users.getIcon\`
  takes \`{userId, size}\`. There is no rule; you read the app's source.
- **No ack envelope.** A pointer call rejects with whatever the application threw.
  Declared functions all resolve \`{data} | {error}\`
  ([callbacks-policy.md](callbacks-policy.md)).
- **Frame only.** \`api:create-pointer\` is a postMessage message. A headless
  agent has no application to ask, so none of this exists outside an iframe.
- **No versioning discipline in practice.** Every function below is registered
  at version 1, and \`getApi(name)\` without a version binds the latest.
- **Events do not cross the bridge.** A pointer module on the application's side
  emits events (\`users\` emits \`update-user\` and
  \`update-user:following-status:\`), and \`APIPointer\` here has
  \`addEventListener\`. Nothing connects the two: the application sends no pointer
  events over the bridge (\`api:trigger\` carries \`on_route\` and nothing else),
  so a subscription from inside an iframe never fires. Those events are real only
  for callers inside the application itself.

## The inventory

${pointers.functions} functions across ${pointers.modules} modules, vendored in
[\`scripts/apiPointers.js\`](../scripts/apiPointers.js) and re-measured against a
real checkout by \`npm run measure:api-pointers\`, which exits non-zero the
moment the app adds, renames or drops one.

| | n |
|---|---|
| modules | ${pointers.modules} |
| functions | ${pointers.functions} |
| … a declared SDK function does the same work | ${pointers.same} |
| … a declared function is close but not equivalent | ${pointers.close} |
| … **no declared intent: the pointer is the only way** | ${pointers.only} |

So two thirds of this surface is not reachable through the service SDK at all,
and that is the answer to "what still relies on API pointers": theming and
resize, network switching, the modal stack, logout, chat-channel resolution,
removing a connection, the encryption seed, and the dock's loading and
link-blocking overrides.

The \`✅ same\` rows are the ones to stop using first — a declared function
covers them, with validation, caching and one failure shape, and it works
headless as well as framed.

`;

for (const m of API_POINTER_MODULES) {
  pointerMd += `### ${m.module}${m.aliases.length ? ` (also ${m.aliases.map((a) => `\`${a}\``).join(', ')})` : ''}\n\n`;
  pointerMd += `${m.summary}\n\n`;
  pointerMd += `\`getApi('${m.module}')\`${m.aliases.length ? ` — or ${m.aliases.map((a) => `\`getApi('${a}')\``).join(', ')}` : ''}`
    + ` → [\`${m.file}\`](https://github.com/Roomful/valusocial-web/blob/develop/${m.file})\n\n`;
  pointerMd += `| \`run(…)\` | its one argument | what it does | declared equivalent |\n|---|---|---|---|\n`;
  for (const f of m.functions) {
    const equivalent = f.sdk ? `${VIA_LABEL[f.via]} \`${f.sdk}\`` : '— none';
    pointerMd += `| \`${f.fn}\` | \`${f.arg}\` | ${f.does} | ${equivalent} |\n`;
  }
  pointerMd += `\n`;
  const noted = m.functions.filter((f) => f.note);
  if (noted.length) {
    for (const f of noted) pointerMd += `- \`${f.fn}\` — ${f.note}\n`;
    pointerMd += `\n`;
  }
}

// Two modules claiming one name is not hypothetical here, and it resolves
// differently for a module name than for an alias — which is the kind of thing
// a reader told "call getApi('chat')" needs to know.
const aliasOwners = new Map();
for (const m of API_POINTER_MODULES) {
  for (const a of m.aliases) {
    if (!aliasOwners.has(a)) aliasOwners.set(a, []);
    aliasOwners.get(a).push(m.module);
  }
}
const collidingAliases = [...aliasOwners].filter(([, owners]) => owners.length > 1);

pointerMd += `## Names that collide

\`${DUPLICATE_DECLARATIONS.map((d) => d.module).join('`, `')}\` is declared **twice**: once above, and again by
${DUPLICATE_DECLARATIONS.map((d) => `[\`${d.file}\`](https://github.com/Roomful/valusocial-web/blob/develop/${d.file}) with the same `
  + `${d.functions.length} functions (${d.functions.map((f) => `\`${f}\``).join(', ')})`).join(', ')}.
\`APIBridge.createAPi\` throws on a duplicate module name, so at most one of the
two is ever live; the tables above count the pair once. ${pointers.declarations} registrations,
${pointers.functions} distinct functions.

An **alias** collides silently instead — \`registerAlias\` just overwrites the
entry, so the last module to register the name owns it:
${collidingAliases.map(([a, owners]) => `\`${a}\` is registered by both \`${owners.join('` and `')}\``).join('; ')}.
Prefer the module's own name over an alias for exactly this reason.

## What this package does and does not do about them

- \`ValuApi.getApi()\` and \`APIPointer\` are **unchanged**. Phase 1 moved the
  transport out from under them — the wire messages are byte for byte what they
  were — and Phase 2 did not touch them.
- One behaviour did change, because it was broken: \`sendIntent\` never settled,
  because its \`api:run-completed\` reply was routed as if it belonged to an
  \`APIPointer\`. It resolves now.
- **Nothing in the service SDK uses a pointer.** \`ServiceClient\` speaks a
  socket; \`ValuApi.callService(intent)\` sends \`api:service-intent\`.
- There is no plan in Phases 1–2 to wrap them. A pointer function that deserves
  to be callable from an agent should be **declared as an intent** and
  implemented here; the ${pointers.only} above are the candidate list.

## Application intents: the other thing the bridge carries

A pointer is one of two name-based mechanisms on the same bridge. The other is
an **application intent** — \`{applicationId, action, params}\`, sent as
\`api:service-intent\`:

\`\`\`javascript
const api = new ValuApi();
await api.callService(new Intent('AiGuru', 'open', { applicationId: 'my-app' }));
await api.sendIntent(new Intent('chatApp', Intent.ACTION_OPEN, { roomId }));
\`\`\`

Nothing has to be declared for this to work. The name is a string, the
application resolves it against **its own runtime registry**, and an intent
registered after this package was published works exactly as well as one that
predates it. That is why this package declares no application intents: a method
per intent would be a copy of a list that moves without us.

${applicationOnlyIntents.length} intents in the manifest snapshot can ONLY be run this way — no RPC
serves them, so [socket-functions.md](socket-functions.md) has no function for
any of them:

| intent | params | what it does |
|---|---|---|
${applicationOnlyIntents.map((i) => {
  const all = [...i.params.required.map((x) => x.name), ...i.params.optional.map((x) => `${x.name}?`)];
  return `| \`${i.key}\` | ${all.length ? `\`{${all.join(', ')}}\`` : '—'} | ${i.description} |`;
}).join('\n')}

The snapshot is a snapshot, not the authority. Ask the application for anything
it registers.
`;

// --- docs/service-api.md ---------------------------------------------------
// THE FUNCTION SURFACE, as calls a reader can copy. socket-functions.md
// explains what each one is for and what it needs; this one answers "what do I
// type".
const apiSignature = (d) => {
  const required = d.params.required.map((p) => p.name);
  const optional = d.params.optional.map((p) => `${p.name}?`);
  const all = [...required, ...optional];
  if (!all.length) return '()';
  return required.length ? `({ ${all.join(', ')} })` : `({ ${all.join(', ')} }?)`;
};

const apiReturn = (d) => (d.returns?.type && d.returns.type !== 'unknown' ? d.returns.type : '?');

const CHANNEL_NOTE = {
  roomful: 'Roomful socket',
  valuguru: 'Valu Guru socket',
  'app-state': 'application state — no RPC exists',
  local: 'answered by the SDK',
};

let apiMd = `<!-- GENERATED by scripts/generate.mjs. Do not edit: run \`npm run build\`. -->
# The service API

Every service function this package offers, as the call you would write. There
are **${descriptors.length}** of them, on **${serviceByService.size}** services, and the same
${descriptors.length} are available from a Valu Social build, from the Valu Guru server, from a
Node script and from an iframe application that has a socket — that is what
makes them service functions.

\`\`\`javascript
import { createValuServices, NodeSocketAdapter } from '@arkeytyp/valu-api';

// anywhere there is a connection: the Valu Guru server, a Node agent, the app
const valu = createValuServices({ socket, guru });

const me    = await valu.data.Users.current();                  // the payload
const ack   = await valu.Users.current();                       // or the envelope
const rooms = await valu.data.Rooms.searchRooms({ query: 'design', size: 5 });
\`\`\`

\`valu.X.y()\` resolves \`{data} | {error}\` and never rejects. \`valu.data.X.y()\`
is the same call with the envelope taken off: it returns the payload and throws
\`ValuServiceError\`. \`valu.call('Users.current')\` takes the name as a string,
which is what an LLM tool call has.

What is **not** here: application intents — open a dock, expand a pane, show a
picker. Only the Valu Social application can serve those, and it is asked for
one **by name**, with nothing declared on this side:
\`api.callService(new Intent('AiGuru', 'open', {applicationId}))\`. See
[api-pointers.md](api-pointers.md).

| | |
|---|---|
| read the feature each one provides, and what it needs | [socket-functions.md](socket-functions.md) |
| who implements what today | [parity.md](parity.md) |
| the bridge: any application intent, by name | [api-pointers.md](api-pointers.md) |

`;

for (const [service, fns] of serviceByService) {
  const reads = fns.filter((d) => !d.mutates);
  const writes = fns.filter((d) => d.mutates);
  apiMd += `## ${service}\n\n${fns[0].serviceDescription}\n\n`;
  const line = (d) => {
    const marks = [CHANNEL_NOTE[d.channel]];
    if (d.declaredBy === 'sdk') marks.push('declared by this package');
    return `- \`valu.${service}.${d.method}${apiSignature(d)}\` → \`${apiReturn(d)}\`\n`
      + `  ${d.description}\n`
      + `  <sub>${marks.join(' · ')}</sub>\n`;
  };
  if (reads.length) apiMd += `**Reads**\n\n${reads.map(line).join('')}\n`;
  if (writes.length) apiMd += `**Writes**\n\n${writes.map(line).join('')}\n`;
}

apiMd += `## Names

One function, four ways to write it — the tree, and the three string forms the
platform already uses:

\`\`\`javascript
valu.Users.searchUsers({ filter: 'contacts' })
valu.call('Users.search-users', { filter: 'contacts' })   // as the manifest declares it
valu.call('Users.search_users', { filter: 'contacts' })   // as the server names its tool
valu.call('service__Users__search_users', { filter: 'contacts' })
\`\`\`

Each method also carries its own descriptor, so a runtime that builds LLM tools
out of these does not have to look one up by string:

\`\`\`javascript
valu.Users.searchUsers.toolName    // 'service__Users__search_users'
valu.Users.searchUsers.descriptor  // params, scopes, cache policy, channel
valu.toolDefinitions()             // every function, as an OpenAI-shaped tool
\`\`\`
`;

// --- write or check --------------------------------------------------------
const outputs = [
  ['src/services/catalog.generated.js', catalogJs],
  ['types/valu-services.d.ts', dts],
  ['docs/service-api.md', apiMd],
  ['docs/socket-functions.md', socketMd],
  ['docs/api-pointers.md', pointerMd],
  ['docs/parity.md', parity],
  ['docs/parity-matrix.csv', csv],
];

let stale = 0;
for (const [path, content] of outputs) {
  const url = new URL(path, root);
  if (check) {
    let current = '';
    try { current = readFileSync(url, 'utf8'); } catch { /* missing counts as stale */ }
    if (current !== content) {
      console.error(`STALE: ${path} — run \`npm run build\``);
      stale++;
    }
  } else {
    writeFileSync(url, content, 'utf8');
    console.log(`wrote ${path}`);
  }
}

if (check && stale) process.exit(1);
if (check) console.log(`generated output is up to date (${outputs.length} files)`);
if (!check) {
  console.log(
    `${descriptors.length} functions: ${counts.roomful} roomful, ${counts.valuguru} valuguru, `
    + `${counts['app-state']} app-state, ${counts.local} local `
    + `(+ ${applicationOnlyIntents.length} declared intents only the application can serve)`,
  );
}
