// ===========================================================================
// The package's `exports` map, as a consumer's Node sees it.
//
// A consumer installs the package into node_modules, where `exports` decides
// which subpaths exist: the server imports a manifest JSON, the host page
// imports `src/host/*`, a TypeScript project references the declaration files by
// package path. `types/consumer`'s `paths` bypasses the map, so this is the test
// that runs the real one: the repository root symlinked in as
// `node_modules/@arkeytyp/valu-api`, and `import.meta.resolve` asked in a fresh
// Node process for each subpath. (The declarations' own resolution under
// node16/nodenext is TypeScript's; see types/consumer and the `types` entries.)
// ===========================================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const PACKAGE = '@arkeytyp/valu-api';

/** The consumer's project: a temp dir whose node_modules holds this repository as the package. */
let consumer;

before(() => {
  consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'valu-api-exports-'));
  fs.mkdirSync(path.join(consumer, 'node_modules', '@arkeytyp'), { recursive: true });
  fs.symlinkSync(ROOT, path.join(consumer, 'node_modules', PACKAGE), 'dir');
});

after(() => {
  if (consumer) fs.rmSync(consumer, { recursive: true, force: true });
});

/** `import.meta.resolve(specifier)` in a new Node process started in the consumer's project. */
function resolveFromConsumer(specifier) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', 'console.log(import.meta.resolve(process.argv[1]))', specifier],
    { cwd: consumer, encoding: 'utf8' },
  );
}

const EXPORTED = [
  [PACKAGE, 'src/ValuApi.js'],
  [`${PACKAGE}/src/host/Host.js`, 'src/host/Host.js'],
  [`${PACKAGE}/src/host/consentPage.js`, 'src/host/consentPage.js'],
  [`${PACKAGE}/manifests/service-manifests.snapshot.json`, 'manifests/service-manifests.snapshot.json'],
  [`${PACKAGE}/types/valu-api.d.ts`, 'types/valu-api.d.ts'],
  [`${PACKAGE}/types/valu-services.d.ts`, 'types/valu-services.d.ts'],
  [`${PACKAGE}/package.json`, 'package.json'],
];

for (const [specifier, file] of EXPORTED) {
  test(`${specifier} resolves to ${file}`, () => {
    const run = resolveFromConsumer(specifier);
    assert.equal(run.status, 0, run.stderr);
    const url = new URL(run.stdout.trim());
    assert.equal(url.protocol, 'file:');
    assert.equal(fs.realpathSync(fileURLToPath(url)), path.join(ROOT, file));
  });
}

test('a subpath outside the map is refused', () => {
  for (const specifier of [`${PACKAGE}/scripts/generate.mjs`, `${PACKAGE}/test/package-exports.test.js`, `${PACKAGE}/README.md`]) {
    const run = resolveFromConsumer(specifier);
    assert.notEqual(run.status, 0, `${specifier} should not resolve`);
    assert.match(run.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/, specifier);
  }
});
