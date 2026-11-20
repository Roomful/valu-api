// docs/migrating.md is the page Valu Docs publishes as /valu-api-migration.
// It must name this release and carry every replacement the package knows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BRIDGE_REPLACEMENTS } from '../src/scan/index.js';

const page = readFileSync(new URL('../docs/migrating.md', import.meta.url), 'utf8');
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the migration page installs this release', () => {
  assert.ok(page.includes(`npm install @arkeytyp/valu-api@^${version}`));
  assert.ok(page.includes(`Generated from valu-api ${version}`));
  assert.ok(!page.includes('{{'), 'a placeholder was left unfilled');
});

test('the migration page lists every typed replacement', () => {
  for (const [key, value] of Object.entries(BRIDGE_REPLACEMENTS)) {
    const [kind, name] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
    if (kind === 'direct' || kind === 'service-intent-other') continue; // the raw-postMessage table; intents listed once
    const typed = value.replace(/ \(similar, not the same\)$/, '');
    assert.ok(page.includes(`| \`${name}\` |`), `${key} missing`);
    assert.ok(page.includes(typed.replace(/\|/g, '\\|')), `${key} → ${typed} missing`);
  }
});
