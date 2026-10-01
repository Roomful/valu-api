// ===========================================================================
// The conformance suite.
//
// ONE suite, run against both adapters (test/conformance.test.js). Everything
// in here is a clause of the contract the 84 Phase 2 functions are written
// against: the ack envelope, the emit payload, the callbacks policy, the
// cache, the scope check, reconnect. If an adapter passes this, a function
// written against the SDK behaves the same wherever it runs.
//
// Phase 2 extends it per function; nothing here should need changing to do so.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceClient } from '../../src/services/ServiceClient.js';
import { ServiceRegistry } from '../../src/services/registry.js';
import { SocketTransport } from '../../src/transport/SocketTransport.js';
import { ServiceCache } from '../../src/cache/ServiceCache.js';
import { AuthProvider } from '../../src/auth/AuthProvider.js';
import { ERROR_CODES } from '../../src/Errors.js';
import { findDescriptor } from '../../src/services/descriptors.js';
import { Responder, FakeClock } from '../helpers/fakes.js';

/** A read and a write, taken from the real catalogue rather than invented. */
const READ = 'Users.get';
const WRITE = 'Users.send-connection-request';

/** Registry whose two handlers do what a Phase 2 handler will do: one emit. */
function testRegistry() {
  return new ServiceRegistry()
    .define(READ, (params, ctx) => ctx.socket.emit('social:getUsersSimpleInfo', { ids: [params.userId] }, ctx.timeoutMs))
    .define(WRITE, (params, ctx) => ctx.socket.emit('social:sendConnectionRequest', { userId: params.userId }, ctx.timeoutMs));
}

/**
 * @param {object} options
 * @param {string} options.name Adapter name, for the test titles.
 * @param {(responder: Responder) => {socket: object, push?: (payload: any) => void}} options.makeSocket
 */
export function runConformanceSuite({ name, makeSocket }) {
  const setup = ({ handlers = {}, clock = new FakeClock(), auth, cache } = {}) => {
    const responder = new Responder(handlers);
    const { socket, push } = makeSocket(responder);
    const transport = new SocketTransport({ socket, registry: testRegistry() });
    const client = new ServiceClient({
      transport,
      cache: cache === undefined ? new ServiceCache({ now: clock.now }) : cache,
      auth,
      hooks: { sleep: clock.sleep, random: () => 0.5 },
    });
    return { responder, socket, transport, client, clock, push };
  };

  test(`${name}: identity is on the socket`, () => {
    const { socket } = setup();
    assert.equal(typeof socket.userId, 'string');
    assert.equal(typeof socket.networkId, 'string');
    assert.ok(socket.selfUserId === null || typeof socket.selfUserId === 'string');
  });

  test(`${name}: a successful call resolves {data} and emits the PLAIN payload`, async () => {
    const { client, responder } = setup({
      handlers: { 'social:getUsersSimpleInfo': { data: { users: [{ id: 'u-9' }] } } },
    });

    const ack = await client.call(READ, { userId: 'u-9' });

    assert.deepEqual(ack.data, { users: [{ id: 'u-9' }] });
    assert.equal(ack.error, undefined);
    // Never `{data: {...}}`: a double-wrapped payload comes back as a
    // plausible-looking "not found" for something that exists.
    assert.deepEqual(responder.calls[0].data, { ids: ['u-9'] });
    assert.equal('data' in responder.calls[0].data, false);
  });

  test(`${name}: a remote failure resolves {error}, it does not reject`, async () => {
    const { client } = setup({
      handlers: { 'social:getUsersSimpleInfo': { error: { status: true, code: 404, message: 'Resource not found' } } },
    });

    const ack = await client.call(READ, { userId: 'nope' });

    assert.equal(ack.data, undefined);
    assert.equal(ack.error.code, 404);
    assert.equal(ack.error.message, 'Resource not found');
  });

  test(`${name}: invoke() throws what call() returns`, async () => {
    const { client } = setup({
      handlers: { 'social:getUsersSimpleInfo': { error: { status: true, code: 403, message: 'nope' } } },
    });

    await assert.rejects(
      () => client.invoke(READ, { userId: 'u-1' }),
      (error) => error.name === 'ValuServiceError' && error.code === 403 && error.service === 'Users',
    );
  });

  test(`${name}: a timeout is an ack with code 408, from either adapter`, async () => {
    const { client } = setup({ handlers: { 'social:getUsersSimpleInfo': 'timeout' } });

    const ack = await client.call(READ, { userId: 'u-1' }, { retries: 0 });

    assert.equal(ack.error.status, true);
    assert.equal(ack.error.code, ERROR_CODES.TIMEOUT);
  });

  test(`${name}: a lost connection is an ack with code 503`, async () => {
    const { client } = setup({ handlers: { 'social:getUsersSimpleInfo': 'disconnect' } });

    const ack = await client.call(READ, { userId: 'u-1' }, { retries: 0 });

    assert.equal(ack.error.code, ERROR_CODES.DISCONNECTED);
  });

  test(`${name}: a read retries twice, with backoff`, async () => {
    const attempts = [];
    const { client, clock } = setup({
      handlers: {
        'social:getUsersSimpleInfo': (_params, n) => {
          attempts.push(n);
          return n < 3 ? 'timeout' : { data: { users: [] } };
        },
      },
    });

    const ack = await client.call(READ, { userId: 'u-1' });

    assert.deepEqual(attempts, [1, 2, 3]);
    assert.deepEqual(ack.data, { users: [] });
    assert.deepEqual(clock.slept, [250, 500]);
  });

  test(`${name}: a write is never retried`, async () => {
    let attempts = 0;
    const { client, clock } = setup({
      handlers: { 'social:sendConnectionRequest': () => { attempts++; return 'timeout'; } },
    });

    const ack = await client.call(WRITE, { userId: 'u-2' });

    assert.equal(attempts, 1, 'a lost ack is not a lost request — re-sending a write acts twice');
    assert.equal(ack.error.code, ERROR_CODES.TIMEOUT);
    assert.deepEqual(clock.slept, []);
  });

  test(`${name}: a remote error is not retried`, async () => {
    let attempts = 0;
    const { client } = setup({
      handlers: {
        'social:getUsersSimpleInfo': () => { attempts++; return { error: { status: true, code: 404, message: 'gone' } }; },
      },
    });

    await client.call(READ, { userId: 'u-1' });
    assert.equal(attempts, 1);
  });

  test(`${name}: params are validated before the wire`, async () => {
    const { client, responder } = setup();

    const missing = await client.call(READ, {});
    const wrongType = await client.call(READ, { userId: 42 });
    const unknown = await client.call(READ, { userId: 'u-1', nope: true });

    assert.equal(missing.error.code, ERROR_CODES.INVALID_PARAMS);
    assert.match(missing.error.message, /missing required param "userId"/);
    assert.equal(wrongType.error.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal(unknown.error.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal(responder.calls.length, 0, 'nothing invalid reaches the socket');
  });

  test(`${name}: an unknown function is 404, not a socket call`, async () => {
    const { client, responder } = setup();

    const ack = await client.call('Users.teleport', {});

    assert.equal(ack.error.code, ERROR_CODES.UNKNOWN_FUNCTION);
    assert.equal(responder.calls.length, 0);
  });

  test(`${name}: an application-only intent is not in the catalogue at all`, async () => {
    const { client, responder } = setup();

    // `DataProvider.pick-single` is declared by the application and served
    // only by it. This package does not declare it, so it does not resolve —
    // the same answer a typo gets, which is the point of taking it out: there
    // is no half-state where a function exists but cannot run.
    const ack = await client.call('DataProvider.pick-single', { providers: ['contacts'] });
    assert.equal(ack.error.code, ERROR_CODES.UNKNOWN_FUNCTION);
    assert.match(ack.error.message, /unknown service function/);
    assert.equal(responder.calls.length, 0);
  });

  test(`${name}: a declared but unimplemented function says so`, async () => {
    // This registry holds two handlers on purpose, so every other declared
    // function is unimplemented in it. Phase 2 filled the DEFAULT registry;
    // the answer for an empty slot still has to name itself.
    const { client } = setup();

    const ack = await client.call('Rooms.get-room', { roomId: 'r-1' });

    assert.equal(ack.error.code, ERROR_CODES.UNSUPPORTED);
    assert.match(ack.error.message, /no implementation registered/);
  });

  test(`${name}: a read is served from cache, a write bypasses and invalidates it`, async () => {
    const { client, responder } = setup({
      handlers: {
        'social:getUsersSimpleInfo': { data: { users: [{ id: 'u-1' }] } },
        'social:sendConnectionRequest': { data: { ok: true } },
      },
    });

    await client.call(READ, { userId: 'u-1' });
    await client.call(READ, { userId: 'u-1' });
    assert.equal(responder.callsTo('social:getUsersSimpleInfo').length, 1, 'second read is cached');

    await client.call(WRITE, { userId: 'u-1' });
    assert.equal(responder.callsTo('social:sendConnectionRequest').length, 1, 'a write always goes out');

    await client.call(READ, { userId: 'u-1' });
    assert.equal(responder.callsTo('social:getUsersSimpleInfo').length, 2, 'the write invalidated the read');
  });

  test(`${name}: a write that FAILED still invalidates`, async () => {
    const { client, responder } = setup({
      handlers: {
        'social:getUsersSimpleInfo': { data: { users: [] } },
        'social:sendConnectionRequest': 'timeout',
      },
    });

    await client.call(READ, { userId: 'u-1' });
    await client.call(WRITE, { userId: 'u-1' });
    await client.call(READ, { userId: 'u-1' });

    assert.equal(responder.callsTo('social:getUsersSimpleInfo').length, 2,
      'a lost ack is not a lost request — the write may have landed');
  });

  test(`${name}: a cache entry expires`, async () => {
    const { client, responder, clock } = setup({
      handlers: { 'social:getUsersSimpleInfo': { data: { users: [] } } },
    });

    await client.call(READ, { userId: 'u-1' });
    clock.advance(findDescriptor(READ).cache.ttlMs + 1);
    await client.call(READ, { userId: 'u-1' });

    assert.equal(responder.callsTo('social:getUsersSimpleInfo').length, 2);
  });

  test(`${name}: a failed read is not cached`, async () => {
    const { client, responder } = setup({
      handlers: {
        'social:getUsersSimpleInfo': (_p, n) => (n === 1
          ? { error: { status: true, code: 500, message: 'bad moment' } }
          : { data: { users: [] } }),
      },
    });

    const first = await client.call(READ, { userId: 'u-1' });
    const second = await client.call(READ, { userId: 'u-1' });

    assert.equal(first.error.code, 500);
    assert.deepEqual(second.data, { users: [] }, 'one bad moment is not a TTL of bad moments');
  });

  test(`${name}: bypassCache goes to the socket`, async () => {
    const { client, responder } = setup({
      handlers: { 'social:getUsersSimpleInfo': { data: { users: [] } } },
    });

    await client.call(READ, { userId: 'u-1' });
    await client.call(READ, { userId: 'u-1' }, { bypassCache: true });

    assert.equal(responder.callsTo('social:getUsersSimpleInfo').length, 2);
  });

  test(`${name}: a seeded entry answers without a call`, async () => {
    const { client, responder } = setup();

    client.seed(READ, { userId: 'u-7' }, { users: [{ id: 'u-7', seeded: true }] });
    const ack = await client.call(READ, { userId: 'u-7' });

    assert.equal(ack.data.users[0].seeded, true);
    assert.equal(responder.calls.length, 0, 'parity is not identical behaviour: a seeded read makes no call');
  });

  test(`${name}: a scope the token lacks is 403, before the wire`, async () => {
    const auth = new AuthProvider({
      acquire: async () => ({ token: 't', expiresAt: Date.now() + 60_000, scopes: ['events:read'] }),
    });
    await auth.getToken();
    const { client, responder } = setup({ auth });

    const ack = await client.call(READ, { userId: 'u-1' });

    assert.equal(ack.error.code, ERROR_CODES.FORBIDDEN);
    assert.match(ack.error.message, /users:read/);
    assert.equal(responder.calls.length, 0);
  });

  test(`${name}: reconnect drops the cache and tells subscribers`, async () => {
    const { client, transport, responder, socket } = setup({
      handlers: { 'social:getUsersSimpleInfo': { data: { users: [] } } },
    });
    const seen = [];
    client.subscribe('reconnected', (data) => seen.push(data));

    await client.call(READ, { userId: 'u-1' });
    transport.handleReconnect(socket);
    await client.call(READ, { userId: 'u-1' });

    assert.equal(seen.length, 1);
    assert.equal(responder.callsTo('social:getUsersSimpleInfo').length, 2, 'nothing cached survives the gap');
  });

  test(`${name}: a throwing subscriber does not take the others down`, () => {
    const { client, transport } = setup();
    const seen = [];
    client.subscribe('reconnected', () => { throw new Error('boom'); });
    client.subscribe('reconnected', () => seen.push('ok'));

    transport.handleReconnect();

    assert.deepEqual(seen, ['ok']);
  });

  test(`${name}: unsubscribe stops delivery`, () => {
    const { client, transport } = setup();
    const seen = [];
    const off = client.subscribe('reconnected', () => seen.push('x'));

    transport.handleReconnect();
    off();
    transport.handleReconnect();

    assert.equal(seen.length, 1);
  });
}

/**
 * Push is optional on the contract, so it is asserted only for adapters whose
 * transport has it — the rest must fall back to polling, which is exactly what
 * `supportsPush === false` tells a consumer.
 */
export function runPushSuite({ name, makeSocket }) {
  test(`${name}: a resource:updated push invalidates the cache and reaches subscribers`, async () => {
    const responder = new Responder({ 'social:getUsersSimpleInfo': { data: { users: [] } } });
    const { socket, push } = makeSocket(responder);
    const transport = new SocketTransport({ socket, registry: testRegistry() });
    const client = new ServiceClient({ transport });
    const seen = [];
    client.subscribe('resource:updated', (data) => seen.push(data));

    assert.equal(transport.supportsPush, true);
    await client.call(READ, { userId: 'u-1' });
    push({ id: 'u-1' });
    await client.call(READ, { userId: 'u-1' });

    assert.deepEqual(seen, [{ id: 'u-1' }]);
    assert.equal(responder.callsTo('social:getUsersSimpleInfo').length, 2);
  });
}
