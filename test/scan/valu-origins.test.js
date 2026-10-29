// ===========================================================================
// The privacy audit's idea of "inside Valu" (src/scan/valuOrigins.js).
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VALU_ORIGINS, isValuUrl, hostOf } from '../../src/scan/valuOrigins.js';

test('Valu hosts are inside, other hosts are not', () => {
  assert.equal(isValuUrl('https://api.valuguru.app/x'), true);
  assert.equal(isValuUrl('https://api.roomful.net/api/v0/thumb/1'), true);
  assert.equal(isValuUrl('https://evil.example/x'), false);
  assert.equal(isValuUrl('http://api.valuguru.app/x'), false, 'plain http is a different origin');
});

test('a relative URL, data: and blob: stay on the page', () => {
  assert.equal(isValuUrl('/api/x'), true);
  assert.equal(isValuUrl('assets/a.png'), true);
  assert.equal(isValuUrl('data:image/png;base64,AAA'), true);
  assert.equal(isValuUrl('blob:https://a-b.valuguru.app/123'), true);
});

test("the app's own site is inside; another app's site is not", () => {
  const siteOrigin = 'https://a-b.valuguru.app';
  assert.equal(isValuUrl('https://a-b.valuguru.app/', { siteOrigin }), true);
  assert.equal(isValuUrl('https://other-b.valuguru.app/', { siteOrigin }), false);
  assert.equal(isValuUrl('https://a-b.valuguru.app/'), false, 'without siteOrigin nothing on valuguru.app is assumed');
});

test('a protocol-relative URL is read as https', () => {
  assert.equal(isValuUrl('//api.valuguru.app/x'), true);
  assert.equal(isValuUrl('//evil.example/x'), false);
});

test('garbage is not Valu', () => {
  assert.equal(isValuUrl(''), false);
  assert.equal(isValuUrl('https://'), false);
  assert.equal(isValuUrl(null), false);
});

test('every entry is an https origin with a reason', () => {
  for (const entry of VALU_ORIGINS) {
    assert.equal(new URL(entry.origin).origin, entry.origin, entry.origin);
    assert.ok(entry.origin.startsWith('https://'), entry.origin);
    assert.ok(entry.why.length > 10, entry.origin);
  }
});

test('hostOf names the host, or null', () => {
  assert.equal(hostOf('https://evil.example:8443/x'), 'evil.example:8443');
  assert.equal(hostOf('//cdn.x.io/a.js'), 'cdn.x.io');
  assert.equal(hostOf('/relative'), null);
});
