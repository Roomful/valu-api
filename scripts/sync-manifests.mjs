// ===========================================================================
// Snapshot the app's SERVICE_MANIFESTS into this package.
//
//   node scripts/sync-manifests.mjs --from ../valusocial-web
//
// The manifest is the single source of truth for what a service declares
// (description, params, permissions, availability). It lives in the app repo,
// which this package must NOT depend on at build time — so we vendor a plain
// JSON snapshot here and generate everything else from that. Re-run this
// whenever the app adds or changes an intent, then `npm run build`.
// ===========================================================================
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const MANIFEST_PATH = 'src/Configs/Service_Manifests.js';
const OUT = new URL('../manifests/service-manifests.snapshot.json', import.meta.url);

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const appRepo = arg('--from', '../valusocial-web');
const manifestFile = resolve(process.cwd(), join(appRepo, MANIFEST_PATH));

const { SERVICE_MANIFESTS } = await import(pathToFileURL(manifestFile).href);

if (!Array.isArray(SERVICE_MANIFESTS) || SERVICE_MANIFESTS.length === 0) {
  throw new Error(`No SERVICE_MANIFESTS exported from ${manifestFile}`);
}

// Sort by service id, keep intents in declaration order: the diff of this file
// should read as "what changed in the manifest", not "what moved".
const services = [...SERVICE_MANIFESTS]
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((service) => ({
    id: service.id,
    title: service.title,
    description: service.description,
    source: service.source,
    intents: service.intents.map((intent) => ({
      action: intent.action,
      description: intent.description,
      availability: [...(intent.availability ?? [])],
      permissions: [...(intent.permissions ?? [])],
      params: {
        required: (intent.params?.required ?? []).map(normalizeParam),
        optional: (intent.params?.optional ?? []).map(normalizeParam),
      },
    })),
  }));

function normalizeParam(param) {
  const out = { name: param.name, type: param.type, description: param.description ?? '' };
  if (param.options) out.options = [...param.options];
  return out;
}

const intents = services.reduce((n, s) => n + s.intents.length, 0);

writeFileSync(
  OUT,
  `${JSON.stringify({ sourceFile: MANIFEST_PATH, services }, null, 2)}\n`,
  'utf8',
);

console.log(`Snapshot written: ${services.length} services, ${intents} intents`);
