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
import { DEFAULT_SIGN_IN_ORIGINS } from '../../src/host/Host.js';
import { Intent } from '../../src/Intent.js';
import { EMBEDDED_PROTOCOL_VERSION, MSG, toParent } from '../../src/host/protocol.js';
import { findDescriptor } from '../../src/services/descriptors.js';
import { VERSION } from '../../src/version.js';
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
function framed(t, { answer = () => ({ data: { ok: true } }), activation = false, parentOrigin = VALU_SOCIAL, ...options } = {}) {
  const { app: valuSocial, host: frame } = FakeWindowPair({ appOrigin: parentOrigin, hostOrigin: FRAME });
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
    service: 'Users', action: 'current', params: {}, requestId: post.message.requestId, timeoutMs: 30_000, client: VERSION,
  });
  assert.equal(typeof post.message.requestId, 'number');
});

// The one difference: the bridge stamps `client` (the package version) on every
// message it posts, so Valu Social can count which valu-api each app runs. The
// host learns it from `host:hello` instead.
test('the api:call is byte-identical to what HostTransport posts for the same call, plus the client version', async (t) => {
  const h = await setup(t);
  h.ready();
  await h.valu.Rooms.searchMyRooms({ filter: 'all' }, { timeoutMs: 12_000 });
  const { client, ...embedded } = h.calls()[0].message;
  const dedicated = await hostTransportCall('Rooms.search-my-rooms', { filter: 'all' }, { timeoutMs: 12_000, attempt: 1 });

  assert.equal(client, VERSION);
  assert.deepEqual(Object.keys(embedded), Object.keys(dedicated), 'the same keys in the same order');
  assert.deepEqual({ ...embedded, requestId: 0 }, { ...dedicated, requestId: 0 });
  assert.deepEqual(Object.keys(h.calls()[0].message), ['service', 'action', 'params', 'requestId', 'timeoutMs', 'client']);
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
// Whom the app trusts with valuApi
// ---------------------------------------------------------------------------

test('valuApi is honoured from each origin the host trusts for sign-in: calls and identity', async (t) => {
  assert.deepEqual([...DEFAULT_SIGN_IN_ORIGINS], [
    'https://live.valuverse.io', 'https://valu-social.com', 'https://chabaduniverse.com', 'https://texpo.io',
  ]);
  for (const parentOrigin of DEFAULT_SIGN_IN_ORIGINS) {
    const h = await setup(t, { parentOrigin });
    h.ready();
    assert.deepEqual(h.valu.auth.state, { signedIn: true, user: USER, network: NETWORK }, parentOrigin);
    assert.deepEqual(await h.valu.Users.current(), { data: { ok: true } }, parentOrigin);
    assert.equal(h.calls()[0].targetOrigin, parentOrigin);
  }
});

test('an untrusted parent keeps today\'s embedded mode: the bridge binds, the tree is 501, the user is signed out', async (t) => {
  const h = await setup(t, { parentOrigin: 'https://evil.example', answer: () => ({ data: 'forged' }) });
  const ready = track(h.valu.ready);
  const authChanges = [];
  h.valu.auth.on('change', (state) => authChanges.push(state));
  h.ready();
  await settle();

  // The bridge is bound as before: ready, the connection, the intents.
  assert.equal(ready.settled, true);
  assert.equal(ready.error, undefined);
  assert.equal(h.valu.connection.state, 'ready');
  const intent = track(h.valu.callService(new Intent('Weather', 'forecast-tomorrow', { city: 'Kyiv' })));
  const posted = h.posts().at(-1);
  assert.equal(posted.name, 'api:service-intent');
  h.send('api:run-console-completed', { c: 21 }, posted.message.requestId);
  await settle();
  assert.deepEqual(intent.value, { c: 21 });

  // What it says of valu-api is not taken: no calls, no user.
  assert.deepEqual(h.valu.auth.state, { signedIn: false, user: null, network: null });
  assert.equal(h.valu.network, null);
  assert.deepEqual(authChanges, []);
  const ack = await h.valu.Users.current();
  assert.equal(ack.error.code, 501);
  assert.match(ack.error.message, /is not available in embedded mode/);
  await assert.rejects(h.valu.auth.signIn(), { code: 'not_available' });
  assert.equal(h.calls().length, 0, 'nothing is posted as api:call');
});

test('a local Valu Social is not trusted by default', async (t) => {
  const h = await setup(t, { parentOrigin: 'http://localhost:3005' });
  h.ready();
  assert.equal(h.valu.auth.state.signedIn, false);
  assert.equal((await h.valu.Users.current()).error.code, 501);
  assert.equal(h.calls().length, 0);
});

test('hostOrigins, when given, is the whole list: a local Valu Social works, a default origin no longer counts', async (t) => {
  const local = await setup(t, { parentOrigin: 'http://localhost:3005', hostOrigins: ['http://localhost:3005'] });
  local.ready();
  assert.deepEqual(local.valu.auth.state, { signedIn: true, user: USER, network: NETWORK });
  assert.deepEqual(await local.valu.Users.current(), { data: { ok: true } });
  assert.equal(local.calls().length, 1);

  // A default origin that is not on the list does not even bind the bridge.
  const listedOut = await setup(t, { parentOrigin: 'https://live.valuverse.io', hostOrigins: ['http://localhost:3005'] });
  const ready = track(listedOut.valu.ready);
  listedOut.ready();
  await settle();
  assert.equal(ready.settled, false);
  assert.equal(listedOut.valu.auth.state.signedIn, false);
  listedOut.clock.tick(READY_TIMEOUT_MS);
  await settle();
  assert.equal(ready.error.code, 'host_unreachable');

  const both = await setup(t, { parentOrigin: 'https://live.valuverse.io', hostOrigins: ['http://localhost:3005', 'https://live.valuverse.io'] });
  both.ready();
  assert.equal(both.valu.auth.state.signedIn, true);
});

// The matching is exact, on the origin the bridge is bound to: a look-alike is a stranger.
for (const parentOrigin of [
  'https://live.valuverse.io.evil.com', // a trusted name as a prefix
  'https://evil.live.valuverse.io', // a subdomain of a trusted origin
  'http://live.valuverse.io', // the trusted host on another scheme
  'https://live.valuverse.io:8443', // the trusted host on another port
  'null', // an opaque origin (a sandboxed frame, a data: URL)
  'https://LIVE.valuverse.io', // not how a browser writes an origin
  'https://live.valuverse.io/', // nor this
]) {
  test(`trusted-origin matching is exact: ${parentOrigin} gets 501, signed out, and no api:call`, async (t) => {
    const h = await setup(t, { parentOrigin });
    h.ready();
    await settle();
    assert.deepEqual(h.valu.auth.state, { signedIn: false, user: null, network: null });
    const ack = await h.valu.Users.current();
    assert.equal(ack.error.code, 501);
    assert.match(ack.error.message, /is not available in embedded mode/);
    assert.equal(h.calls().length, 0);
  });
}

test('hostOrigins: [] admits none: the bridge never binds, ready gives up, and nothing is posted', async (t) => {
  const h = await setup(t, { parentOrigin: 'https://live.valuverse.io', hostOrigins: [] });
  const ready = track(h.valu.ready);
  h.ready();
  await settle();
  assert.equal(ready.settled, false);
  assert.equal(h.valu.auth.state.signedIn, false);
  h.clock.tick(READY_TIMEOUT_MS);
  await settle();
  assert.equal(ready.error.code, 'host_unreachable');
  assert.deepEqual(await h.valu.call('Users.current', {}, { retries: 0 }), {
    error: { status: true, code: 503, message: 'host_unreachable', retryable: true },
  });
  assert.equal(h.posts().length, 0);
});

test('an untrusted parent gains no trust by repeating api:ready, or by naming a trusted origin in it', async (t) => {
  const h = await setup(t, { parentOrigin: 'https://evil.example' });
  h.send(MSG.READY, {
    applicationId: 'app-1', action: 'open', params: {}, origin: 'https://live.valuverse.io',
    valuApi: { ...VALU_API, origin: 'https://live.valuverse.io' },
  });
  h.ready();
  h.ready();
  await settle();
  assert.equal(h.valu.auth.state.signedIn, false);
  assert.equal((await h.valu.Users.current()).error.code, 501);
  assert.equal(h.calls().length, 0);
});

test('a trusted parent that says nothing of valuApi first and then says it is taken at its word', async (t) => {
  const h = await setup(t, { parentOrigin: 'https://texpo.io' });
  h.ready(undefined);
  await settle();
  assert.equal((await h.valu.Users.current()).error.code, 501);
  h.ready();
  assert.equal(h.valu.auth.state.signedIn, true);
  assert.deepEqual(await h.valu.Users.current(), { data: { ok: true } });
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

// ---------------------------------------------------------------------------
// The typed intents inside Valu Social (2026-10-30): sent as the intents they are.
// ---------------------------------------------------------------------------

test('without valuApi.intents a typed intent goes to Valu Social as api:service-intent, whatever its mode, and the reply is the ack', async (t) => {
  const h = await setup(t);
  const intents = [];
  h.valuSocial.addEventListener('message', ({ data, source }) => {
    if (source !== h.frame || data?.name !== MSG.SERVICE_INTENT) return;
    intents.push(data.message);
    h.send(MSG.RUN_CONSOLE_COMPLETED, data.message.action === 'open-cart' ? { success: true, popup: true } : { success: true, items: [1] }, data.message.requestId);
  });
  h.ready();
  await settle();
  assert.deepEqual(await h.valu.Commerce.getCart(), { data: { success: true, items: [1] } });
  assert.deepEqual(await h.valu.Commerce.openCart({ popup: true }), { data: { success: true, popup: true } });
  assert.deepEqual(intents.map(({ applicationId, action, params }) => [applicationId, action, params]), [
    ['Commerce', 'get-cart', {}],
    ['Commerce', 'open-cart', { popup: true }],
  ]);
  assert.equal(h.calls().length, 0, 'never an api:call');
  assert.equal(h.popups.calls.length, 0, 'no window inside Valu Social');
});

// ---------------------------------------------------------------------------
// Typed app intents over api:call (2026-11-03 design §5.3): when Valu Social's
// api:ready says `intents`, every typed intent is an api:call with `intent`.
// ---------------------------------------------------------------------------

const WITH_INTENTS = { ...VALU_API, intents: true };

/** Valu Social's older bridge, answered: every `api:run-intent` / `api:service-intent` it gets. */
function oldBridge(h, answer = () => ({ success: true })) {
  const got = [];
  h.valuSocial.addEventListener('message', ({ data, source }) => {
    if (source !== h.frame) return;
    if (data?.name === MSG.RUN_INTENT) {
      got.push({ name: data.name, ...data.message });
      h.send(MSG.RUN_COMPLETED, answer(data.message), data.message.requestId);
    } else if (data?.name === MSG.SERVICE_INTENT) {
      got.push({ name: data.name, ...data.message });
      h.send(MSG.RUN_CONSOLE_COMPLETED, answer(data.message), data.message.requestId);
    } else if (data?.name === MSG.RUN_COMMAND) {
      got.push({ name: data.name, ...data.message });
    }
  });
  return got;
}

test('with valuApi.intents a typed intent is an api:call with intent: {target, id}, app and service alike', async (t) => {
  const h = await setup(t, { answer: (message) => ({ data: { echoed: message.intent } }) });
  const bridge = oldBridge(h);
  h.ready(WITH_INTENTS);
  await settle();
  assert.deepEqual(await h.valu.Chats.openChannel({ userId: 'u-2' }), { data: { echoed: { target: 'application', id: 'textchat' } } });
  assert.deepEqual(await h.valu.Commerce.getCart(), { data: { echoed: { target: 'service', id: 'Commerce' } } });
  assert.deepEqual(await h.valu.Apps.isLoaded('textchat'), { data: { echoed: { target: 'service', id: 'AiGuru' } } });

  const [chat, cart, loaded] = h.calls().map((post) => post.message);
  assert.deepEqual(Object.keys(chat), ['intent', 'action', 'params', 'requestId', 'timeoutMs', 'client']);
  assert.equal(chat.action, 'open-channel');
  assert.deepEqual(chat.params, { userId: 'u-2' });
  assert.equal(cart.action, 'get-cart');
  assert.deepEqual(loaded.params, { applicationId: 'textchat' });
  assert.equal(loaded.action, 'is-application-loaded');
  assert.deepEqual(bridge, [], 'nothing over the older bridge');
});

test('without valuApi.intents an app intent goes over api:run-intent, a service intent over api:service-intent', async (t) => {
  const h = await setup(t);
  const bridge = oldBridge(h, (message) => (message.action === 'open-channel' ? { success: true } : { success: false, code: 'consent_required', scope: 'commerce:write' }));
  h.ready(); // calls, but no intents: a Valu Social from before typed app intents
  await settle();
  assert.deepEqual(await h.valu.Chats.openChannel({ userId: 'u-2' }), { data: { success: true } });
  const refused = await h.valu.Commerce.addToCart({ productId: 'p-1' });
  assert.equal(refused.error.message, 'consent_required', 'the reply is read with intentAck: a refusal reads like a refused function');
  assert.deepEqual(bridge.map(({ name, applicationId, action, params }) => [name, applicationId, action, params]), [
    [MSG.RUN_INTENT, 'textchat', 'open-channel', { userId: 'u-2' }],
    [MSG.SERVICE_INTENT, 'Commerce', 'add-to-cart', { productId: 'p-1' }],
  ]);
  assert.equal(h.calls().length, 0);
});

test('a typed intent made before api:ready is held for it; one held past its timeout answers 408 and is never sent', async (t) => {
  const h = await setup(t, { answer: () => ({ data: { ok: true } }) });
  const late = track(h.valu.call('Chats.openChannel', {}, { timeoutMs: 2_000 }));
  const held = track(h.valu.Rooms.showRoom({ roomId: 'r-1' }));
  h.clock.tick(2_000);
  await settle();
  assert.equal(late.value.error.code, 408);
  assert.equal(held.settled, false);
  h.ready(WITH_INTENTS);
  await settle();
  assert.deepEqual(held.value, { data: { ok: true } });
  assert.deepEqual(h.calls().map((post) => post.message.intent), [{ target: 'application', id: 'rooms' }]);
});

test('a posted typed intent that outlives its timeout answers 408; an app intent that writes says it may still apply', async (t) => {
  const h = await setup(t, { answer: () => null });
  h.ready(WITH_INTENTS);
  await settle();
  const pending = track(h.valu.call('Chats.sendMessage', { text: 'hi' }, { timeoutMs: 3_000 }));
  await settle();
  h.clock.tick(3_000);
  await settle();
  assert.equal(pending.value.error.code, 408);
  assert.equal(pending.value.error.retryable, false);
  assert.equal(h.calls().length, 1, 'never retried');
});

test('valu.Apps.open and valu.Apps.send go out as app intents to the app the caller names', async (t) => {
  const h = await setup(t, { answer: () => ({ data: { success: true } }) });
  h.ready(WITH_INTENTS);
  await settle();
  await h.valu.Apps.open('settings', { route: '/privacy' });
  await h.valu.Apps.send('ws-portal-app', 'refresh', { full: true });
  await h.valu.Apps.send('textchat', 'open-channel', { userId: 'u-3' });
  assert.deepEqual(h.calls().map(({ message }) => [message.intent, message.action, message.params]), [
    [{ target: 'application', id: 'settings' }, 'open', { route: '/privacy' }],
    [{ target: 'application', id: 'ws-portal-app' }, 'refresh', { full: true }],
    [{ target: 'application', id: 'textchat' }, 'open-channel', { userId: 'u-3' }],
  ]);
  // A catalogue intent sent by name keeps its params checked.
  assert.equal((await h.valu.Apps.send('textchat', 'open-channel', { usr: 'x' })).error.code, 400);
});

test('valu.route.push / replace: an api:call with intent: {target: route} when intents are served, api:run-command otherwise', async (t) => {
  const h = await setup(t, { answer: () => ({ data: { success: true } }) });
  h.ready(WITH_INTENTS);
  await settle();
  assert.deepEqual(await h.valu.route.push('/a'), { data: { success: true } });
  assert.deepEqual(await h.valu.route.replace('/b'), { data: { success: true } });
  assert.deepEqual(h.calls().map(({ message }) => [message.intent, message.action, message.params]), [
    [{ target: 'route' }, 'push', { path: '/a' }],
    [{ target: 'route' }, 'replace', { path: '/b' }],
  ]);

  const old = await setup(t);
  const bridge = oldBridge(old);
  old.ready();
  await settle();
  assert.deepEqual(await old.valu.route.push('/c'), { data: { success: true, sent: true } });
  assert.deepEqual(await old.valu.route.replace('/d'), { data: { success: true, sent: true } });
  assert.deepEqual(bridge.map(({ name, command, data }) => [name, command, data]), [
    [MSG.RUN_COMMAND, 'pushRoute', '/c'],
    [MSG.RUN_COMMAND, 'replaceRoute', '/d'],
  ]);
  assert.equal((await old.valu.route.push(42)).error.code, 400);
});

test('valu.onRoute hears Valu Social move the route, until it is stopped', async (t) => {
  const h = await setup(t);
  h.ready(WITH_INTENTS);
  await settle();
  const seen = [];
  const stop = h.valu.onRoute((route) => seen.push(route));
  h.send(MSG.TRIGGER, { action: 'on_route', data: '/inbox' });
  await settle();
  stop();
  h.send(MSG.TRIGGER, { action: 'on_route', data: '/elsewhere' });
  await settle();
  assert.deepEqual(seen, ['/inbox']);
  assert.throws(() => h.valu.onRoute('nope'), TypeError);
});

test('an untrusted parent is never sent an intent over api:call, whatever its api:ready says', async (t) => {
  const h = await setup(t, { parentOrigin: 'https://evil.example', answer: () => ({ data: { stolen: true } }) });
  const bridge = oldBridge(h);
  h.ready(WITH_INTENTS);
  await settle();
  await h.valu.Chats.openChannel({});
  assert.equal(h.calls().length, 0);
  assert.equal(bridge.length, 1, 'the older bridge, as before: it is what such a parent always got');
});
