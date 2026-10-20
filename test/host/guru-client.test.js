// ===========================================================================
// GuruClient — the host's own WebSocket to Valu Guru.
//
// Every test drives a fake socket (`fakeGuruWebSocket`): nothing happens until
// the test opens it, answers on it or drops it, so what the client does on the
// wire is asserted frame by frame. Timing tests use a few tens of milliseconds
// and are ordered by the timers' own expiry, not by a race; the backoff
// sequence runs on mocked timers so its delays are exact.
// ===========================================================================
import { test as nodeTest, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  GuruClient, GuruError, backoffDelayMs, DEFAULT_GURU_URL, DEFAULT_BACKOFF, DEFAULT_REQUEST_TIMEOUT_MS,
} from '../../src/host/GuruClient.js';
import { HOST_ERRORS } from '../../src/host/protocol.js';
import { fakeGuruWebSocket } from '../helpers/hostFakes.js';

/** A regression that leaves a promise waiting fails the test in seconds instead of hanging the run. */
const test = (name, fn) => nodeTest(name, { timeout: 5000 }, fn);

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
/** Every microtask queued so far has run when this resolves (setImmediate is not mocked). */
const flush = () => new Promise((resolve) => { setImmediate(resolve); });
const PENDING = Symbol('pending');
/** What `promise` settled to, or PENDING if it had not within `ms`. */
const peek = (promise, ms = 20) => Promise.race([promise, sleep(ms).then(() => PENDING)]);
/** `{value}` or `{error}`, so a rejection nobody is awaiting yet is never unhandled. */
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

async function until(predicate, what, ms = 1000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(1);
  }
}

/** The `index`th socket the client opened, once it has. */
async function socketAt(WebSocketImpl, index = 0) {
  await until(() => WebSocketImpl.sockets.length > index, `socket #${index + 1}`);
  return WebSocketImpl.sockets[index];
}

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} is not ${expected}`);

const sentTypes = (WebSocketImpl) => WebSocketImpl.sockets.flatMap((socket) => socket.sent.map((frame) => frame.type));

/**
 * A client on fake sockets, a fake `online` event source and tokens `tok-1`,
 * `tok-2`, … Closed when the test ends, so no timer outlives it.
 */
function harness(t, { autoOpen = false, ...options } = {}) {
  const WebSocketImpl = fakeGuruWebSocket({ autoOpen });
  const onlineSource = { onLine: true };
  const listeners = new Set();
  let minted = 0;
  const mintToken = options.mintToken ?? mock.fn(async () => `tok-${++minted}`);
  let ids = 0;
  const h = {
    WebSocketImpl,
    onlineSource,
    mintToken,
    networkId: 'net-1',
    /** What is subscribed through the injected `addEventListener` right now. */
    listeners,
    /** The browser's `online` event: the flag flips first, then the event fires. */
    goOnline() {
      onlineSource.onLine = true;
      for (const entry of [...listeners]) {
        if (entry.type !== 'online') continue;
        if (entry.options?.once) listeners.delete(entry);
        entry.listener({ type: 'online' });
      }
    },
  };
  h.client = new GuruClient({
    mintToken,
    getNetworkId: () => h.networkId,
    WebSocketImpl,
    onlineSource,
    addEventListener: (type, listener, listenerOptions) => {
      const entry = { type, listener, options: listenerOptions };
      listeners.add(entry);
      listenerOptions?.signal?.addEventListener('abort', () => listeners.delete(entry), { once: true });
    },
    backoff: { initialMs: 5, maxMs: 20 },
    randomId: () => `req-${++ids}`,
    ...options,
  });
  t.after(() => h.client.close());
  return h;
}

/** A client that is already `ready` on its first socket. */
async function readyHarness(t, options) {
  const h = harness(t, { autoOpen: true, ...options });
  await h.client.connect();
  h.socket = h.WebSocketImpl.sockets[0];
  return h;
}

/** Ready on its first socket, and every later socket waits for the test to open it. */
async function readyThenManual(t, options) {
  const h = harness(t, options);
  const connecting = h.client.connect();
  h.socket = await socketAt(h.WebSocketImpl);
  h.socket.open();
  await connecting;
  return h;
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

test('connect mints a token and opens the URL with client=host', async (t) => {
  const h = harness(t, { mintToken: mock.fn(async () => 'a b/c+d=') });

  const connecting = h.client.connect();
  const socket = await socketAt(h.WebSocketImpl);

  assert.equal(h.mintToken.mock.callCount(), 1);
  assert.equal(h.WebSocketImpl.urls[0], 'wss://valuguru.texpo.io/?token=a%20b%2Fc%2Bd%3D&client=host');
  assert.equal(DEFAULT_GURU_URL, 'wss://valuguru.texpo.io/');
  assert.equal(h.client.state, 'connecting');
  assert.equal(await peek(connecting), PENDING, 'not connected until the handshake completes');

  socket.open();
  await connecting;
  assert.equal(h.client.state, 'ready');
});

test('the URL option is where the socket goes', async (t) => {
  const h = harness(t, { url: 'ws://localhost:3001/', autoOpen: true });
  await h.client.connect();
  assert.equal(h.WebSocketImpl.urls[0], 'ws://localhost:3001/?token=tok-1&client=host');
});

test('connect is idempotent: one mint and one socket, however many callers', async (t) => {
  const h = harness(t);
  const first = h.client.connect();
  const second = h.client.connect();
  const socket = await socketAt(h.WebSocketImpl);
  socket.open();
  await Promise.all([first, second]);
  await h.client.connect();

  assert.equal(h.mintToken.mock.callCount(), 1);
  assert.equal(h.WebSocketImpl.sockets.length, 1);
});

test('state walks idle, connecting, ready and tells its subscribers, until they unsubscribe', async (t) => {
  const h = harness(t, { autoOpen: true });
  const seen = [];
  const unsubscribe = h.client.onStateChange((state, previous) => seen.push([previous, state]));
  assert.equal(h.client.state, 'idle');

  await h.client.connect();
  assert.deepEqual(seen, [['idle', 'connecting'], ['connecting', 'ready']]);

  unsubscribe();
  h.WebSocketImpl.last.drop();
  assert.equal(h.client.state, 'reconnecting');
  assert.equal(seen.length, 2);
});

test('the first request opens the connection lazily and is sent once it is open', async (t) => {
  const h = harness(t);
  assert.equal(h.WebSocketImpl.sockets.length, 0);

  const answer = settle(h.client.request('valuguru.apps.grants.list', { appId: 'a1' }));
  const socket = await socketAt(h.WebSocketImpl);
  assert.equal(h.client.state, 'connecting');
  assert.deepEqual(socket.sent, [], 'nothing goes out before the handshake completes');

  socket.open();
  assert.deepEqual(socket.sent.map((frame) => frame.op), ['valuguru.apps.grants.list']);
  socket.reply('req-1', { data: { grants: [] } });
  assert.deepEqual(await answer, { value: { grants: [] } });
});

test('a request made while the handshake is in progress waits for it, and is sent once, in order', async (t) => {
  const h = harness(t);
  const connecting = h.client.connect();
  const socket = await socketAt(h.WebSocketImpl);           // CONNECTING: a real send would throw

  const first = settle(h.client.request('first'));
  const second = settle(h.client.request('second'));
  assert.deepEqual(socket.sent, []);

  socket.open();
  await connecting;
  assert.deepEqual(socket.sent.map((frame) => frame.op), ['first', 'second']);
  socket.reply('req-2', { data: 2 });
  socket.reply('req-1', { data: 1 });
  assert.deepEqual(await Promise.all([first, second]), [{ value: 1 }, { value: 2 }]);
});

test('a connect attempt that fails is retried with a fresh token, and connect waits for one that works', async (t) => {
  const h = harness(t);
  const connecting = h.client.connect();
  const first = await socketAt(h.WebSocketImpl, 0);
  first.drop(1006);                                 // closed before it ever opened
  assert.equal(await peek(connecting), PENDING, 'connect does not give up');
  assert.equal(h.client.state, 'reconnecting');

  const second = await socketAt(h.WebSocketImpl, 1);
  second.open();
  await connecting;

  assert.equal(h.client.state, 'ready');
  assert.deepEqual(h.WebSocketImpl.urls.map((url) => new URL(url).searchParams.get('token')), ['tok-1', 'tok-2']);
});

test('a token that cannot be minted is retried, not fatal', async (t) => {
  const outcomes = [() => { throw new Error('mint failed'); }, () => '', () => 'good-token'];
  const mintToken = mock.fn(async () => outcomes.shift()());
  const h = harness(t, { mintToken, autoOpen: true });

  await h.client.connect();

  assert.equal(mintToken.mock.callCount(), 3);
  assert.equal(h.WebSocketImpl.sockets.length, 1, 'no socket is opened without a token');
  assert.match(h.WebSocketImpl.urls[0], /token=good-token&client=host$/);
  assert.equal(h.client.state, 'ready');
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

test('request resolves data and rejects GuruError with the server code', async (t) => {
  const h = await readyHarness(t);

  const cart = h.client.request('valuguru.commerce.cart.get', { appId: 'a1' });
  assert.deepEqual(h.socket.sent, [{
    type: 'data_request', requestId: 'req-1', op: 'valuguru.commerce.cart.get', params: { appId: 'a1' }, networkId: 'net-1',
  }]);
  h.socket.reply('req-1', { data: { items: [1] } });
  assert.deepEqual(await cart, { items: [1] });

  const create = h.client.request('valuguru.commerce.orders.create');
  assert.deepEqual(h.socket.sent[1].params, {}, 'params default to an empty object');
  h.socket.reply('req-2', { ok: false, error: { code: 'forbidden', message: 'not your store', details: { storeId: 's1' } } });
  await assert.rejects(create, (error) => {
    assert.ok(error instanceof GuruError);
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'GuruError');
    assert.equal(error.code, 'forbidden');
    assert.equal(error.message, 'not your store');
    assert.deepEqual(error.details, { storeId: 's1' });
    return true;
  });

  const bare = h.client.request('valuguru.x');
  h.socket.reply('req-3', { ok: false });
  await assert.rejects(bare, { name: 'GuruError', code: 'unknown' });
});

test('the request id is a UUID unless told otherwise, and responses are matched by it', async (t) => {
  const h = await readyHarness(t, { randomId: undefined });

  const first = h.client.request('a');
  const second = h.client.request('b');
  const [one, two] = h.socket.sent.map((frame) => frame.requestId);
  assert.match(one, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(one, two);

  h.socket.reply(two, { data: 'B' });
  h.socket.reply(one, { data: 'A' });
  assert.deepEqual(await Promise.all([first, second]), ['A', 'B']);
});

test('the network id is read when the frame goes out, not when the request was made', async (t) => {
  const h = await readyHarness(t);
  h.networkId = 'net-2';
  h.client.request('a').catch(() => {});
  assert.equal(h.socket.sent[0].networkId, 'net-2');
});

test('a request that cannot be built is rejected alone and leaves nothing pending', async (t) => {
  const h = await readyHarness(t);
  const circular = {};
  circular.self = circular;

  await assert.rejects(h.client.request('a', circular), TypeError);
  await assert.rejects(h.client.request(''), TypeError);
  await assert.rejects(h.client.request(7), TypeError);
  for (const timeoutMs of [0, -1, NaN, Infinity]) {
    await assert.rejects(h.client.request('a', {}, { timeoutMs }), RangeError);
  }
  assert.deepEqual(h.socket.sent, []);

  const fine = h.client.request('ok');
  h.socket.reply(h.socket.sent[0].requestId, { data: 1 });
  assert.equal(await fine, 1);
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 10_000);
});

test('request times out with GuruError timeout when nothing answers, and a late answer is ignored', async (t) => {
  const h = await readyHarness(t);

  const slow = settle(h.client.request('slow', {}, { timeoutMs: 20 }));
  const { error } = await slow;
  assert.ok(error instanceof GuruError);
  assert.equal(error.code, HOST_ERRORS.TIMEOUT);
  assert.equal(error.code, 'timeout');
  assert.equal(error.details.sent, true);

  h.socket.reply('req-1', { data: 'too late' });          // nobody is waiting; nothing throws
  assert.deepEqual(h.socket.sent.map((frame) => frame.type), ['data_request']);
});

test('data_progress resets the silence timer', async (t) => {
  const h = await readyHarness(t);

  const answer = settle(h.client.request('slow', {}, { timeoutMs: 40 }));
  await sleep(30);
  h.socket.progress('req-1', 'working');
  await sleep(30);                                        // 60 ms in: the original 40 ms would have expired
  h.socket.reply('req-1', { data: 'done' });

  assert.deepEqual(await answer, { value: 'done' });
});

test('progress for a request nobody is waiting on is ignored', async (t) => {
  const h = await readyHarness(t);
  h.socket.progress('nope', 'x');
  const answer = h.client.request('a');
  h.socket.progress('req-1', 'x');
  assert.equal(await peek(answer), PENDING, 'progress is not an answer');
  h.socket.reply('req-1', { data: 1 });
  assert.equal(await answer, 1);
});

test('a request made while not connected waits for connect, up to its timeoutMs', async (t) => {
  const h = harness(t);
  const waiting = settle(h.client.request('a', {}, { timeoutMs: 30 }));
  const socket = await socketAt(h.WebSocketImpl);          // the handshake never completes

  const { error } = await waiting;
  assert.equal(error.code, 'timeout');
  assert.equal(error.details.sent, false, 'it never reached the wire');

  socket.open();
  assert.deepEqual(socket.sent, [], 'a request that gave up is not sent later');
});

test('abort sends data_cancel and rejects GuruError aborted', async (t) => {
  const h = await readyHarness(t);
  const controller = new AbortController();

  const answer = settle(h.client.request('slow', {}, { signal: controller.signal }));
  controller.abort();

  const { error } = await answer;
  assert.ok(error instanceof GuruError);
  assert.equal(error.code, 'aborted');
  assert.deepEqual(h.socket.sent.map((frame) => [frame.type, frame.requestId]), [
    ['data_request', 'req-1'], ['data_cancel', 'req-1'],
  ]);
  h.socket.reply('req-1', { data: 'late' });                // ignored
});

test('abort after the answer cancels nothing, and an aborted signal never starts a request', async (t) => {
  const h = await readyHarness(t);
  const controller = new AbortController();
  const done = h.client.request('a', {}, { signal: controller.signal });
  h.socket.reply('req-1', { data: 1 });
  await done;
  controller.abort();
  assert.deepEqual(h.socket.sent.map((frame) => frame.type), ['data_request']);

  await assert.rejects(h.client.request('b', {}, { signal: AbortSignal.abort() }), { code: 'aborted' });
  assert.equal(h.socket.sent.length, 1);

  const idle = harness(t);
  await assert.rejects(idle.client.request('c', {}, { signal: AbortSignal.abort() }), { code: 'aborted' });
  assert.equal(idle.client.state, 'idle', 'an aborted request does not open the connection');
});

test('abort of a request that never went out sends no cancel', async (t) => {
  const h = harness(t);
  const controller = new AbortController();
  const waiting = settle(h.client.request('a', {}, { signal: controller.signal }));
  const socket = await socketAt(h.WebSocketImpl);

  controller.abort();
  assert.equal((await waiting).error.code, 'aborted');
  socket.open();
  assert.deepEqual(socket.sent, []);
});

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

test('tool_call and session_event frames are ignored and nothing is sent back', async (t) => {
  const h = await readyHarness(t);
  const events = [];
  h.client.onCommerceEvent((event) => events.push(event));
  const answer = h.client.request('a');
  const sentBefore = [...h.socket.sentRaw];

  for (const frame of [
    { type: 'tool_call', callId: 'c1', name: 'search', args: {} },
    { type: 'session_event', event: 'created', sessionId: 's1' },
    { type: 'chat_chunk', requestId: 'req-1', text: 'hi' },       // another frame type that carries OUR id
    { type: 'agent_run_finished', requestId: 'req-1', ok: true, data: 'not an answer' },
    { type: 'ping' },
    { requestId: 'req-1', ok: true, data: 'no type at all' },
    {},
    [],
    7,
    null,
  ]) h.socket.frame(frame);
  h.socket.onmessage({ data: 'not json' });
  h.socket.onmessage({ data: new ArrayBuffer(8) });                // a binary frame
  h.socket.onmessage({});

  assert.equal(await peek(answer), PENDING, 'nothing but a data_response settles a request');
  assert.deepEqual(h.socket.sentRaw, sentBefore, 'not one byte went back');
  assert.deepEqual(events, []);

  h.socket.reply('req-1', { data: 'real' });
  assert.equal(await answer, 'real');
});

test('commerce_event frames reach subscribers raw, until they unsubscribe', async (t) => {
  const h = await readyHarness(t);
  const first = [];
  const second = [];
  const unsubscribe = h.client.onCommerceEvent((event) => first.push(event));
  h.client.onCommerceEvent((event) => second.push(event));

  const event = { type: 'commerce_event', event: 'commerce.cart.updated', userId: 'u1', data: { cartId: 'c1' } };
  h.socket.frame(event);
  unsubscribe();
  h.socket.frame({ ...event, event: 'commerce.order.updated' });

  assert.deepEqual(first, [event]);
  assert.equal(second.length, 2);
  assert.deepEqual(second[0], event);
});

test('a subscriber that throws does not stop the others or the socket', async (t) => {
  const h = await readyHarness(t);
  const logged = t.mock.method(console, 'error', () => {});
  const got = [];
  h.client.onCommerceEvent(() => { throw new Error('boom'); });
  h.client.onCommerceEvent((event) => got.push(event));

  h.socket.frame({ type: 'commerce_event', event: 'x' });
  const answer = h.client.request('a');
  h.socket.reply('req-1', { data: 1 });

  assert.equal(got.length, 1);
  assert.equal(await answer, 1);
  assert.equal(logged.mock.callCount(), 1);
});

test('the client sends only data_request and data_cancel, through every state', async (t) => {
  const h = harness(t);
  const controller = new AbortController();
  const held = h.client.request('a', {}, { signal: controller.signal });
  held.catch(() => {});
  (await socketAt(h.WebSocketImpl, 0)).open();
  const cancelled = h.client.request('b', {}, { signal: controller.signal });
  cancelled.catch(() => {});
  h.client.request('c').catch(() => {});
  controller.abort();
  h.WebSocketImpl.sockets[0].frame({ type: 'tool_call' });
  h.WebSocketImpl.sockets[0].drop();
  const second = await socketAt(h.WebSocketImpl, 1);
  second.open();
  second.frame({ type: 'session_event' });
  h.client.request('d').catch(() => {});
  await h.client.connect();

  const types = sentTypes(h.WebSocketImpl);
  assert.ok(types.length >= 4);
  assert.deepEqual([...new Set(types)].sort(), ['data_cancel', 'data_request']);
});

// ---------------------------------------------------------------------------
// Dropping and reconnecting
// ---------------------------------------------------------------------------

test('reconnect mints a fresh token', async (t) => {
  const h = harness(t);
  const connecting = h.client.connect();
  (await socketAt(h.WebSocketImpl, 0)).open();
  await connecting;

  h.WebSocketImpl.sockets[0].drop();
  assert.equal(h.client.state, 'reconnecting');
  const second = await socketAt(h.WebSocketImpl, 1);
  second.open();
  await until(() => h.client.state === 'ready', 'ready again');

  assert.equal(h.mintToken.mock.callCount(), 2);
  assert.deepEqual(h.WebSocketImpl.urls, [
    'wss://valuguru.texpo.io/?token=tok-1&client=host',
    'wss://valuguru.texpo.io/?token=tok-2&client=host',
  ]);
});

test('pending requests reject disconnected on drop', async (t) => {
  const h = await readyHarness(t);
  const first = settle(h.client.request('a'));
  const second = settle(h.client.request('b'));

  h.socket.drop(1006);

  for (const { error } of await Promise.all([first, second])) {
    assert.ok(error instanceof GuruError);
    assert.equal(error.code, HOST_ERRORS.DISCONNECTED);
    assert.equal(error.code, 'disconnected');
    assert.equal(error.details.closeCode, 1006);
  }
});

test('a request made while reconnecting is held and sent on the new socket', async (t) => {
  const h = await readyThenManual(t);
  h.socket.drop();
  assert.equal(h.client.state, 'reconnecting');

  h.networkId = 'net-2';                                    // the network changed while it waited
  const held = settle(h.client.request('held', {}, { timeoutMs: 1000 }));
  const second = await socketAt(h.WebSocketImpl, 1);
  assert.deepEqual(second.sent, []);

  second.open();
  assert.deepEqual(second.sent.map((frame) => [frame.op, frame.networkId]), [['held', 'net-2']]);
  second.reply(second.sent[0].requestId, { data: 'ok' });
  assert.deepEqual(await held, { value: 'ok' });
  assert.deepEqual(h.socket.sent, [], 'the dead socket got nothing');
});

test('a request waiting for a handshake that failed is sent on the next one', async (t) => {
  const h = harness(t);
  const waiting = settle(h.client.request('a', {}, { timeoutMs: 1000 }));
  (await socketAt(h.WebSocketImpl, 0)).drop(1006);

  const second = await socketAt(h.WebSocketImpl, 1);
  second.open();
  assert.deepEqual(second.sent.map((frame) => frame.op), ['a']);
  second.reply('req-1', { data: 1 });
  assert.deepEqual(await waiting, { value: 1 });
});

test('frames from a socket that was replaced are ignored', async (t) => {
  const h = await readyHarness(t);
  h.socket.drop();
  const second = await socketAt(h.WebSocketImpl, 1);
  second.open();
  const answer = h.client.request('a');

  h.socket.reply('req-1', { data: 'from the dead' });
  h.socket.frame({ type: 'commerce_event', event: 'x' });
  assert.equal(await peek(answer), PENDING);

  second.reply('req-1', { data: 'from the live one' });
  assert.equal(await answer, 'from the live one');
});

test('backoff: doubles from initialMs, caps at maxMs, starts over once a connection was made', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0.5);                 // jitter factor 1.0 exactly
  const mintToken = mock.fn(async () => { throw new Error('mint failed'); });
  const h = harness(t, { mintToken, backoff: { initialMs: 100, maxMs: 350 } });

  const connecting = h.client.connect();
  await flush();
  assert.equal(mintToken.mock.callCount(), 1);
  assert.equal(h.client.state, 'reconnecting');

  let attempts = 1;
  for (const delay of [100, 200, 350, 350]) {
    t.mock.timers.tick(delay - 1);
    await flush();
    assert.equal(mintToken.mock.callCount(), attempts, `no attempt before ${delay} ms`);
    t.mock.timers.tick(1);
    await flush();
    attempts += 1;
    assert.equal(mintToken.mock.callCount(), attempts, `an attempt at ${delay} ms`);
  }

  mintToken.mock.mockImplementation(async () => 'good');
  t.mock.timers.tick(350);
  await flush();
  h.WebSocketImpl.last.open();
  await connecting;
  assert.equal(h.client.state, 'ready');

  attempts = mintToken.mock.callCount();
  h.WebSocketImpl.last.drop();
  t.mock.timers.tick(99);
  await flush();
  assert.equal(mintToken.mock.callCount(), attempts, 'after a connection the wait starts at initialMs again');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(mintToken.mock.callCount(), attempts + 1);
  h.client.close();
});

test('backoffDelayMs is min(maxMs, initialMs * 2^attempt) * (0.8 + 0.4 * random)', () => {
  const backoff = { initialMs: 1000, maxMs: 30_000 };
  const middle = () => 0.5;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 60, 5000].map((attempt) => backoffDelayMs(attempt, backoff, middle)),
    [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000]);
  near(backoffDelayMs(0, backoff, () => 0), 800);           // -20 %
  near(backoffDelayMs(0, backoff, () => 1), 1200);          // +20 %
  near(backoffDelayMs(9, backoff, () => 0), 24_000);        // jitter applies to the capped value too
  assert.deepEqual({ ...DEFAULT_BACKOFF }, { initialMs: 1000, maxMs: 30_000 });
  const real = backoffDelayMs(2, backoff);
  assert.ok(real >= 3200 && real <= 4800, `${real} is within 20 % of 4000`);
});

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

test('offline pauses reconnect until online', async (t) => {
  const h = await readyHarness(t);
  h.onlineSource.onLine = false;
  h.socket.drop();

  assert.equal(h.client.state, 'offline');
  assert.equal(h.listeners.size, 1, 'it listens for `online`, and only now');
  await sleep(100);
  assert.equal(h.WebSocketImpl.sockets.length, 1, 'no new socket while offline');
  assert.equal(h.mintToken.mock.callCount(), 1, 'no token is minted while offline');

  h.goOnline();
  assert.equal(h.listeners.size, 0, 'the listener is gone once it fired');
  const second = await socketAt(h.WebSocketImpl, 1);
  second.open();
  await until(() => h.client.state === 'ready', 'ready again');
  assert.equal(h.mintToken.mock.callCount(), 2);
});

test('going offline while a retry is waiting pauses it when the timer fires', async (t) => {
  const h = await readyHarness(t, { backoff: { initialMs: 20, maxMs: 40 } });
  h.socket.drop();
  assert.equal(h.client.state, 'reconnecting');
  h.onlineSource.onLine = false;

  await until(() => h.client.state === 'offline', 'offline');
  await sleep(60);
  assert.equal(h.WebSocketImpl.sockets.length, 1);

  h.goOnline();
  await socketAt(h.WebSocketImpl, 1);
});

test('connect while offline waits for online before it mints or opens anything', async (t) => {
  const h = harness(t, { autoOpen: true });
  h.onlineSource.onLine = false;

  const connecting = h.client.connect();
  assert.equal(h.client.state, 'offline');
  assert.equal(await peek(connecting, 60), PENDING);
  assert.equal(h.mintToken.mock.callCount(), 0);
  assert.equal(h.WebSocketImpl.sockets.length, 0);

  h.goOnline();
  await connecting;
  assert.equal(h.client.state, 'ready');
  assert.equal(h.WebSocketImpl.sockets.length, 1);
});

test('an environment with no online source or no event source never pauses', async (t) => {
  const noFlag = harness(t, { onlineSource: {}, autoOpen: true });
  await noFlag.client.connect();
  noFlag.WebSocketImpl.last.drop();
  await socketAt(noFlag.WebSocketImpl, 1);

  const noListen = harness(t, { addEventListener: undefined, autoOpen: true });
  noListen.onlineSource.onLine = false;                     // it could never learn when to resume, so it does not stop
  await noListen.client.connect();
  assert.equal(noListen.client.state, 'ready');
});

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

test('close rejects what is pending, closes the socket and stops for good', async (t) => {
  const h = await readyHarness(t);
  const states = [];
  h.client.onStateChange((state) => states.push(state));
  const inFlight = settle(h.client.request('a'));

  h.client.close();

  const { error } = await inFlight;
  assert.equal(error.code, 'disconnected');
  assert.equal(h.client.state, 'closed');
  assert.deepEqual(states, ['closed']);
  assert.equal(h.socket.closedWith.code, 1000);
  await assert.rejects(h.client.connect(), { name: 'GuruError', code: 'disconnected' });
  await assert.rejects(h.client.request('b'), { name: 'GuruError', code: 'disconnected' });
  h.client.close();                                         // idempotent
  assert.equal(h.WebSocketImpl.sockets.length, 1);
  assert.equal(h.client.state, 'closed');
});

test('close while reconnecting cancels the retry', async (t) => {
  const h = await readyHarness(t);
  const held = settle(h.client.request('held'));            // sent on the live socket ...
  h.socket.drop();
  await held;
  const waiting = settle(h.client.request('waiting', {}, { timeoutMs: 1000 }));   // ... and this one never was

  h.client.close();

  assert.equal((await waiting).error.code, 'disconnected');
  await sleep(40);
  assert.equal(h.WebSocketImpl.sockets.length, 1, 'no socket is opened after close');
  assert.equal(h.mintToken.mock.callCount(), 1);
});

test('close while a token is being minted opens no socket, and connect rejects', async (t) => {
  let release;
  const mintToken = mock.fn(() => new Promise((resolve) => { release = resolve; }));
  const h = harness(t, { mintToken });
  const connecting = settle(h.client.connect());
  await flush();
  assert.equal(mintToken.mock.callCount(), 1);

  h.client.close();
  release('late-token');

  assert.equal((await connecting).error.code, 'disconnected');
  await flush();
  assert.equal(h.WebSocketImpl.sockets.length, 0);
});

test('close while offline removes the online listener', async (t) => {
  const h = await readyHarness(t);
  h.onlineSource.onLine = false;
  h.socket.drop();
  assert.equal(h.listeners.size, 1);

  h.client.close();

  assert.equal(h.listeners.size, 0);
  h.goOnline();
  await flush();
  assert.equal(h.WebSocketImpl.sockets.length, 1);
});

test('a state subscriber that closes the client mid-transition leaves nothing running', async (t) => {
  const h = harness(t, { autoOpen: true });
  h.client.onStateChange((state) => { if (state === 'ready') h.client.close(); });
  const request = settle(h.client.request('a'));

  assert.equal((await request).error.code, 'disconnected');
  assert.equal(h.client.state, 'closed');
  assert.deepEqual(h.WebSocketImpl.last.sent, [], 'the request was rejected, not sent');
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

test('the constructor insists on the two callbacks it cannot do without', () => {
  const WebSocketImpl = fakeGuruWebSocket();
  assert.throws(() => new GuruClient({ getNetworkId: () => 'n', WebSocketImpl }), TypeError);
  assert.throws(() => new GuruClient({ mintToken: async () => 't', WebSocketImpl }), TypeError);
  assert.throws(() => new GuruClient({ mintToken: async () => 't', getNetworkId: () => 'n', WebSocketImpl: null }), TypeError);
});
