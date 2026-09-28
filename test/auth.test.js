import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AuthProvider, TokenStore, assertNoCredentialLeak } from '../src/auth/AuthProvider.js';
import { ERROR_CODES } from '../src/Errors.js';
import { FakeClock } from './helpers/fakes.js';

const token = (overrides = {}) => ({
  token: 'app-token',
  expiresAt: 2_000_000,
  scopes: ['users:read'],
  applicationId: 'app-1',
  ...overrides,
});

test('a user credential never reaches the wire', () => {
  for (const payload of [
    { sessionId: 'abc' },
    { session_id: 'abc' },
    { nested: { deeply: { cookie: 'abc' } } },
    { list: [{ Authorization: 'Bearer x' }] },
    { refreshToken: 'abc' },
  ]) {
    assert.throws(() => assertNoCredentialLeak(payload, 'call'), /would send the user credential/,
      JSON.stringify(payload));
  }
});

test('an ordinary payload passes, cycles and all', () => {
  const payload = { userId: 'u-1', nested: { token: 'app-token' } };
  payload.self = payload;
  assert.equal(assertNoCredentialLeak(payload), payload);
});

test('the store knows when a token is stale', () => {
  const clock = new FakeClock(1_000_000);
  const store = new TokenStore({ now: clock.now });

  assert.equal(store.isStale(), true, 'no token is stale');
  store.set(token());
  assert.equal(store.isStale(), false);

  clock.advance(940_000); // 60s left, exactly the refresh skew
  assert.equal(store.isStale(60_000), true);
  assert.equal(store.isStale(0), false);
});

test('describe() never includes the token itself', () => {
  const store = new TokenStore();
  store.set(token());
  const described = store.describe();

  assert.equal(JSON.stringify(described).includes('app-token'), false);
  assert.deepEqual(described.scopes, ['users:read']);
});

test('a token is acquired once and reused', async () => {
  let acquisitions = 0;
  const clock = new FakeClock(1_000_000);
  const auth = new AuthProvider({
    now: clock.now,
    acquire: async () => { acquisitions++; return token(); },
  });

  await auth.getToken();
  await auth.getToken();

  assert.equal(acquisitions, 1);
});

test('concurrent callers share one acquisition', async () => {
  let acquisitions = 0;
  const auth = new AuthProvider({
    acquire: async () => {
      acquisitions++;
      await new Promise((resolve) => setImmediate(resolve));
      return token({ expiresAt: Date.now() + 600_000 });
    },
  });

  await Promise.all(Array.from({ length: 50 }, () => auth.getToken()));

  assert.equal(acquisitions, 1, 'a reconnect must not ask the host fifty times');
});

test('a stale token is refreshed on the next call that needs it', async () => {
  let acquisitions = 0;
  const clock = new FakeClock(1_000_000);
  const auth = new AuthProvider({
    now: clock.now,
    acquire: async () => { acquisitions++; return token({ expiresAt: clock.now() + 120_000 }); },
  });

  await auth.getToken();
  clock.advance(100_000);
  await auth.getToken();

  assert.equal(acquisitions, 2);
});

test('refresh() forces a new token', async () => {
  let n = 0;
  const auth = new AuthProvider({ acquire: async () => token({ token: `t-${++n}` }) });

  await auth.getToken();
  const refreshed = await auth.refresh();

  assert.equal(refreshed.token, 't-2');
});

test('acquire returning nothing is an error, not a silent no-token', async () => {
  const auth = new AuthProvider({ acquire: async () => ({}) });
  await assert.rejects(() => auth.getToken(), /returned no token/);
});

test('revoke clears locally and tells the host', async () => {
  const revoked = [];
  const auth = new AuthProvider({
    acquire: async () => token(),
    revoke: async (t) => revoked.push(t.applicationId),
  });

  await auth.getToken();
  await auth.revoke();

  assert.deepEqual(revoked, ['app-1']);
  assert.equal(auth.store.get(), null);
});

test('the handshake carries the app token and nothing else', async () => {
  const auth = new AuthProvider({ acquire: async () => token() });

  const handshake = await auth.handshake({ applicationId: 'app-1', networkId: 'roomful' });

  assert.deepEqual(handshake, { token: 'app-token', applicationId: 'app-1', networkId: 'roomful' });
  await assert.rejects(() => auth.handshake({ sessionId: 'leak' }), /would send the user credential/);
});

test('write implies read; nothing else implies anything', async () => {
  const auth = new AuthProvider({ acquire: async () => token({ scopes: ['users:write'] }) });
  await auth.getToken();

  assert.equal(auth.hasScope('users:write'), true);
  assert.equal(auth.hasScope('users:read'), true);
  assert.equal(auth.hasScope('rooms:read'), false);
});

test('a wildcard scope holds everything', async () => {
  const auth = new AuthProvider({ acquire: async () => token({ scopes: ['*'] }) });
  await auth.getToken();

  assert.equal(auth.scopeAck(['commerce:write', 'rooms:read']), null);
});

test('a missing scope is a 403 naming what is missing and what is held', async () => {
  const auth = new AuthProvider({ acquire: async () => token({ scopes: ['users:read'] }) });
  await auth.getToken();

  const ack = auth.scopeAck(['commerce:write']);

  assert.equal(ack.error.code, ERROR_CODES.FORBIDDEN);
  assert.match(ack.error.message, /commerce:write/);
  assert.match(ack.error.description, /users:read/);
});

test('with no token there is no claim to check — the remote is the authority', () => {
  const auth = new AuthProvider({ acquire: async () => token() });
  assert.equal(auth.scopeAck(['anything:write']), null);
});
