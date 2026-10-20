// ===========================================================================
// AppResolver — the page's origin -> the app it is, over the resolve endpoint.
//
// Runs against `fakeResolveFetch`, which answers the endpoint's two shapes
// (200 `{ok, app}`, 404 `unknown_app`) and records every request, so the cache
// is asserted on the wire: a lookup the cache answered never reaches `.calls`.
// The clock is injected; nothing waits.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AppResolver, RESOLVE_UNAVAILABLE } from '../../src/host/AppResolver.js';
import { fakeResolveFetch } from '../helpers/hostFakes.js';

const BASE = 'https://valuguru.texpo.io';
const ORIGIN = 'https://notes-ws-ab12.valuguru.app';
const APP = {
  address: 'ab12/notes',
  workspaceId: 'ab12',
  slug: 'notes',
  devAppId: 'dev-app-1',
  name: 'Notes',
  homeNetworkId: 'net-7',
};

/** A clock the test moves. */
function clock(start = 1_000) {
  const time = { at: start, now: () => time.at };
  return time;
}

test('resolves an origin through the endpoint, encoded, and returns the app', async () => {
  const fetchImpl = fakeResolveFetch({ [ORIGIN]: APP });
  const resolver = new AppResolver({ fetchImpl, baseUrl: BASE });

  assert.deepEqual(await resolver.resolve(ORIGIN), APP);

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].method, 'GET');
  assert.equal(
    fetchImpl.calls[0].url,
    `${BASE}/api/host/v1/resolve?origin=${encodeURIComponent(ORIGIN)}`,
  );
});

test('a trailing slash on baseUrl does not double up', async () => {
  const fetchImpl = fakeResolveFetch({ [ORIGIN]: APP });
  await new AppResolver({ fetchImpl, baseUrl: `${BASE}//` }).resolve(ORIGIN);
  assert.equal(new URL(fetchImpl.calls[0].url).pathname, '/api/host/v1/resolve');
  assert.equal(new URL(fetchImpl.calls[0].url).origin, BASE);
});

test('the answer is a copy the caller cannot use to change the cache', async () => {
  const resolver = new AppResolver({ fetchImpl: fakeResolveFetch({ [ORIGIN]: APP }), baseUrl: BASE });
  const first = await resolver.resolve(ORIGIN);
  assert.ok(Object.isFrozen(first));
  assert.throws(() => { first.address = 'x/y'; }, TypeError);
  assert.equal((await resolver.resolve(ORIGIN)).address, APP.address);
});

test('caches a hit for ttl and a miss as null', async () => {
  const fetchImpl = fakeResolveFetch({ [ORIGIN]: APP });
  const time = clock();
  const resolver = new AppResolver({ fetchImpl, baseUrl: BASE, ttlMs: 10_000, now: time.now });
  const STRANGER = 'https://nobody-ws-zz99.valuguru.app';

  // A hit: one request, then cache, until the ttl is up.
  assert.deepEqual(await resolver.resolve(ORIGIN), APP);
  time.at += 9_999;
  assert.deepEqual(await resolver.resolve(ORIGIN), APP);
  assert.equal(fetchImpl.calls.length, 1, 'a hit inside the ttl is not asked for again');
  time.at += 1;
  assert.deepEqual(await resolver.resolve(ORIGIN), APP);
  assert.equal(fetchImpl.calls.length, 2, 'a hit at the ttl is asked for again');

  // A miss: null, remembered for the same ttl.
  assert.equal(await resolver.resolve(STRANGER), null);
  assert.equal(await resolver.resolve(STRANGER), null);
  assert.equal(fetchImpl.calls.length, 3, 'a miss inside the ttl is not asked for again');
  time.at += 10_000;
  assert.equal(await resolver.resolve(STRANGER), null);
  assert.equal(fetchImpl.calls.length, 4, 'a miss at the ttl is asked for again');
});

test('the ttl defaults to five minutes', async () => {
  const fetchImpl = fakeResolveFetch({ [ORIGIN]: APP });
  const time = clock();
  const resolver = new AppResolver({ fetchImpl, baseUrl: BASE, now: time.now });

  await resolver.resolve(ORIGIN);
  time.at += 299_999;
  await resolver.resolve(ORIGIN);
  assert.equal(fetchImpl.calls.length, 1);
  time.at += 1;
  await resolver.resolve(ORIGIN);
  assert.equal(fetchImpl.calls.length, 2);
});

test('a miss that becomes a hit is picked up once the ttl is up', async () => {
  const table = {};
  const fetchImpl = fakeResolveFetch(table);
  const time = clock();
  const resolver = new AppResolver({ fetchImpl, baseUrl: BASE, ttlMs: 5_000, now: time.now });

  assert.equal(await resolver.resolve(ORIGIN), null);
  table[ORIGIN] = APP; // the app was published in the meantime
  assert.equal(await resolver.resolve(ORIGIN), null, 'still the cached miss');
  time.at += 5_000;
  assert.deepEqual(await resolver.resolve(ORIGIN), APP);
});

test('origins are cached separately', async () => {
  const other = 'https://todo-ws-cd34.valuguru.app';
  const otherApp = { ...APP, address: 'cd34/todo', workspaceId: 'cd34', slug: 'todo', name: 'Todo' };
  const fetchImpl = fakeResolveFetch({ [ORIGIN]: APP, [other]: otherApp });
  const resolver = new AppResolver({ fetchImpl, baseUrl: BASE });

  assert.equal((await resolver.resolve(ORIGIN)).slug, 'notes');
  assert.equal((await resolver.resolve(other)).slug, 'todo');
  assert.equal(fetchImpl.calls.length, 2);
});

test('lookups for one origin that overlap share a single request', async () => {
  const fetchImpl = fakeResolveFetch({ [ORIGIN]: APP });
  const resolver = new AppResolver({ fetchImpl, baseUrl: BASE });

  const [a, b] = await Promise.all([resolver.resolve(ORIGIN), resolver.resolve(ORIGIN)]);
  assert.deepEqual(a, APP);
  assert.deepEqual(b, APP);
  assert.equal(fetchImpl.calls.length, 1);
});

test('throws resolve_unavailable on 500', async () => {
  const down = async () => ({ ok: false, status: 500, json: async () => ({ ok: false }) });
  const resolver = new AppResolver({ fetchImpl: down, baseUrl: BASE });

  await assert.rejects(resolver.resolve(ORIGIN), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.code, RESOLVE_UNAVAILABLE);
    assert.equal(error.code, 'resolve_unavailable');
    assert.equal(error.status, 500);
    return true;
  });
});

test('fakeResolveFetch answers 500 for a path that is not the resolve endpoint, and that is resolve_unavailable', async () => {
  // Through the real fake: a base URL whose path puts the request somewhere
  // the fake does not serve.
  const fetchImpl = fakeResolveFetch({ [ORIGIN]: APP });
  const resolver = new AppResolver({ fetchImpl: (url, options) => fetchImpl(String(url).replace('/resolve', '/elsewhere'), options), baseUrl: BASE });
  await assert.rejects(resolver.resolve(ORIGIN), { code: 'resolve_unavailable', status: 500 });
});

test('other non-2xx answers, a network failure and a malformed body are resolve_unavailable too', async () => {
  const cases = {
    'a 403': async () => ({ ok: false, status: 403, json: async () => ({}) }),
    'a 429': async () => ({ ok: false, status: 429, json: async () => ({}) }),
    'a network failure': async () => { throw new TypeError('Failed to fetch'); },
    'a 200 that is not JSON': async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
    'a 200 without an app': async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    'a 200 whose app has no address': async () => ({ ok: true, status: 200, json: async () => ({ ok: true, app: { name: 'x' } }) }),
  };
  for (const [name, fetchImpl] of Object.entries(cases)) {
    const resolver = new AppResolver({ fetchImpl, baseUrl: BASE });
    await assert.rejects(resolver.resolve(ORIGIN), { code: 'resolve_unavailable' }, name);
  }
});

test('a failure is not cached: the next call asks again', async () => {
  let up = false;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return up
      ? { ok: true, status: 200, json: async () => ({ ok: true, app: APP }) }
      : { ok: false, status: 503, json: async () => ({}) };
  };
  const resolver = new AppResolver({ fetchImpl, baseUrl: BASE });

  await assert.rejects(resolver.resolve(ORIGIN), { code: 'resolve_unavailable' });
  up = true;
  assert.deepEqual(await resolver.resolve(ORIGIN), APP);
  assert.equal(calls.length, 2);
});

test('a hit that is already cached survives the server going down', async () => {
  let up = true;
  const time = clock();
  const fetchImpl = async () => (up
    ? { ok: true, status: 200, json: async () => ({ ok: true, app: APP }) }
    : { ok: false, status: 503, json: async () => ({}) });
  const resolver = new AppResolver({ fetchImpl, baseUrl: BASE, ttlMs: 1_000, now: time.now });

  await resolver.resolve(ORIGIN);
  up = false;
  assert.deepEqual(await resolver.resolve(ORIGIN), APP);
  time.at += 1_000;
  await assert.rejects(resolver.resolve(ORIGIN), { code: 'resolve_unavailable' });
});

test('refuses to be built without a baseUrl, or an origin to look up', async () => {
  const fetchImpl = fakeResolveFetch({});
  assert.throws(() => new AppResolver({ fetchImpl }), TypeError);
  assert.throws(() => new AppResolver({ fetchImpl, baseUrl: 42 }), TypeError);
  const resolver = new AppResolver({ fetchImpl, baseUrl: BASE });
  await assert.rejects(resolver.resolve(''), TypeError);
  await assert.rejects(resolver.resolve(undefined), TypeError);
  assert.equal(fetchImpl.calls.length, 0);
});

test('falls back to the global fetch, bound, when none is given', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = function fakeGlobalFetch(url) {
    // A bare `fetch` called as a method of anything but `window` is "Illegal
    // invocation" in a browser; here, `this` must be the global object.
    seen.push({ url: String(url), self: this });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, app: APP }) });
  };
  try {
    const resolver = new AppResolver({ baseUrl: BASE });
    assert.deepEqual(await resolver.resolve(ORIGIN), APP);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].self, globalThis);
  } finally {
    globalThis.fetch = original;
  }
});
