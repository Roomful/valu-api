// ===========================================================================
// Measure this package against its two consumers.
//
//   node scripts/measure-consumers.mjs
//   node scripts/measure-consumers.mjs --app ../valusocial-web --server ../valu-guru-server
//
// docs/transition.md is a report about THREE repositories, so it cannot be
// generated the way docs/parity.md is: two of the three are not here at build
// time, and a doc that silently stops being true is worse than one dated to
// the commits it was measured at. This script re-measures it on demand and
// prints what changed, so the report can be checked rather than believed.
//
// Nothing is written. Read the numbers, or diff them against the report.
// ===========================================================================
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { SERVICE_DESCRIPTORS } from '../src/services/descriptors.js';
import { serviceRegistry } from '../src/services/registry.js';
import '../src/services/impl/index.js';
import { SERVER_TOOLS, SERVER_ONLY_TOOLS } from './bindings.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

const appRepo = resolve(arg('--app', '../valusocial-web'));
const serverRepo = resolve(arg('--server', '../valu-guru-server'));

const head = (repo) => {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch { return '(not a git checkout)'; }
};

// --- the app: the manifest it declares, and what it exposes to the AI -------
const { SERVICE_MANIFESTS } = await import(
  pathToFileURL(join(appRepo, 'src/Configs/Service_Manifests.js')).href
);
const liveIntents = new Set(
  SERVICE_MANIFESTS.flatMap((s) => s.intents.map((i) => `${s.id}.${i.action}`)),
);
const aiAvailable = new Set(
  SERVICE_MANIFESTS.flatMap((s) => s.intents
    .filter((i) => (i.availability ?? []).includes('ai'))
    .map((i) => `${s.id}.${i.action}`)),
);

const snapshot = JSON.parse(readFileSync(new URL('../manifests/service-manifests.snapshot.json', import.meta.url), 'utf8'));
const snapshotIntents = new Set(snapshot.services.flatMap((s) => s.intents.map((i) => `${s.id}.${i.action}`)));

// --- the server: the tools its registry actually holds ----------------------
// The module list comes from the registry's own imports, so a new tool module
// is measured without editing this script.
const toolsDir = join(serverRepo, 'src/valu-tools');
const index = readFileSync(join(toolsDir, 'index.ts'), 'utf8');
const modules = [...index.matchAll(/from "\.\/([\w.-]+)\.js"/g)].map((m) => m[1])
  .filter((m) => readdirSync(toolsDir).includes(`${m}.ts`));

const liveTools = new Set();
for (const module of modules) {
  const src = readFileSync(join(toolsDir, `${module}.ts`), 'utf8');
  for (const m of src.matchAll(/name: "((?:service|system)__[A-Za-z0-9_]+)"/g)) liveTools.add(m[1]);
}

const snake = (action) => action.replace(/-/g, '_');
const toolNameFor = (key) => {
  const [service, action] = key.split('.');
  return `service__${service}__${snake(action)}`;
};
const claimedTools = new Set([...SERVER_TOOLS.map(toolNameFor), ...SERVER_ONLY_TOOLS]);

// --- report ----------------------------------------------------------------
const implemented = new Set(serviceRegistry.implemented());
const sdkable = SERVICE_DESCRIPTORS.filter((d) => d.binding !== 'postmessage');
const serverKeys = new Set(SERVER_TOOLS);

const line = (label, value) => console.log(`${label.padEnd(46)} ${value}`);

console.log(`\n# valu-api measured against its consumers`);
console.log(`\n  valu-api        ${head(resolve('.'))}`);
console.log(`  valusocial-web  ${head(appRepo)}  (${appRepo})`);
console.log(`  valu-guru-server ${head(serverRepo)}  (${serverRepo})`);

console.log(`\n## The manifest snapshot\n`);
line('live intents in the app', liveIntents.size);
line('intents in the vendored snapshot', snapshotIntents.size);
const addedIntents = [...liveIntents].filter((k) => !snapshotIntents.has(k));
const droppedIntents = [...snapshotIntents].filter((k) => !liveIntents.has(k));
line('declared since the snapshot', addedIntents.length ? addedIntents.join(', ') : 'none');
line('gone since the snapshot', droppedIntents.length ? droppedIntents.join(', ') : 'none');
if (addedIntents.length || droppedIntents.length) {
  console.log('\n  STALE — run `npm run sync:manifests` then `npm run build`.');
}

console.log(`\n## The server's tool registry\n`);
line('tools registered in valu-tools', liveTools.size);
line('tools this package accounts for', claimedTools.size);
const unaccounted = [...liveTools].filter((t) => !claimedTools.has(t));
const phantom = [...claimedTools].filter((t) => !liveTools.has(t));
line('registered but not accounted for', unaccounted.length ? unaccounted.join(', ') : 'none');
line('accounted for but not registered', phantom.length ? phantom.join(', ') : 'none');

console.log(`\n## Coverage\n`);
line('declared intents', SERVICE_DESCRIPTORS.length);
line('SDK-able (socket + local)', sdkable.length);
line('implemented in this package', sdkable.filter((d) => implemented.has(d.key)).length);
line('frame commands (postMessage-bound)', SERVICE_DESCRIPTORS.length - sdkable.length);
line('server tools mapped to an intent', serverKeys.size);
line('  … of those, implemented here', [...serverKeys].filter((k) => implemented.has(k)).length);
line('server tools with no declared intent', SERVER_ONLY_TOOLS.length);
line('intents the app exposes to the AI', aiAvailable.size);
line('  … SDK-able', [...aiAvailable].filter((k) => sdkable.some((d) => d.key === k)).length);
line('  … with a server tool today', [...aiAvailable].filter((k) => serverKeys.has(k)).length);
line('  … SDK-able with no server tool today', [...aiAvailable]
  .filter((k) => !serverKeys.has(k) && sdkable.some((d) => d.key === k)).length);

console.log(`\n## What the server gains, per service\n`);
console.log('| service | server tools today | implemented here | net new |');
console.log('|---|---|---|---|');
const byService = new Map();
for (const d of SERVICE_DESCRIPTORS) {
  const row = byService.get(d.service) ?? { tools: 0, impl: 0 };
  if (serverKeys.has(d.key)) row.tools++;
  if (d.binding !== 'postmessage' && implemented.has(d.key)) row.impl++;
  byService.set(d.service, row);
}
for (const [service, row] of [...byService].sort()) {
  if (row.tools === 0 && row.impl === 0) continue;
  console.log(`| ${service} | ${row.tools} | ${row.impl} | ${row.impl - row.tools > 0 ? `+${row.impl - row.tools}` : '—'} |`);
}
console.log();

const drift = addedIntents.length + droppedIntents.length + unaccounted.length + phantom.length;
if (drift) {
  console.error(`${drift} discrepancy(ies) — docs/transition.md is measured against different commits.`);
  process.exit(1);
}
console.log('No drift: docs/transition.md still describes these three checkouts.\n');
