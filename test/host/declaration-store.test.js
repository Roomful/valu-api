// ===========================================================================
// DeclarationStore: what an app declares, read over Valu Guru and kept for a
// minute, and the misses it reports — at most once per scope per minute, and
// never in a way that decides a call.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeclarationStore, OP_DECLARED, OP_MISS } from '../../src/host/DeclarationStore.js';

function fakeGuru(answer) {
  const requests = [];
  return {
    requests,
    request: async (op, params) => {
      requests.push({ op, params });
      if (op === OP_MISS) return { ok: true };
      return typeof answer === 'function' ? answer() : answer;
    },
  };
}

test('asks for the app by its address and its Developer Portal id, and reads the answer into shape', async () => {
  const guru = fakeGuru({ mode: 'enforce', scopes: ['rooms:read', 7], source: 'released' });
  const store = new DeclarationStore({ guru, app: { appId: 'ws_1/notes', devAppId: 'app_1' } });
  assert.deepEqual(await store.get(), { mode: 'enforce', scopes: ['rooms:read'] });
  assert.deepEqual(guru.requests, [{ op: OP_DECLARED, params: { appId: 'ws_1/notes', devAppId: 'app_1' } }]);
});

test('keeps an answer for its ttl, and shares a lookup already under way', async () => {
  let clock = 0;
  const guru = fakeGuru({ mode: 'report', scopes: [] });
  const store = new DeclarationStore({ guru, app: { devAppId: 'app_1' }, now: () => clock, ttlMs: 1000 });
  await Promise.all([store.get(), store.get()]);
  await store.get();
  assert.equal(guru.requests.length, 1);
  clock = 1000;
  await store.get();
  assert.equal(guru.requests.length, 2);
  store.invalidate();
  await store.get();
  assert.equal(guru.requests.length, 3);
});

test('a failure rejects and is not kept; a server without the op is the rule switched off', async () => {
  let fail = true;
  const guru = fakeGuru(() => { if (fail) throw Object.assign(new Error('x'), { code: 'timeout' }); return { mode: 'enforce', scopes: [] }; });
  const store = new DeclarationStore({ guru, app: { devAppId: 'app_1' } });
  await assert.rejects(store.get(), { code: 'timeout' });
  fail = false;
  assert.deepEqual(await store.get(), { mode: 'enforce', scopes: [] });

  const old = new DeclarationStore({
    guru: fakeGuru(() => { throw Object.assign(new Error('Unknown op'), { code: 'unknown_op' }); }),
    app: { devAppId: 'app_1' },
  });
  assert.deepEqual(await old.get(), { mode: 'off', scopes: null });
});

test('reports a miss once per scope per ttl, with where it was checked, and never throws', async () => {
  let clock = 0;
  const guru = fakeGuru({});
  const store = new DeclarationStore({ guru, app: { appId: 'ws_1/notes' }, path: 'embedded', now: () => clock, ttlMs: 1000 });
  store.reportMiss('rooms:write', 'enforce');
  store.reportMiss('rooms:write', 'enforce');
  store.reportMiss('groups:read', 'report');
  clock = 1000;
  store.reportMiss('rooms:write', 'enforce');
  assert.deepEqual(guru.requests.map((r) => r.params), [
    { appId: 'ws_1/notes', scope: 'rooms:write', mode: 'enforce', path: 'embedded' },
    { appId: 'ws_1/notes', scope: 'groups:read', mode: 'report', path: 'embedded' },
    { appId: 'ws_1/notes', scope: 'rooms:write', mode: 'enforce', path: 'embedded' },
  ]);

  const throwing = new DeclarationStore({ guru: { request: () => { throw new Error('boom'); } }, app: { devAppId: 'a' } });
  assert.doesNotThrow(() => throwing.reportMiss('rooms:write', 'enforce'));
  const rejecting = new DeclarationStore({ guru: { request: async () => { throw new Error('boom'); } }, app: { devAppId: 'a' } });
  assert.doesNotThrow(() => rejecting.reportMiss('rooms:write', 'enforce'));
});

test('needs an app it can name', () => {
  assert.throws(() => new DeclarationStore({ guru: fakeGuru({}), app: {} }), TypeError);
  assert.throws(() => new DeclarationStore({ guru: null, app: { devAppId: 'a' } }), TypeError);
});

test('a not_served miss names the call, and is kept apart from an undeclared one of the same scope', async () => {
  let clock = 0;
  const guru = fakeGuru({});
  const store = new DeclarationStore({ guru, app: { appId: 'ws_1/notes' }, path: 'host', now: () => clock, ttlMs: 1000 });
  store.reportMiss('ui:open', 'off', { reason: 'not_served', call: 'Commerce.open-cart' });
  store.reportMiss('ui:open', 'off', { reason: 'not_served', call: 'Commerce.open-cart' });
  store.reportMiss('ui:open', 'off', { reason: 'not_served', call: 'Commerce.checkout' });
  store.reportMiss('ui:open', 'enforce');
  assert.deepEqual(guru.requests.map((r) => r.params), [
    { appId: 'ws_1/notes', scope: 'ui:open', mode: 'off', path: 'host', reason: 'not_served', call: 'Commerce.open-cart' },
    { appId: 'ws_1/notes', scope: 'ui:open', mode: 'off', path: 'host', reason: 'not_served', call: 'Commerce.checkout' },
    { appId: 'ws_1/notes', scope: 'ui:open', mode: 'enforce', path: 'host' },
  ]);
});
