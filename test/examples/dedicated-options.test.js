// ===========================================================================
// The dedicated sample's query parameters (examples/dedicated/options.js):
// honoured only on localhost / 127.0.0.1, so a link cannot point a deployed
// copy at another host, sign-in page or embedding parent.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sampleOptions } from '../../examples/dedicated/options.js';

const at = (hostname, search) => sampleOptions({ hostname, search });

test('with no query the sample takes every default, on localhost and anywhere else', () => {
  assert.deepEqual(at('localhost', ''), {});
  assert.deepEqual(at('demo-ws-1.valuguru.app', ''), {});
});

test('on localhost and 127.0.0.1 the query sets the options, hostOrigins as a comma-separated list', () => {
  const search = '?host=http://localhost:3001&hostPath=/&signin=http://localhost:3006&app=ws_1/demo'
    + '&hostOrigins=http://localhost:3007, https://live.valuverse.io';
  for (const hostname of ['localhost', '127.0.0.1']) {
    assert.deepEqual(at(hostname, search), {
      hostOrigin: 'http://localhost:3001',
      hostPath: '/',
      signInOrigin: 'http://localhost:3006',
      app: 'ws_1/demo',
      hostOrigins: ['http://localhost:3007', 'https://live.valuverse.io'],
    }, hostname);
  }
  assert.deepEqual(at('localhost', '?hostOrigins=http://localhost:3007'), { hostOrigins: ['http://localhost:3007'] });
});

test('anywhere else the query is ignored, hostOrigins included', () => {
  const search = '?host=https://evil.example&signin=https://evil.example&app=x/y&hostOrigins=https://evil.example';
  for (const hostname of ['demo-ws-1.valuguru.app', 'localhost.evil.example', 'evil-localhost', '127.0.0.2', '']) {
    assert.deepEqual(at(hostname, search), {}, hostname);
  }
});

test('an empty hostOrigins is no list at all, not one that admits nobody', () => {
  for (const search of ['?hostOrigins=', '?hostOrigins=,', '?hostOrigins= , ']) {
    assert.deepEqual(at('localhost', search), {}, search);
  }
});
