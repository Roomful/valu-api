// ===========================================================================
// `valu-permissions.json` (src/scan/permissionsFile.js): what an app says it
// needs, read the same way by the server that checks it at publish and by the
// Developer Portal that shows it. A broken file never throws — it is read as
// far as it parses, and what went wrong is said in `error`.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePermissionsFile, comparePermissions, SCOPE_PATTERN, WHY_MAX,
} from '../../src/scan/permissionsFile.js';

test('no file is nothing declared, and not an error', () => {
  assert.deepEqual(parsePermissionsFile(null), { present: false, error: null, permissions: [] });
});

test('a file that is not JSON is present, empty, and says so', () => {
  const read = parsePermissionsFile('{');
  assert.equal(read.present, true);
  assert.deepEqual(read.permissions, []);
  assert.match(read.error, /JSON/);
});

test('permissions must be an array', () => {
  const read = parsePermissionsFile('{"permissions": 3}');
  assert.deepEqual(read.permissions, []);
  assert.match(read.error, /permissions/);
});

test('a malformed entry is dropped and named; the others are kept', () => {
  const read = parsePermissionsFile(JSON.stringify({
    permissions: [
      { scope: 'rooms:read', why: 'Lists your rooms.' },
      { scope: 'Rooms:Read', why: 'x' },
      'events:read',
    ],
  }));
  assert.deepEqual(read.permissions, [{ scope: 'rooms:read', why: 'Lists your rooms.' }]);
  assert.match(read.error, /entry 1/);
  assert.match(read.error, /entry 2/);
});

test('a duplicate keeps the first reason, a long reason is cut, an unknown scope is kept', () => {
  const read = parsePermissionsFile(JSON.stringify({
    permissions: [
      { scope: 'rooms:read', why: 'first' },
      { scope: 'rooms:read', why: 'second' },
      { scope: 'events:read', why: 'y'.repeat(250) },
      { scope: 'foo:bar', why: 'z' },
    ],
  }));
  assert.equal(read.error, null);
  assert.deepEqual(read.permissions.map((p) => p.scope), ['rooms:read', 'events:read', 'foo:bar']);
  assert.equal(read.permissions[0].why, 'first');
  assert.equal(read.permissions[1].why.length, WHY_MAX);
});

test('a missing reason reads as an empty one', () => {
  const read = parsePermissionsFile('{"permissions":[{"scope":"rooms:read"}]}');
  assert.deepEqual(read.permissions, [{ scope: 'rooms:read', why: '' }]);
});

test('the scope pattern is lower-case service:access', () => {
  assert.ok(SCOPE_PATTERN.test('applicationstorage:write'));
  assert.ok(!SCOPE_PATTERN.test('rooms:*'));
  assert.ok(!SCOPE_PATTERN.test('Rooms:read'));
});

test('comparing the file with the code', () => {
  const file = { permissions: [{ scope: 'rooms:read', why: 'x' }, { scope: 'events:read', why: '' }] };
  assert.deepEqual(comparePermissions(file, ['rooms:read', 'textchat:write']), {
    required: ['events:read', 'rooms:read', 'textchat:write'],
    missingFromFile: ['textchat:write'],
    unusedInFile: ['events:read'],
    unknown: [],
    noReason: ['events:read'],
  });
});

test('an unknown scope is flagged wherever it came from', () => {
  const file = { permissions: [{ scope: 'foo:bar', why: 'x' }] };
  const result = comparePermissions(file, ['baz:qux']);
  assert.deepEqual(result.unknown, ['baz:qux', 'foo:bar']);
  assert.deepEqual(result.required, ['baz:qux', 'foo:bar']);
});

test('no file and no calls is nothing at all', () => {
  assert.deepEqual(comparePermissions(parsePermissionsFile(null), []), {
    required: [], missingFromFile: [], unusedInFile: [], unknown: [], noReason: [],
  });
});
