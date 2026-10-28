// ===========================================================================
// SessionStore — the host's one-session-per-network storage.
//
// Runs over `FakeStorage`, which holds strings and throws on request the way a
// Safari private window or a full quota does. The cross-tab `storage` event is
// injected the same way the page injects it, so a test fires it by hand.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionStore } from '../../src/host/SessionStore.js';
import { FakeStorage } from '../helpers/hostFakes.js';

const KEY = 'valu-host:session';
const SECRET = 'sess-4c1f-NOT-A-REAL-SESSION';

/** A store whose `storage` event the test fires by hand. */
function storeOver(storage, options = {}) {
  let fire = () => {};
  const store = new SessionStore({
    storage,
    subscribe: (handler) => { fire = handler; },
    ...options,
  });
  return { store, fireExternal: () => fire() };
}

test('an empty store has no session and says it is on storage', () => {
  const { store } = storeOver(new FakeStorage());
  assert.equal(store.load(), null);
  assert.equal(store.get('n1'), null);
  assert.equal(store.storageMode, 'storage');
});

test('set writes the schema under valu-host:session and get reads it back', () => {
  const storage = new FakeStorage();
  const { store } = storeOver(storage);
  store.set({ userId: 'u1', networkId: 'n1', sessionId: 's1' });

  const raw = JSON.parse(storage.getItem(KEY));
  assert.equal(raw.v, 1);
  assert.equal(raw.userId, 'u1');
  assert.deepEqual(Object.keys(raw.sessions), ['n1']);
  assert.equal(raw.sessions.n1.sessionId, 's1');
  assert.equal(typeof raw.sessions.n1.createdAt, 'number');

  assert.deepEqual(store.get('n1'), raw.sessions.n1);
  assert.deepEqual(store.load(), raw);
  assert.equal(store.storageMode, 'storage');
});

test('keeps one session per network', () => {
  const { store } = storeOver(new FakeStorage());
  store.set({ userId: 'u1', networkId: 'n1', sessionId: 's1' });
  store.set({ userId: 'u1', networkId: 'n2', sessionId: 's2' });
  assert.equal(store.get('n1').sessionId, 's1');
  assert.equal(store.get('n2').sessionId, 's2');

  store.set({ userId: 'u1', networkId: 'n1', sessionId: 's1b' });
  assert.equal(store.get('n1').sessionId, 's1b', 'the network\'s entry is replaced');
  assert.equal(store.get('n2').sessionId, 's2', 'the other network is untouched');
  assert.deepEqual(Object.keys(store.load().sessions).sort(), ['n1', 'n2']);
});

test('a different user replaces the whole record', () => {
  const { store } = storeOver(new FakeStorage());
  store.set({ userId: 'u1', networkId: 'n1', sessionId: 's1' });
  store.set({ userId: 'u1', networkId: 'n2', sessionId: 's2' });
  store.set({ userId: 'u2', networkId: 'n2', sessionId: 's3' });

  const record = store.load();
  assert.equal(record.userId, 'u2');
  assert.deepEqual(Object.keys(record.sessions), ['n2']);
  assert.equal(store.get('n1'), null, 'the first user\'s other network is gone');
  assert.equal(store.get('n2').sessionId, 's3');
});

test('get and load hand back copies, not the stored record', () => {
  for (const store of [storeOver(new FakeStorage()).store, new SessionStore({ storage: null })]) {
    store.set({ userId: 'u1', networkId: 'n1', sessionId: 's1' });
    store.get('n1').sessionId = 'tampered';
    store.load().sessions.n1.sessionId = 'tampered';
    assert.equal(store.get('n1').sessionId, 's1', store.storageMode);
  }
});

test('clear removes the record', () => {
  const storage = new FakeStorage();
  const { store } = storeOver(storage);
  store.set({ userId: 'u1', networkId: 'n1', sessionId: 's1' });
  store.clear();
  assert.equal(store.load(), null);
  assert.equal(store.get('n1'), null);
  assert.equal(storage.getItem(KEY), null);
});

test('a network id that is also an Object.prototype name is just a network id', () => {
  const { store } = storeOver(new FakeStorage());
  assert.equal(store.get('constructor'), null);
  assert.equal(store.get('__proto__'), null);
  store.set({ userId: 'u1', networkId: '__proto__', sessionId: 's1' });
  assert.equal(store.get('__proto__').sessionId, 's1');
  assert.equal(store.get('toString'), null);
});

test('a record that is corrupt, of another version, or the wrong shape is no session', () => {
  const storage = new FakeStorage();
  const { store } = storeOver(storage);
  for (const raw of [
    '{not json',
    'null',
    '[]',
    JSON.stringify({ v: 2, userId: 'u1', sessions: { n1: { sessionId: 's1', createdAt: 1 } } }),
    JSON.stringify({ v: 1, sessions: {} }),
    JSON.stringify({ v: 1, userId: 'u1' }),
    JSON.stringify({ v: 1, userId: 'u1', sessions: [] }),
  ]) {
    storage.setItem(KEY, raw);
    assert.equal(store.load(), null, raw);
  }
  assert.equal(store.storageMode, 'storage', 'a bad record is not a storage failure');

  storage.setItem(KEY, JSON.stringify({
    v: 1, userId: 'u1', sessions: { n1: { sessionId: 's1', createdAt: 1 }, n2: { sessionId: '' }, n3: 'x' },
  }));
  assert.deepEqual(Object.keys(store.load().sessions), ['n1'], 'an entry without a session id is dropped');
});

// ---- memory fallback -------------------------------------------------------

test('falls back to memory when setItem throws', () => {
  const { store } = storeOver(new FakeStorage({ throwOn: 'set' }));
  store.set({ userId: 'u1', networkId: 'n1', sessionId: 's1' });
  assert.equal(store.get('n1').sessionId, 's1');
  assert.equal(store.load().userId, 'u1');
  assert.equal(store.storageMode, 'memory');
});

test('falls back to memory when getItem throws', () => {
  const storage = new FakeStorage({ throwOn: 'get' });
  const { store } = storeOver(storage);
  assert.equal(store.get('n1'), null, 'a read that throws is "no session", not an error');
  assert.equal(store.storageMode, 'memory');

  store.set({ userId: 'u1', networkId: 'n1', sessionId: 's1' });
  assert.equal(store.get('n1').sessionId, 's1');
  store.clear();
  assert.equal(store.get('n1'), null);
});

test('the memory fallback lasts for the life of the store, even when storage recovers', () => {
  const storage = new FakeStorage({ throwOn: 'set' });
  const { store } = storeOver(storage);
  store.set({ userId: 'u1', networkId: 'n1', sessionId: 's1' });
  assert.equal(store.storageMode, 'memory');

  storage.throwOn = null;
  store.set({ userId: 'u1', networkId: 'n2', sessionId: 's2' });
  assert.equal(store.storageMode, 'memory');
  assert.equal(storage.getItem(KEY), null, 'nothing is written to storage any more');
  assert.equal(store.get('n1').sessionId, 's1');
  assert.equal(store.get('n2').sessionId, 's2');
});

test('a write that throws keeps what the store already held, and adds the new session', () => {
  const storage = new FakeStorage();
  const { store } = storeOver(storage);
  store.set({ userId: 'u1', networkId: 'n1', sessionId: 's1' });

  storage.throwOn = 'set';
  store.set({ userId: 'u1', networkId: 'n2', sessionId: 's2' });
  assert.equal(store.storageMode, 'memory');
  assert.equal(store.get('n1').sessionId, 's1');
  assert.equal(store.get('n2').sessionId, 's2');
});

test('falls back to memory when removeItem throws, and the clear still happens', () => {
  const storage = new FakeStorage();
  storage.removeItem = () => { throw new Error('blocked'); };
  const { store } = storeOver(storage);
  store.set({ userId: 'u1', networkId: 'n1', sessionId: 's1' });

  store.clear();
  assert.equal(store.storageMode, 'memory');
  assert.equal(store.get('n1'), null);
});

test('clear still removes a record that storage holds after the store went to memory', () => {
  // Quota-full storage: it can be read and cleared but not written. Signing
  // out must not leave the old session there for the next page load.
  const storage = new FakeStorage();
  const { store: first } = storeOver(storage);
  first.set({ userId: 'u1', networkId: 'n1', sessionId: 's1' });

  storage.throwOn = 'set';
  const { store } = storeOver(storage);
  store.set({ userId: 'u1', networkId: 'n2', sessionId: 's2' });
  assert.equal(store.storageMode, 'memory');
  assert.notEqual(storage.getItem(KEY), null);

  store.clear();
  assert.equal(storage.getItem(KEY), null);
  assert.equal(store.get('n1'), null);
  assert.equal(store.get('n2'), null);
});

test('a missing storage is a memory store', () => {
  const store = new SessionStore({ storage: null });
  assert.equal(store.storageMode, 'memory');
  store.set({ userId: 'u1', networkId: 'n1', sessionId: 's1' });
  assert.equal(store.get('n1').sessionId, 's1');
});

test('uses the key it is given', () => {
  const storage = new FakeStorage();
  const store = new SessionStore({ storage, key: 'other:key' });
  store.set({ userId: 'u1', networkId: 'n1', sessionId: 's1' });
  assert.notEqual(storage.getItem('other:key'), null);
  assert.equal(storage.getItem(KEY), null);
});

// ---- change events ---------------------------------------------------------

test('onChange fires on external storage event', () => {
  const storage = new FakeStorage();
  const { store, fireExternal } = storeOver(storage);
  let fired = 0;
  store.onChange(() => { fired += 1; });

  // Another tab signs in: it writes the record and the browser fires `storage` here.
  storage.setItem(KEY, JSON.stringify({ v: 1, userId: 'u9', sessions: { n1: { sessionId: 's9', createdAt: 1 } } }));
  fireExternal();
  assert.equal(fired, 1);
  assert.equal(store.get('n1').sessionId, 's9', 'the change is readable when the handler runs');

  storage.removeItem(KEY);
  fireExternal();
  assert.equal(fired, 2);
  assert.equal(store.load(), null);
});

test('this store\'s own writes do not fire onChange', () => {
  const { store } = storeOver(new FakeStorage());
  let fired = 0;
  store.onChange(() => { fired += 1; });
  store.set({ userId: 'u1', networkId: 'n1', sessionId: 's1' });
  store.clear();
  assert.equal(fired, 0);
});

test('onChange returns an unsubscribe, and one handler throwing does not stop the others', (t) => {
  const { store, fireExternal } = storeOver(new FakeStorage());
  t.mock.method(console, 'error', () => {});
  const seen = [];
  const off = store.onChange(() => { seen.push('a'); });
  store.onChange(() => { throw new Error('boom'); });
  store.onChange(() => { seen.push('c'); });

  fireExternal();
  assert.deepEqual(seen, ['a', 'c']);

  off();
  fireExternal();
  assert.deepEqual(seen, ['a', 'c', 'c']);
});

test('without a subscribe there is simply no cross-tab event', () => {
  const store = new SessionStore({ storage: new FakeStorage() });
  assert.equal(typeof store.onChange(() => {}), 'function');
});

// ---- hygiene ---------------------------------------------------------------

test('a bad set names the problem without naming the session', () => {
  const { store } = storeOver(new FakeStorage());
  for (const args of [
    { userId: 'u1', networkId: '', sessionId: SECRET },
    { userId: '', networkId: 'n1', sessionId: SECRET },
    { userId: 'u1', networkId: 'n1', sessionId: '' },
    { userId: 'u1', networkId: 'n1', sessionId: 5 },
  ]) {
    assert.throws(() => store.set(args), (error) => {
      assert.ok(error instanceof TypeError);
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
  }
  assert.equal(store.load(), null);
});
