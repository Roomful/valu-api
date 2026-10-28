// ===========================================================================
// GrantsStore — the host's per-app view of what the signed-in user allowed.
//
// The fake `guru` records every call and answers from a script; the error it
// throws is a `GuruError` look-alike (an `Error` with a `code`), so nothing
// here imports the real client. Time is injected: nothing waits on a clock.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GrantsStore } from '../../src/host/GrantsStore.js';

const APP = 'ws_7a07b7b5/hebrew-lab';
const LIST = 'valuguru.apps.grants.list';
const GRANT = 'valuguru.apps.grants.grant';

const guruError = (code, message) => Object.assign(new Error(message), { name: 'GuruError', code });

/** A row of `valuguru.apps.grants.list`. */
const row = (scope, revokedAt = null, appId = APP) => ({
  appId, scope, grantedAt: '2026-10-01T10:00:00Z', revokedAt,
});

/**
 * A fake guru: `script[op]` is a value, an Error to throw, or a function of
 * (params) returning either. `calls` records `{op, params}` in order.
 */
function fakeGuru(script) {
  const calls = [];
  return {
    calls,
    async request(op, params) {
      calls.push({ op, params });
      const answer = typeof script[op] === 'function' ? await script[op](params) : script[op];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms) => { state.t += ms; } };
}

const listed = (...rows) => ({ [LIST]: { grants: rows } });

test('has lists once then answers from cache', async () => {
  const guru = fakeGuru(listed(row('users:write'), row('rooms:read')));
  const store = new GrantsStore({ guru, appAddress: APP });

  assert.equal(await store.has('users:write'), true);
  assert.equal(await store.has('rooms:read'), true);
  assert.equal(await store.has('cms:write'), false);

  assert.deepEqual(guru.calls, [{ op: LIST, params: { appId: APP } }], 'one list, for this app only');
});

test('a revoked grant does not count', async () => {
  const guru = fakeGuru(listed(row('users:write', '2026-10-02T00:00:00Z'), row('rooms:read')));
  const store = new GrantsStore({ guru, appAddress: APP });

  assert.equal(await store.has('users:write'), false);
  assert.equal(await store.has('rooms:read'), true);
});

test('a row that names another app is ignored, in case the server ignored the filter', async () => {
  const guru = fakeGuru(listed(row('users:write', null, 'ws_other/app'), row('rooms:read')));
  const store = new GrantsStore({ guru, appAddress: APP });

  assert.equal(await store.has('users:write'), false);
  assert.equal(await store.has('rooms:read'), true);
});

test('an empty or malformed answer grants nothing', async () => {
  for (const answer of [{}, { grants: null }, null, undefined, { grants: [null, {}, { scope: 5 }] }]) {
    const store = new GrantsStore({ guru: fakeGuru({ [LIST]: answer }), appAddress: APP });
    assert.equal(await store.has('users:write'), false);
  }
});

test('the cache lasts 60 s and is read again after that', async () => {
  const time = clock();
  let grants = [row('users:write')];
  const guru = fakeGuru({ [LIST]: () => ({ grants }) });
  const store = new GrantsStore({ guru, appAddress: APP, now: time.now });

  assert.equal(await store.has('users:write'), true);
  time.advance(59_999);
  assert.equal(await store.has('users:write'), true);
  assert.equal(guru.calls.length, 1, 'still fresh');

  grants = [row('users:write', '2026-10-20T00:00:00Z')]; // revoked elsewhere
  assert.equal(await store.has('users:write'), true, 'a revocation is not seen inside the window');

  time.advance(1);
  assert.equal(await store.has('users:write'), false, 'and lands once the window is over');
  assert.equal(guru.calls.length, 2);
});

test('the ttl is configurable', async () => {
  const time = clock();
  const guru = fakeGuru(listed(row('users:write')));
  const store = new GrantsStore({ guru, appAddress: APP, now: time.now, ttlMs: 1_000 });

  await store.has('users:write');
  time.advance(1_000);
  await store.has('users:write');
  assert.equal(guru.calls.length, 2);
});

test('grant writes through and adds to the cache without another list', async () => {
  const guru = fakeGuru({ ...listed(row('users:write')), [GRANT]: { ok: true } });
  const store = new GrantsStore({ guru, appAddress: APP });

  assert.equal(await store.has('rooms:read'), false);
  await store.grant(['rooms:read', 'rooms:write']);

  assert.deepEqual(guru.calls.map((c) => c.op), [LIST, GRANT]);
  assert.deepEqual(guru.calls[1].params, { appId: APP, scopes: ['rooms:read', 'rooms:write'] });
  assert.equal(await store.has('rooms:read'), true);
  assert.equal(await store.has('rooms:write'), true);
  assert.equal(await store.has('users:write'), true, 'what was there stays');
  assert.equal(guru.calls.length, 2, 'the cache answered');
});

test('a grant made before the first list is part of that list', async () => {
  const guru = fakeGuru({ [GRANT]: { ok: true }, [LIST]: { grants: [row('rooms:read')] } });
  const store = new GrantsStore({ guru, appAddress: APP });

  await store.grant(['rooms:read']);
  assert.equal(await store.has('rooms:read'), true);
  assert.deepEqual(guru.calls.map((c) => c.op), [GRANT, LIST]);
});

test('a failed grant rejects and adds nothing', async () => {
  const guru = fakeGuru({ ...listed(), [GRANT]: guruError('forbidden', 'nope') });
  const store = new GrantsStore({ guru, appAddress: APP });

  await assert.rejects(store.grant(['rooms:read']), { code: 'forbidden' });
  assert.equal(await store.has('rooms:read'), false);
});

test('granting nothing sends nothing', async () => {
  const guru = fakeGuru({});
  const store = new GrantsStore({ guru, appAddress: APP });
  await store.grant([]);
  assert.deepEqual(guru.calls, []);
});

test('invalidate drops the cache so the next has lists again', async () => {
  let grants = [row('users:write')];
  const guru = fakeGuru({ [LIST]: () => ({ grants }) });
  const store = new GrantsStore({ guru, appAddress: APP });

  assert.equal(await store.has('users:write'), true);
  grants = [];
  store.invalidate();
  assert.equal(await store.has('users:write'), false);
  assert.equal(guru.calls.length, 2);
});

test('concurrent has calls share one list', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const guru = fakeGuru({ [LIST]: async () => { await gate; return { grants: [row('users:write')] }; } });
  const store = new GrantsStore({ guru, appAddress: APP });

  const answers = Promise.all([store.has('users:write'), store.has('rooms:read'), store.has('users:write')]);
  await new Promise((resolve) => { setImmediate(resolve); });
  release();

  assert.deepEqual(await answers, [true, false, true]);
  assert.equal(guru.calls.length, 1);
});

test('a failed list rejects every waiting caller and is not cached', async () => {
  let fail = true;
  const guru = fakeGuru({
    [LIST]: () => (fail ? guruError('timeout', 'no answer') : { grants: [row('users:write')] }),
  });
  const store = new GrantsStore({ guru, appAddress: APP });

  await assert.rejects(store.has('users:write'), { code: 'timeout' });
  fail = false;
  assert.equal(await store.has('users:write'), true, 'the next call retries');
});

test('an invalidate during a list keeps that list out of the cache', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let grants = [row('users:write')];
  const guru = fakeGuru({ [LIST]: async () => { const seen = grants; await gate; return { grants: seen }; } });
  const store = new GrantsStore({ guru, appAddress: APP });

  const first = store.has('users:write');
  await new Promise((resolve) => { setImmediate(resolve); });
  grants = [];
  store.invalidate();
  release();
  assert.equal(await first, true, 'the caller that asked gets the answer it waited for');

  assert.equal(await store.has('users:write'), false, 'but it was not kept');
  assert.equal(guru.calls.length, 2);
});

test('a grant waits for a list in flight, so the list cannot overwrite it', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const guru = fakeGuru({
    [LIST]: async () => { await gate; return { grants: [] }; },
    [GRANT]: { ok: true },
  });
  const store = new GrantsStore({ guru, appAddress: APP });

  const reading = store.has('rooms:read');
  const writing = store.grant(['rooms:read']);
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(guru.calls.map((c) => c.op), [LIST], 'the write has not started');
  release();
  await Promise.all([reading, writing]);

  assert.deepEqual(guru.calls.map((c) => c.op), [LIST, GRANT]);
  assert.equal(await store.has('rooms:read'), true);
});
