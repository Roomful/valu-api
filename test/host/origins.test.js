// ===========================================================================
// Origin matching: what is an origin, what is a local one, and what fits an
// allow-list pattern. The look-alike cases are the point: a host that lets
// `valuguru.app.evil.example` or `localhost.evil.example` through has lost the
// binding rule it exists to keep.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isOrigin, isLocalOrigin, matchesOrigin } from '../../src/host/origins.js';

test('isOrigin accepts http(s) origins and nothing else', () => {
  for (const origin of [
    'https://demo-ws-1.valuguru.app', 'http://localhost:3005', 'https://valuguru.texpo.io', 'http://127.0.0.1',
    'https://a.b.c.example:8443',
  ]) assert.equal(isOrigin(origin), true, origin);

  for (const value of [
    'null', '*', '', undefined, null, 42, {}, [], 'https://x.example/', 'https://x.example/path', 'https://x.example?a=1',
    'ftp://x.example', 'x.example', '//x.example', 'https://', 'https://a..example', 'https://[::1]:3000',
    'https://user@x.example', 'https://x.example:port', ' https://x.example',
  ]) assert.equal(isOrigin(value), false, String(value));
});

test('isLocalOrigin is exactly http://localhost and http://127.0.0.1, on any port', () => {
  for (const origin of ['http://localhost', 'http://localhost:3005', 'http://127.0.0.1', 'http://127.0.0.1:5173']) {
    assert.equal(isLocalOrigin(origin), true, origin);
  }
  for (const value of [
    'https://localhost:3005', 'http://localhost.evil.example', 'http://localhost.evil.example:3005',
    'http://127.0.0.1.evil.example', 'http://127.0.0.2', 'http://notlocalhost:3000', 'http://evil.example/localhost',
    'http://localhost/', 'http://localhost:abc', 'null', '', undefined, null, 7,
  ]) assert.equal(isLocalOrigin(value), false, String(value));
});

test('matchesOrigin: a subdomain pattern covers subdomains of any depth, never the apex or a look-alike', () => {
  const pattern = 'https://*.valuguru.app';
  for (const origin of [
    'https://demo-ws-1.valuguru.app', 'https://a.b.valuguru.app', 'https://x.valuguru.app', 'HTTPS://Demo.Valuguru.App',
  ]) assert.equal(matchesOrigin(pattern, origin), true, origin);

  for (const origin of [
    'https://valuguru.app', 'https://evilvaluguru.app', 'https://valuguru.app.evil.example', 'https://evil.example',
    'https://demo.valuguru.app.evil.example', 'http://demo.valuguru.app', 'https://demo.valuguru.app:8443',
    'null', '*', '', 'https://demo.valuguru.app/', 'https://.valuguru.app',
  ]) assert.equal(matchesOrigin(pattern, origin), false, origin);
});

test('matchesOrigin: ports match as written, and :* means any port or none', () => {
  assert.equal(matchesOrigin('http://localhost:*', 'http://localhost:3005'), true);
  assert.equal(matchesOrigin('http://localhost:*', 'http://localhost'), true);
  assert.equal(matchesOrigin('http://localhost:*', 'https://localhost:3005'), false, 'the scheme must agree');
  assert.equal(matchesOrigin('http://localhost:*', 'http://localhost.evil.example:3005'), false);
  assert.equal(matchesOrigin('http://localhost:3005', 'http://localhost:3005'), true);
  assert.equal(matchesOrigin('http://localhost:3005', 'http://localhost:3006'), false);
  assert.equal(matchesOrigin('http://localhost:3005', 'http://localhost'), false);
  assert.equal(matchesOrigin('http://localhost', 'http://localhost:3005'), false, 'no port in the pattern means none');
});

test('matchesOrigin: an exact pattern is an exact host', () => {
  assert.equal(matchesOrigin('https://shop.example', 'https://shop.example'), true);
  assert.equal(matchesOrigin('https://shop.example', 'https://www.shop.example'), false);
  assert.equal(matchesOrigin('https://shop.example', 'https://shop.example.evil.example'), false);
  assert.equal(matchesOrigin('https://shop.example', 'https://eshop.example'), false);
});

test('matchesOrigin: a pattern that is not well formed matches nothing', () => {
  for (const pattern of [
    '', '*', 'https://*', 'https://*.', '*.valuguru.app', 'valuguru.app', 'https://a*.valuguru.app', 'https://*.*.valuguru.app',
    'https://valuguru.app/', 'https://valuguru.app/*', 'https://**.valuguru.app', 'ftp://x.example', undefined, null, 42, {},
  ]) {
    for (const origin of ['https://demo.valuguru.app', 'https://valuguru.app', 'null', '*']) {
      assert.equal(matchesOrigin(pattern, origin), false, `${String(pattern)} vs ${origin}`);
    }
  }
});
