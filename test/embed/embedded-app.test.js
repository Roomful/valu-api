// ===========================================================================
// createValuApp in embedded mode: an app framed by Valu Social calls valu-api's
// service functions over the postMessage bridge (`api:call`), which Valu Social
// answers with its frame server (`api:call-completed`), once its `api:ready` has
// said `valuApi.calls`.
//
// The page and Valu Social are a FakeWindowPair: `valuSocial` is the parent,
// `frame` the app's window (`frame.parent === valuSocial`). What the app posts
// is a call ON `valuSocial` (`valuSocial.posted`); Valu Social answers with
// `frame.postMessage(...)`. The clock is the test's.
// ===========================================================================
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createValuApp } from '../../src/ValuApi.js';
import { HostTransport } from '../../src/transport/HostTransport.js';
import { EMBEDDED_PROTOCOL_VERSION, MSG, toParent } from '../../src/host/protocol.js';
import { findDescriptor } from '../../src/services/descriptors.js';
import { FakeWindowPair, fakeClock, fakeDocumentFor } from '../helpers/hostFakes.js';

const VALU_SOCIAL = 'https://live.valuverse.io';
const FRAME = 'https://demo-ws-1.valuguru.app';
const USER = { id: 'u1', name: 'Ada Lovelace' };
const NETWORK = { id: 'n1', name: 'Roomful' };
const VALU_API = { protocol: 1, calls: true, user: USER, network: NETWORK };
const READY_TIMEOUT_MS = 10_000;

const settle = () => new Promise((resolve) => { setImmediate(resolve); });

/** A promise's outcome, tracked from the moment it is made (so a rejection is never unhandled). */
function track(promise) {
  const box = { settled: false, value: undefined, error: undefined };
  promise.then(
    (value) => { box.settled = true; box.value = value; },
    (error) => { box.settled = true; box.error = error; },
  );
  return box;
}

/** `window.open`, recorded. */
function fakePopups() {
  const open = (url, name, features) => {
    open.calls.push({ url, name, features });
    return { closed: false, close() {} };
  };
  open.calls = [];
  return open;
}

/**
 * A page framed by Valu Social. `answer(message)` is what Valu Social answers an
 * `api:call` with (`null`: it does not answer, the test does with `reply`).
 */
function framed(t, { answer = () => ({ data: { ok: true } }), activation = false, ...options } = {}) {
  const { app: valuSocial, host: frame } = FakeWindowPair({ appOrigin: VALU_SOCIAL, hostOrigin: FRAME });
  frame.location = { search: '' };
  frame.navigator = { userActivation: { isActive: activation } };
  const clock = fakeClock();
  const popups = fakePopups();
  const h = {
    valuSocial, frame, clock, popups, answer, valu: null,
    /** Valu Social posts to the frame. */
    send: (name, message, requestId) => frame.postMessage(toParent(name, message, requestId), FRAME),
    /** Valu Social's `api:ready`: with `VALU_API` when called with nothing, with no `valuApi` key for `undefined`. */
    ready: (...args) => {
      const valuApi = args.length === 0 ? VALU_API : args[0];
      h.send(MSG.READY, { applicationId: 'app-1', action: 'open', params: {}, ...(valuApi === undefined ? {} : { valuApi }) });
    },
    /** Every message the app posted to Valu Social: `{name, message}` with the target origin. */
    posts: () => valuSocial.posted.map((post) => ({ ...post.data, targetOrigin: post.targetOrigin })),
    calls: () => h.posts().filter((post) => post.name === MSG.CALL),
    reply: (requestId, ack) => h.send(MSG.CALL_COMPLETED, ack, requestId),
    create: () => createValuApp({
      window: frame,
      document: { createElement() { throw new Error('embedded mode makes no iframe'); } },
      popup: popups,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      ...options,
    }),
  };
  valuSocial.addEventListener('message', ({ data, source, origin }) => {
    if (source !== frame || origin !== FRAME || data?.name !== MSG.CALL) return;
    const ack = h.answer(data.message);
    if (ack !== null) h.reply(data.message.requestId, ack);
  });
  t.after(() => h.valu?.close());
  return h;
}

async function setup(t, options) {
  const h = framed(t, options);
  h.valu = await h.create();
  return h;
}

/** What `HostTransport` posts for the same call: the message of its `api:call`. */
async function hostTransportCall(key, params, options) {
  const pair = FakeWindowPair();
  const clock = fakeClock();
  let message;
  pair.host.addEventListener('message', ({ data }) => {
    if (data.name === MSG.HELLO) {
      pair.app.postMessage(toParent(MSG.READY, {
        applicationId: 'ws_1/demo', action: 'start', params: {}, host: { protocol: 1, mode: 'dedicated', signedIn: true, user: USER, network: NETWORK },
      }), pair.app.origin);
    }
    if (data.name === MSG.CALL) {
      message = data.message;
      pair.app.postMessage(toParent(MSG.CALL_COMPLETED, { data: {} }, data.message.requestId), pair.app.origin);
    }
  });
  const transport = new HostTransport({
    hostOrigin: 'https://valuguru.texpo.io', window: pair.app, document: fakeDocumentFor(pair),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  await transport.open();
  await transport.callService(findDescriptor(key), params, options);
  await transport.close();
  return message;
}

// ---------------------------------------------------------------------------
// Calls over the bridge
// ---------------------------------------------------------------------------

test('a service function goes to Valu Social as api:call once api:ready says valuApi.calls, and the reply is the ack', async (t) => {
  const h = await setup(t, { answer: () => ({ data: { user: USER } }) });
  h.ready();

  const ack = await h.valu.Users.current();

  assert.deepEqual(ack, { data: { user: USER } });
  const [post] = h.calls();
  assert.equal(post.targetOrigin, VALU_SOCIAL, 'to the parent\'s origin, never a wildcard');
  assert.deepEqual(post.message, {
    service: 'Users', action: 'current', params: {}, requestId: post.message.requestId, timeoutMs: 30_000,
  });
  assert.equal(typeof post.message.requestId, 'number');
});

test('the api:call is byte-identical to what HostTransport posts for the same call', async (t) => {
  const h = await setup(t);
  h.ready();
  await h.valu.Rooms.searchMyRooms({ filter: 'all' }, { timeoutMs: 12_000 });
  const embedded = h.calls()[0].message;
  const dedicated = await hostTransportCall('Rooms.search-my-rooms', { filter: 'all' }, { timeoutMs: 12_000, attempt: 1 });

  assert.deepEqual(Object.keys(embedded), Object.keys(dedicated), 'the same keys in the same order');
  assert.deepEqual({ ...embedded, requestId: 0 }, { ...dedicated, requestId: 0 });
  assert.deepEqual(Object.keys(embedded), ['service', 'action', 'params', 'requestId', 'timeoutMs']);
});

test('a call made before api:ready is held for it, and posted when it comes', async (t) => {
  const h = await setup(t);
  const pending = track(h.valu.Users.current());
  await settle();
  assert.equal(h.posts().length, 0, 'nothing is posted before api:ready');
  assert.equal(pending.settled, false);

  h.ready();
  await settle();
  assert.equal(h.calls().length, 1);
  assert.deepEqual(pending.value, { data: { ok: true } });
});

test('a held call that outlives its own timeout answers 408 and is never posted', async (t) => {
  const h = await setup(t);
  const pending = track(h.valu.call('Users.get', { userId: 'u-9' }, { timeoutMs: 2_000, retries: 0 }));
  h.clock.tick(2_000);
  await settle();
  assert.deepEqual(pending.value, { error: { status: true, code: 408, message: 'timeout' } });

  h.ready();
  await settle();
  assert.equal(h.calls().length, 0, 'the call that timed out was dropped, not sent late');
});

test('a posted call that outlives its timeout answers 408; a write says it may still apply', async (t) => {
  const h = await setup(t, { answer: () => null });
  h.ready();
  const read = track(h.valu.call('Users.get', { userId: 'u-9' }, { timeoutMs: 1_000, retries: 0 }));
  const write = track(h.valu.Users.sendConnectionRequest({ userId: 'u-3' }, { timeoutMs: 1_000 }));
  await settle();
  assert.equal(h.calls().length, 2);
  h.clock.tick(1_000);
  await settle();
  assert.deepEqual(read.value, { error: { status: true, code: 408, message: 'timeout' } });
  assert.deepEqual(write.value, { error: { status: true, code: 408, message: 'timeout', retryable: false } });

  // The late answers settle nothing and break nothing.
  for (const post of h.calls()) h.reply(post.message.requestId, { data: 'late' });
  await settle();
});

test('without valuApi.calls (an older Valu Social) the service tree answers 501 as before, and posts nothing', async (t) => {
  for (const valuApi of [undefined, { protocol: 1, calls: false }, { protocol: 2, calls: true }, 'calls', null]) {
    const h = await setup(t);
    const held = track(h.valu.Users.current());
    h.ready(valuApi);
    await settle();
    const ack = await h.valu.Users.current();
    assert.equal(ack.error.code, 501, JSON.stringify(valuApi));
    assert.match(ack.error.message, /^Users\.current is not available in embedded mode: the embedding application serves intents \(callService\), not service functions$/);
    assert.deepEqual(held.value, ack, 'a call held for api:ready gets the same answer');
    assert.equal((await h.valu.data.Users.current().catch((error) => error)).code, 501);
    assert.equal(h.calls().length, 0);
  }
});

test('the client takes the embedded protocol\'s own version (another one is 501, above)', async (t) => {
  const h = await setup(t);
  h.ready({ ...VALU_API, protocol: EMBEDDED_PROTOCOL_VERSION });
  assert.deepEqual(await h.valu.Users.current(), { data: { ok: true } });
  assert.equal(h.calls().length, 1);
});

test('local functions run in the page, before api:ready and without valuApi.calls, and never reach Valu Social', async (t) => {
  const h = await setup(t);
  const ack = await h.valu.Time.getLocalTime();
  assert.equal(ack.error, undefined);
  h.ready(undefined);
  assert.equal((await h.valu.Time.getLocalTime()).error, undefined);
  assert.equal(h.posts().length, 0);
});

test('fetchImpl and localTransport reach the local functions in embedded mode too', async (t) => {
  const requests = [];
  const withFetch = await setup(t, {
    fetchImpl: async (url, init) => { requests.push({ url, method: init.method }); return { status: 204, ok: true }; },
  });
  const ack = await withFetch.valu.Http.ping({ url: 'https://app.test/health' });
  assert.deepEqual(requests, [{ url: 'https://app.test/health', method: 'HEAD' }]);
  assert.equal(ack.error, undefined);

  const answers = [];
  const withLocal = await setup(t, {
    localTransport: { callService: async (descriptor) => { answers.push(descriptor.key); return { data: 'local' }; } },
  });
  assert.deepEqual(await withLocal.valu.Time.getLocalTime(), { data: 'local' });
  assert.deepEqual(answers, ['Time.get-local-time']);
});

test('by-name calls and the unwrapped tree go over the bridge too', async (t) => {
  const h = await setup(t, { answer: (message) => ({ data: { asked: `${message.service}.${message.action}` } }) });
  h.ready();
  assert.deepEqual(await h.valu.call('Rooms.searchMyRooms', { filter: 'all' }), { data: { asked: 'Rooms.search-my-rooms' } });
  assert.deepEqual(await h.valu.invoke('Users.get', { userId: 'u-1' }), { asked: 'Users.get' });
  assert.deepEqual(await h.valu.data.Users.current(), { asked: 'Users.current' });
  assert.equal((await h.valu.call('Nope.nothing')).error.code, 404, 'a name that is no function is still a 404, and not posted');
  assert.equal(h.calls().length, 3);
});

test('a refusal Valu Social answers is the answer, as the host\'s is', async (t) => {
  const refusal = { error: { status: true, code: 400, message: 'userId is required' } };
  const h = await setup(t, { answer: () => refusal });
  h.ready();
  assert.deepEqual(await h.valu.call('Users.get', { userId: 'u-9' }, { retries: 0 }), refusal);
});

test('a reply that is not an ack is 503 host_unreachable; one from another window settles nothing', async (t) => {
  const h = await setup(t, { answer: () => null });
  h.ready();
  const call = track(h.valu.call('Users.get', { userId: 'u-9' }, { retries: 0 }));
  await settle();
  const { requestId } = h.calls()[0].message;

  // A third window that knows the request id.
  h.frame.dispatch({ data: toParent(MSG.CALL_COMPLETED, { data: 'forged' }, requestId), origin: VALU_SOCIAL, source: { postMessage() {} } });
  await settle();
  assert.equal(call.settled, false);

  h.reply(requestId, 'not an ack');
  await settle();
  assert.deepEqual(call.value, { error: { status: true, code: 503, message: 'host_unreachable' } });
});

test('a consent_required answer is retried once from a user gesture (requestConsent says yes inside Valu Social)', async (t) => {
  let refused = 0;
  const answer = () => {
    if (refused === 0) {
      refused += 1;
      return { error: { status: true, code: 403, message: 'consent_required', scope: 'rooms:read' } };
    }
    return { data: { rooms: [] } };
  };
  const inGesture = await setup(t, { answer, activation: true });
  inGesture.ready();
  assert.deepEqual(await inGesture.valu.Rooms.searchMyRooms({ filter: 'all' }), { data: { rooms: [] } });
  assert.equal(inGesture.calls().length, 2);
  assert.equal(inGesture.popups.calls.length, 0, 'nothing is opened inside Valu Social');

  refused = 0;
  const outside = await setup(t, { answer });
  outside.ready();
  assert.equal((await outside.valu.Rooms.searchMyRooms({ filter: 'all' })).error.message, 'consent_required');
  assert.equal(outside.calls().length, 1);
});

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

test('auth.state is Valu Social\'s user and network from valuApi, in the dedicated shape', async (t) => {
  const h = await setup(t);
  assert.deepEqual(h.valu.auth.state, { signedIn: false, user: null, network: null }, 'nothing is known before api:ready');

  h.ready({ ...VALU_API, user: { ...USER, email: 'ada@example.test' }, network: { id: 'n1' } });
  assert.deepEqual(h.valu.auth.state, { signedIn: true, user: USER, network: { id: 'n1', name: null } });
  assert.deepEqual(h.valu.network, { id: 'n1', name: null });
});

test('auth.state: no user is signed out, whatever else valuApi says', async (t) => {
  for (const valuApi of [{ ...VALU_API, user: null }, { ...VALU_API, user: { name: 'no id' } }, undefined]) {
    const h = await setup(t);
    h.ready(valuApi);
    assert.equal(h.valu.auth.state.signedIn, false, JSON.stringify(valuApi));
    assert.equal(h.valu.auth.state.user, null);
  }
});

test('auth change: on the api:ready that says who the user is, and on a later one that says someone else', async (t) => {
  const h = await setup(t);
  const changes = [];
  h.valu.auth.on('change', (state) => changes.push(state));

  h.ready();
  assert.deepEqual(changes, [{ signedIn: true, user: USER, network: NETWORK }]);
  h.ready();
  assert.equal(changes.length, 1, 'the same user again is no change');
  h.ready({ ...VALU_API, user: { id: 'u2', name: 'Grace' } });
  assert.deepEqual(changes.at(-1), { signedIn: true, user: { id: 'u2', name: 'Grace' }, network: NETWORK });

  const signedOut = await setup(t);
  const none = [];
  signedOut.valu.auth.on('change', (state) => none.push(state));
  signedOut.ready({ ...VALU_API, user: null, network: null });
  assert.deepEqual(none, [], 'signed out before, signed out now');
});

test('signIn resolves the state when Valu Social has a user, and opens nothing', async (t) => {
  const h = await setup(t);
  h.ready();
  assert.deepEqual(await h.valu.auth.signIn(), { signedIn: true, user: USER, network: NETWORK });
  assert.equal(h.popups.calls.length, 0);
  assert.equal(h.posts().length, 0);
});

test('signIn rejects not_available when Valu Social has no user, and opens nothing', async (t) => {
  const h = await setup(t);
  h.ready({ ...VALU_API, user: null });
  await assert.rejects(h.valu.auth.signIn(), { code: 'not_available' });
  const older = await setup(t);
  older.ready(undefined);
  await assert.rejects(older.valu.auth.signIn(), { code: 'not_available' });
  assert.equal(h.popups.calls.length + older.popups.calls.length, 0);
});

test('signIn before api:ready waits for it; with no api:ready it rejects host_unreachable', async (t) => {
  const h = await setup(t);
  const signIn = track(h.valu.auth.signIn());
  await settle();
  assert.equal(signIn.settled, false);
  h.ready();
  await settle();
  assert.equal(signIn.value.signedIn, true);

  const lost = await setup(t);
  const never = track(lost.valu.auth.signIn());
  lost.clock.tick(READY_TIMEOUT_MS);
  await settle();
  assert.equal(never.error.code, 'host_unreachable');
});

test('requestConsent resolves true inside Valu Social: nothing is asked, posted or opened', async (t) => {
  const h = await setup(t);
  assert.equal(await h.valu.auth.requestConsent(['rooms:read']), true, 'before api:ready too');
  h.ready();
  assert.equal(await h.valu.auth.requestConsent(['rooms:read', 'rooms:write']), true);
  assert.equal(h.posts().length, 0);
  assert.equal(h.popups.calls.length, 0);
});

test('requestConsent refuses a bad argument the way dedicated mode does', async (t) => {
  const h = await setup(t);
  h.ready();
  for (const scopes of [undefined, [], 'rooms:read', [''], [5], null]) {
    await assert.rejects(h.valu.auth.requestConsent(scopes), TypeError, JSON.stringify(scopes));
  }
});

test('signOut rejects not_available: an app cannot sign the user out of Valu Social', async (t) => {
  const h = await setup(t);
  h.ready();
  await assert.rejects(h.valu.auth.signOut(), { code: 'not_available' });
  assert.equal(h.posts().length, 0);
});

test('after close, signIn and requestConsent reject closed', async (t) => {
  const h = await setup(t);
  h.ready();
  await h.valu.close();
  await assert.rejects(h.valu.auth.signIn(), { code: 'closed' });
  await assert.rejects(h.valu.auth.requestConsent(['rooms:read']), { code: 'closed' });
});

// ---------------------------------------------------------------------------
// ready, and a frame that is not Valu Social
// ---------------------------------------------------------------------------

test('ready rejects host_unreachable when no api:ready comes within readyTimeoutMs (default 10 s)', async (t) => {
  const h = await setup(t);
  const ready = track(h.valu.ready);
  const changes = [];
  h.valu.connection.on('change', (change) => changes.push(change));
  h.clock.tick(READY_TIMEOUT_MS - 1);
  await settle();
  assert.equal(ready.settled, false);
  h.clock.tick(1);
  await settle();
  assert.equal(ready.error.code, 'host_unreachable');
  assert.ok(ready.error instanceof Error);
  assert.equal(h.valu.connection.state, 'offline');
  assert.deepEqual(h.valu.connection.lastError, { code: 'host_unreachable' });
  assert.deepEqual(changes, [{ state: 'offline', reconnected: false, lastError: { code: 'host_unreachable' } }]);
});

test('readyTimeoutMs sets the wait; a value that is not a positive number is refused', async (t) => {
  const h = await setup(t, { readyTimeoutMs: 500 });
  const ready = track(h.valu.ready);
  h.clock.tick(500);
  await settle();
  assert.equal(ready.error.code, 'host_unreachable');

  for (const readyTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '500', null]) {
    await assert.rejects(framed(t, { readyTimeoutMs }).create(), TypeError, String(readyTimeoutMs));
  }

  // One longer than a timer can hold would fire at once: it is held to the longest one.
  const long = await setup(t, { readyTimeoutMs: 1e12 });
  const waiting = track(long.valu.ready);
  long.clock.tick(2_147_483_646);
  await settle();
  assert.equal(waiting.settled, false);
  long.clock.tick(1);
  await settle();
  assert.equal(waiting.error.code, 'host_unreachable');
});

test('when ready expires, held calls answer 503 host_unreachable (retryable), and so does a call made then, at once', async (t) => {
  const h = await setup(t);
  const held = track(h.valu.call('Users.get', { userId: 'u-9' }, { timeoutMs: 60_000, retries: 0 }));
  h.clock.tick(READY_TIMEOUT_MS);
  await settle();
  const unreachable = { error: { status: true, code: 503, message: 'host_unreachable', retryable: true } };
  assert.deepEqual(held.value, unreachable);
  assert.deepEqual(await h.valu.call('Users.get', { userId: 'u-9' }, { retries: 0 }), unreachable);
  assert.equal(h.posts().length, 0);
});

test('a late api:ready leaves ready rejected but serves calls from then on, and logs nothing', async (t) => {
  const error = mock.method(console, 'error', () => {});
  const warn = mock.method(console, 'warn', () => {});
  t.after(() => { error.mock.restore(); warn.mock.restore(); });

  const h = await setup(t);
  const ready = track(h.valu.ready);
  const changes = [];
  h.valu.connection.on('change', (change) => changes.push(change.state));
  h.clock.tick(READY_TIMEOUT_MS);
  await settle();
  assert.equal(ready.error.code, 'host_unreachable');

  h.ready();
  await settle();
  assert.equal(ready.error.code, 'host_unreachable', 'the promise is settled');
  assert.equal(h.valu.connection.state, 'ready');
  assert.equal(h.valu.connection.lastError, null);
  assert.deepEqual(changes, ['offline', 'ready']);
  assert.equal(h.valu.auth.state.signedIn, true);
  assert.deepEqual(await h.valu.Users.current(), { data: { ok: true } });
  assert.equal(error.mock.callCount() + warn.mock.callCount(), 0);
});

test('an app that never reads ready is not an unhandled rejection', async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const h = await setup(t);
  h.clock.tick(READY_TIMEOUT_MS);
  await settle();
  await settle();
  assert.deepEqual(unhandled, []);
});

test('close answers what is waiting, rejects a pending ready with closed, and leaves no timer', async (t) => {
  const h = await setup(t);
  const ready = track(h.valu.ready);
  const held = track(h.valu.call('Users.get', { userId: 'u-9' }, { retries: 0 }));
  await h.valu.close();
  await settle();
  assert.equal(ready.error.code, 'closed');
  assert.deepEqual(held.value, { error: { status: true, code: 503, message: 'transport closed' } });
  assert.equal(h.clock.pending, 0);
  assert.equal(h.frame.listeners.size, 0);

  const inFlight = await setup(t, { answer: () => null });
  inFlight.ready();
  const posted = track(inFlight.valu.call('Users.get', { userId: 'u-9' }, { retries: 0 }));
  await settle();
  await inFlight.valu.close();
  await settle();
  assert.deepEqual(posted.value, { error: { status: true, code: 503, message: 'transport closed' } });
  assert.equal(inFlight.clock.pending, 0);
});

test('ready resolves on api:ready, and the connection is ready', async (t) => {
  const h = await setup(t);
  const ready = track(h.valu.ready);
  h.ready();
  await settle();
  assert.equal(ready.settled, true);
  assert.equal(ready.error, undefined);
  assert.equal(h.valu.connection.state, 'ready');
  h.clock.tick(READY_TIMEOUT_MS);
  await settle();
  assert.equal(h.valu.connection.state, 'ready', 'the ready timer is gone once api:ready came');
  assert.equal(h.clock.pending, 0);
});

// ---------------------------------------------------------------------------
// Dedicated mode reads readyTimeoutMs too
// ---------------------------------------------------------------------------

test('readyTimeoutMs bounds the dedicated handshake too: createValuApp rejects host_unreachable after it', async () => {
  const pair = FakeWindowPair();
  pair.app.location = { search: '' };
  pair.app.navigator = {};
  const clock = fakeClock();
  const created = track(createValuApp({
    window: pair.app, document: fakeDocumentFor(pair), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, readyTimeoutMs: 3_000,
  }));
  await settle();
  clock.tick(2_999);
  await settle();
  assert.equal(created.settled, false);
  clock.tick(1);
  await settle();
  assert.equal(created.error.code, 'host_unreachable');
});
