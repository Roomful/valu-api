import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceCache } from '../src/cache/ServiceCache.js';
import { findDescriptor } from '../src/services/descriptors.js';
import { FakeClock } from './helpers/fakes.js';

const get = findDescriptor('Users.get');
const search = findDescriptor('Users.search-users');
const write = findDescriptor('Users.send-connection-request');

test('a read round-trips, keyed by its entity', () => {
  const cache = new ServiceCache();
  cache.set(get, { userId: 'u-1' }, { data: { id: 'u-1' } });

  assert.deepEqual(cache.get(get, { userId: 'u-1' }), { data: { id: 'u-1' } });
  assert.equal(cache.get(get, { userId: 'u-2' }), undefined);
});

test('params beyond the entity key are part of the key', () => {
  const cache = new ServiceCache();
  cache.set(search, { query: 'a' }, { data: 1 });

  assert.deepEqual(cache.get(search, { query: 'a' }), { data: 1 });
  assert.equal(cache.get(search, { query: 'b' }), undefined);
});

test('key order does not change the key', () => {
  const cache = new ServiceCache();
  const rooms = findDescriptor('Rooms.search-rooms');
  cache.set(rooms, { query: 'a', offset: 0 }, { data: 1 });

  assert.deepEqual(cache.get(rooms, { offset: 0, query: 'a' }), { data: 1 });
});

test('an entry expires on its TTL', () => {
  const clock = new FakeClock();
  const cache = new ServiceCache({ now: clock.now });
  cache.set(get, { userId: 'u-1' }, { data: 1 });

  clock.advance(get.cache.ttlMs - 1);
  assert.notEqual(cache.get(get, { userId: 'u-1' }), undefined);
  clock.advance(2);
  assert.equal(cache.get(get, { userId: 'u-1' }), undefined);
  assert.equal(cache.size, 0, 'an expired entry is dropped on the way past');
});

test('writes and failures are never stored', () => {
  const cache = new ServiceCache();
  cache.set(write, { userId: 'u-1' }, { data: { ok: true } });
  cache.set(get, { userId: 'u-1' }, { error: { status: true, message: 'bad moment' } });

  assert.equal(cache.size, 0);
});

test('invalidateService drops only that service', () => {
  const cache = new ServiceCache();
  cache.set(get, { userId: 'u-1' }, { data: 1 });
  cache.set(findDescriptor('Rooms.search-rooms'), { query: 'a' }, { data: 2 });

  assert.equal(cache.invalidateService('Users'), 1);
  assert.equal(cache.size, 1);
});

test('a resource:updated push invalidates by entity id, in any of its shapes', () => {
  for (const payload of [{ id: 'u-1' }, { resourceId: 'u-1' }, { resource: { id: 'u-1' } }, { belonging: 'u-1' }]) {
    const cache = new ServiceCache();
    cache.set(get, { userId: 'u-1' }, { data: 1 });
    cache.set(get, { userId: 'u-2' }, { data: 2 });

    assert.equal(cache.onResourceUpdated(payload), 1, JSON.stringify(payload));
    assert.equal(cache.get(get, { userId: 'u-2' }) !== undefined, true, 'other entities are untouched');
  }
});

test('a push with nothing to key on invalidates nothing', () => {
  const cache = new ServiceCache();
  cache.set(get, { userId: 'u-1' }, { data: 1 });

  assert.equal(cache.onResourceUpdated({ kind: 'room' }), 0);
  assert.equal(cache.onResourceUpdated(undefined), 0);
  assert.equal(cache.size, 1);
});

test('a seeded entry is readable even though nothing fetched it', () => {
  const balance = findDescriptor('VerusWallet.get-balance');
  const cache = new ServiceCache();

  cache.seed(balance, { currency: 'VRSC' }, { amount: 12 });

  assert.deepEqual(cache.get(balance, { currency: 'VRSC' }), { data: { amount: 12 } });
});

test('the cache is bounded', () => {
  const cache = new ServiceCache({ maxEntries: 3 });
  for (const id of ['a', 'b', 'c', 'd']) cache.set(get, { userId: id }, { data: id });

  assert.equal(cache.size, 3);
  assert.equal(cache.get(get, { userId: 'a' }), undefined, 'oldest out first');
  assert.notEqual(cache.get(get, { userId: 'd' }), undefined);
});
