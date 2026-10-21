// ===========================================================================
// HostTransport — the app page's side of the host bridge (spec §4.5, §4.8,
// §4.11): the hidden iframe, the `host:hello` handshake, `api:call` service
// calls, pushes as Transport events, and the ping that notices a dead host.
//
// The page, the iframe and the host are a FakeWindowPair and a fake document
// (`fakeDocumentFor`); the host is a few lines that answer hello and ping the
// way HostBridge does, and everything else it says the test says by hand with
// `send`. Time is a fake clock handed to the transport, so nothing waits and
// `clock.pending` proves no timer is left behind.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HostTransport } from '../../src/transport/HostTransport.js';
import { Transport } from '../../src/transport/Transport.js';
import { VERSION } from '../../src/version.js';
import { MSG, toParent } from '../../src/host/protocol.js';
import { errorAck } from '../../src/Errors.js';
import { findDescriptor, listDescriptors } from '../../src/services/descriptors.js';
import { FakeWindowPair, fakeDocumentFor } from '../helpers/hostFakes.js';
import { fakeFetch } from '../helpers/fakes.js';

const settle = () => new Promise((resolve) => { setImmediate(resolve); });

const READ = findDescriptor('Users.current');
const WRITE = listDescriptors({ channel: 'roomful', mutates: true })[0];

const READY = {
  applicationId: 'ws_1/demo',
  action: 'start',
  params: {},
  host: {
    protocol: 1,
    mode: 'dedicated',
    signedIn: true,
    user: { id: 'u1', name: 'Ada Lovelace' },
    network: { id: 'n1', name: 'Roomful' },
  },
};

/** A clock the test turns: `tick(ms)` runs what is due, in order, including what that schedules. */
function fakeClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { sequence += 1; timers.set(sequence, { at: now + ms, fn }); return sequence; },
    clearTimeout(id) { timers.delete(id); },
    get pending() { return timers.size; },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

/**
 * A transport on a window pair with a host that answers hello with `answers.ready`
 * and ping with a pong, each switchable (`answers.onHello`, `answers.ping`).
 */
function setup(t, { answers: given = {}, ...options } = {}) {
  const pair = FakeWindowPair();
  const doc = fakeDocumentFor(pair);
  const clock = fakeClock();
  const send = (name, message, requestId) => pair.app.postMessage(toParent(name, message, requestId), pair.app.origin);
  const answers = { ready: READY, ping: true, onHello: () => send(MSG.READY, answers.ready), ...given };
  pair.host.addEventListener('message', ({ data }) => {
    if (data.name === MSG.HELLO) answers.onHello();
    if (data.name === MSG.PING && answers.ping) send(MSG.PONG, {}, data.message.requestId);
  });
  const transport = new HostTransport({
    hostOrigin: pair.host.origin,
    window: pair.app,
    document: doc,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    readyTimeoutMs: 1000,
    pingIntervalMs: 5000,
    pingTimeoutMs: 2000,
    localTransport: { callService: async () => errorAck(500, 'local transport not expected') },
    ...options,
  });
  t.after(() => transport.close());
  const sent = (name) => pair.host.posted.filter((post) => post.data.name === name);
  const heard = (event) => {
    const list = [];
    transport.addEventListener(event, (data) => list.push(data));
    return list;
  };
  return { pair, doc, clock, transport, answers, send, sent, heard, hostOrigin: pair.host.origin };
}

/** Open, then call and wait for the post: returns the call and the id it went out with. */
async function callOut(h, descriptor = READ, options = { timeoutMs: 60_000 }) {
  const call = h.transport.callService(descriptor, {}, options);
  await settle();
  const posts = h.sent(MSG.CALL);
  return { call, requestId: posts[posts.length - 1].data.message.requestId };
}

/** Whether a promise has settled, without waiting for it. */
const settled = async (promise) => {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  await settle();
  return done;
};

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

test('open posts host:hello with protocol 1 and resolves on api:ready', async (t) => {
  const h = setup(t);
  const ready = h.heard(Transport.READY);
  assert.equal(h.transport.hostState, null, 'nothing is known before the handshake');
  assert.equal(h.transport.connected, false);

  await h.transport.open();

  const [frame] = h.doc.frames;
  assert.equal(h.doc.frames.length, 1);
  assert.equal(frame.tagName, 'IFRAME');
  assert.equal(frame.src, `${h.hostOrigin}/host/`);
  assert.equal(frame.hidden, true);
  assert.equal(frame.getAttribute('aria-hidden'), 'true');
  assert.equal(frame.getAttribute('sandbox'), null, 'no sandbox: the host needs its storage');
  assert.equal(frame.getAttribute('allow'), null);
  assert.equal(frame.parentNode, h.doc.body);

  const hellos = h.sent(MSG.HELLO);
  assert.equal(hellos.length, 1);
  assert.equal(hellos[0].targetOrigin, h.hostOrigin, 'never a wildcard');
  assert.deepEqual(hellos[0].data, { name: 'host:hello', message: { protocol: 1, client: VERSION } });

  assert.deepEqual(ready, [READY], 'READY carries the api:ready message');
  assert.deepEqual(h.transport.hostState, READY.host);
  assert.equal(h.transport.applicationId, 'ws_1/demo');
  assert.equal(h.transport.connected, true);
  assert.equal(h.transport.connectionState, 'ready');
  assert.equal(h.transport.servesServiceFunctions, true);
  assert.equal(h.clock.pending, 1, 'the ping is the only timer left');
});

test('host:hello carries app when the transport is given one', async (t) => {
  const h = setup(t, { app: 'ws_1/demo' });
  await h.transport.open();
  const [hello] = h.sent(MSG.HELLO);
  assert.deepEqual(hello.data, { name: 'host:hello', message: { protocol: 1, client: VERSION, app: 'ws_1/demo' } });
});

test('host:hello has no app key when none is given', async (t) => {
  for (const options of [{}, { app: undefined }]) {
    const h = setup(t, options);
    await h.transport.open();
    const [hello] = h.sent(MSG.HELLO);
    assert.equal(Object.hasOwn(hello.data.message, 'app'), false, JSON.stringify(options));
    assert.deepEqual(hello.data.message, { protocol: 1, client: VERSION });
  }
});

test('app must be a string', () => {
  const pair = FakeWindowPair();
  for (const app of [null, 7, true, {}, ['ws_1/demo']]) {
    assert.throws(
      () => new HostTransport({ hostOrigin: pair.host.origin, app, window: pair.app, document: fakeDocumentFor(pair) }),
      TypeError,
      String(app),
    );
  }
});

test('open starts a signed-out page as signed_out', async (t) => {
  const h = setup(t, { answers: { ready: { ...READY, host: { ...READY.host, signedIn: false, user: null, network: null } } } });
  await h.transport.open();
  assert.equal(h.transport.connectionState, 'signed_out');
  assert.deepEqual(h.transport.hostState, { ...READY.host, signedIn: false, user: null, network: null });
});

test('open is one handshake however often it is asked', async (t) => {
  const h = setup(t);
  await Promise.all([h.transport.open(), h.transport.open()]);
  await h.transport.open();
  assert.equal(h.doc.frames.length, 1);
  assert.equal(h.sent(MSG.HELLO).length, 1);
});

test('open rejects host_unreachable after the timeout', async (t) => {
  const h = setup(t, { answers: { onHello: () => {} } });
  const opening = h.transport.open();
  const outcome = assert.rejects(opening, (error) => error.code === 'host_unreachable' && /1000/.test(error.message));

  h.clock.tick(999);
  assert.equal(await settled(opening), false, 'still waiting one tick before the timeout');
  h.clock.tick(1);
  await outcome;

  assert.equal(h.doc.body.children.length, 0, 'the iframe that never answered is removed');
  assert.equal(h.clock.pending, 0);
  assert.equal(h.pair.app.listeners.size, 0, 'and the message listener with it');
  assert.equal(h.transport.connected, false);
});

for (const code of ['unknown_app', 'nested', 'protocol_unsupported', 'resolve_unavailable', 'bad_origin']) {
  test(`host:error rejects open with its code (${code})`, async (t) => {
    const h = setup(t, { answers: { onHello: () => h.send(MSG.ERROR, { code, message: `refused: ${code}` }) } });

    await assert.rejects(h.transport.open(), (error) => error.code === code && error.message === `refused: ${code}`);

    assert.equal(h.doc.body.children.length, 0);
    assert.equal(h.clock.pending, 0);
    assert.equal(h.pair.app.listeners.size, 0);
  });
}

test('a host:error that carries no code is host_unreachable', async (t) => {
  const h = setup(t, { answers: { onHello: () => h.send(MSG.ERROR, { message: 'nope' }) } });
  await assert.rejects(h.transport.open(), { code: 'host_unreachable' });
});

test('an iframe error while opening rejects host_unreachable at once', async (t) => {
  const h = setup(t, { answers: { onHello: () => {} } });
  const opening = h.transport.open();
  const outcome = assert.rejects(opening, { code: 'host_unreachable' });
  await settle();

  h.doc.frames[0].fire('error');

  await outcome;
  assert.equal(h.clock.pending, 0);
  assert.equal(h.doc.body.children.length, 0);
});

test('a forged api:ready does not complete the handshake', async (t) => {
  const h = setup(t, { answers: { onHello: () => {} } });
  const opening = h.transport.open();
  await settle();
  const stranger = { postMessage() {} };
  const forged = { data: toParent(MSG.READY, READY), origin: h.hostOrigin, source: stranger };

  h.pair.app.dispatch(forged);
  h.pair.app.dispatch({ ...forged, source: h.pair.host, origin: 'https://evil.example' });
  assert.equal(await settled(opening), false);

  h.send(MSG.READY, READY);
  await opening;
});

test('hostOrigin must be a bare origin', () => {
  const pair = FakeWindowPair();
  for (const hostOrigin of [undefined, '', '*', 'valuguru.texpo.io', 'https://valuguru.texpo.io/', 'https://valuguru.texpo.io/host/', 'ftp://valuguru.texpo.io', 7]) {
    assert.throws(
      () => new HostTransport({ hostOrigin, window: pair.app, document: fakeDocumentFor(pair) }),
      TypeError,
      String(hostOrigin),
    );
  }
  assert.doesNotThrow(() => new HostTransport({ hostOrigin: 'http://localhost:3005', window: pair.app, document: fakeDocumentFor(pair) }));
});

// ---------------------------------------------------------------------------
// callService
// ---------------------------------------------------------------------------

test('callService posts api:call and resolves the ack', async (t) => {
  const h = setup(t);
  await h.transport.open();

  const call = h.transport.callService(READ, { a: 1 }, { timeoutMs: 5000 });

  const [post] = h.sent(MSG.CALL);
  assert.equal(h.sent(MSG.CALL).length, 1);
  assert.equal(post.targetOrigin, h.hostOrigin);
  const { requestId } = post.data.message;
  assert.equal(typeof requestId, 'number');
  assert.deepEqual(post.data, {
    name: 'api:call',
    message: { service: 'Users', action: 'current', params: { a: 1 }, requestId, timeoutMs: 5000 },
  });
  assert.equal(h.clock.pending, 2, 'the ping and this call\'s timeout');

  h.send(MSG.CALL_COMPLETED, { data: { id: 'u1' } }, requestId);

  assert.deepEqual(await call, { data: { id: 'u1' } });
  assert.equal(h.clock.pending, 1, 'the timeout is cleared once it answered');
});

test('callService passes an error ack through as it came', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const { call, requestId } = await callOut(h, WRITE);

  const refused = { error: { status: true, code: 403, message: 'consent_required', scope: 'x' } };
  h.send(MSG.CALL_COMPLETED, refused, requestId);

  assert.deepEqual(await call, refused);
});

test('callService local channel never reaches the host', async (t) => {
  const calls = [];
  const localTransport = { callService: async (...args) => { calls.push(args); return { data: { local: true } }; } };
  const h = setup(t, { localTransport });
  await h.transport.open();
  const local = findDescriptor('Time.get-local-time');
  assert.equal(local.channel, 'local');

  const ack = await h.transport.callService(local, { zone: 'x' }, { timeoutMs: 5000, attempt: 2 });

  assert.deepEqual(ack, { data: { local: true } });
  assert.deepEqual(calls, [[local, { zone: 'x' }, { timeoutMs: 5000, attempt: 2 }]]);
  assert.equal(h.sent(MSG.CALL).length, 0, 'nothing was posted to the host');
});

test('without a localTransport, local functions run in the page on a socketless SocketTransport', async (t) => {
  const fetchImpl = fakeFetch();
  const h = setup(t, {
    localTransport: undefined, fetchImpl, config: { webBase: 'https://app.example.test', apiGate: 'https://api.example.test' },
  });
  await h.transport.open();

  const time = await h.transport.callService(findDescriptor('Time.get-local-time'), {});
  const url = await h.transport.callService(findDescriptor('Resources.generate-public-url'), { resourceId: 'res-1' });
  const ping = await h.transport.callService(findDescriptor('Http.ping'), { url: 'https://example.test/health' });

  assert.equal(typeof time.data.iso, 'string');
  assert.match(JSON.stringify(url.data), /app\.example\.test/, 'the config reached it');
  assert.equal(ping.error, undefined);
  assert.equal(fetchImpl.puts.length, 1, 'the fetch reached it');
  assert.equal(h.sent(MSG.CALL).length, 0);
});

test('callService answers 408 timeout, and a late reply changes nothing', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const { call, requestId } = await callOut(h, READ, { timeoutMs: 100 });

  h.clock.tick(99);
  assert.equal(await settled(call), false);
  h.clock.tick(1);

  assert.deepEqual(await call, errorAck(408, 'timeout'));
  assert.equal(h.clock.pending, 1);
  h.send(MSG.CALL_COMPLETED, { data: 'late' }, requestId);
});

test('a write that was posted and timed out says it is not safe to repeat', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const { call } = await callOut(h, WRITE, { timeoutMs: 100 });

  h.clock.tick(100);

  assert.deepEqual(await call, { error: { status: true, code: 408, message: 'timeout', retryable: false } });
});

test('callService defaults to a 30 s timeout, and tells the host the one it uses', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const call = h.transport.callService(READ, {});
  assert.equal(h.sent(MSG.CALL)[0].data.message.timeoutMs, 30_000);
  h.clock.tick(29_999);
  assert.equal(await settled(call), false);
  h.clock.tick(1);
  assert.deepEqual(await call, errorAck(408, 'timeout'));
});

test('callService answers 503 host_unreachable when the post throws, and never rejects', async (t) => {
  const h = setup(t);
  await h.transport.open();
  h.pair.host.postMessage = () => { throw new Error('boom'); };

  const ack = await h.transport.callService(READ, {});

  assert.deepEqual(ack, errorAck(503, 'host_unreachable'));
  assert.equal(h.clock.pending, 1, 'the call left no timer');
});

test('callService answers 503 for a reply that is not an ack', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const { call, requestId } = await callOut(h);

  h.send(MSG.CALL_COMPLETED, 'nonsense', requestId);

  assert.deepEqual(await call, errorAck(503, 'host_unreachable'));
});

test('before open, a call answers 503 not_open, a request rejects and notify throws', async (t) => {
  const h = setup(t);

  assert.deepEqual(await h.transport.callService(READ, {}), errorAck(503, 'not_open'));
  await assert.rejects(h.transport.request(MSG.AUTH, { action: 'sign-out' }), { code: 'not_open' });
  assert.throws(() => h.transport.notify(MSG.AUTH, {}), { code: 'not_open' });
  assert.equal(h.doc.frames.length, 0, 'nothing opened the host by itself');
});

// ---------------------------------------------------------------------------
// who may speak
// ---------------------------------------------------------------------------

test('replies from a window other than the iframe are ignored', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const triggers = h.heard(Transport.TRIGGER);
  const { call, requestId } = await callOut(h);
  const stranger = { postMessage() {} };
  const reply = toParent(MSG.CALL_COMPLETED, { data: 'forged' }, requestId);
  const push = toParent(MSG.TRIGGER, { action: 'auth', data: { signedIn: false, user: null, network: null } });

  // another window, with the host's origin
  h.pair.app.dispatch({ data: reply, origin: h.hostOrigin, source: stranger });
  h.pair.app.dispatch({ data: push, origin: h.hostOrigin, source: stranger });
  // the iframe's window, from another origin
  h.pair.app.dispatch({ data: reply, origin: 'https://evil.example', source: h.pair.host });
  h.pair.app.dispatch({ data: push, origin: 'https://evil.example', source: h.pair.host });
  // no source at all
  h.pair.app.dispatch({ data: reply, origin: h.hostOrigin, source: null });
  // the right sender, not a valu-api message
  h.pair.app.dispatch({ data: { ...reply, target: 'somethingElse' }, origin: h.hostOrigin, source: h.pair.host });
  h.pair.app.dispatch({ data: 'api:call-completed', origin: h.hostOrigin, source: h.pair.host });
  h.pair.app.dispatch({ data: null, origin: h.hostOrigin, source: h.pair.host });

  assert.equal(await settled(call), false, 'none of them answered the call');
  assert.deepEqual(triggers, [], 'and none of them pushed');
  assert.equal(h.transport.hostState.signedIn, true);

  h.send(MSG.CALL_COMPLETED, { data: 'genuine' }, requestId);
  assert.deepEqual(await call, { data: 'genuine' });
});

test('a reply with a string requestId is ignored', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const { call, requestId } = await callOut(h);

  for (const wrong of [String(requestId), 987_654, null, undefined, NaN, { id: requestId }, [requestId]]) {
    h.send(MSG.CALL_COMPLETED, { data: 'wrong' }, wrong);
  }
  assert.equal(await settled(call), false, 'only the number the request went out with settles it');

  h.send(MSG.CALL_COMPLETED, { data: 'right' }, requestId);
  assert.deepEqual(await call, { data: 'right' });
});

test('a duplicate api:ready, or a host:error, after the handshake changes nothing', async (t) => {
  const h = setup(t);
  const ready = h.heard(Transport.READY);
  await h.transport.open();

  h.send(MSG.READY, { ...READY, host: { ...READY.host, signedIn: false } });
  h.send(MSG.ERROR, { code: 'nested', message: 'late' });

  assert.equal(ready.length, 1);
  assert.equal(h.transport.hostState.signedIn, true);
  assert.equal(h.transport.connected, true);
});

// ---------------------------------------------------------------------------
// request and notify
// ---------------------------------------------------------------------------

test('request posts the message with its requestId inside and resolves the reply verbatim', async (t) => {
  const h = setup(t);
  await h.transport.open();

  const mine = h.transport.request(MSG.SERVICE_INTENT, { applicationId: 'Commerce', action: 'get-cart', params: {} }, 4242);
  const [post] = h.sent(MSG.SERVICE_INTENT);
  assert.equal(post.targetOrigin, h.hostOrigin);
  assert.deepEqual(post.data, {
    name: 'api:service-intent',
    message: { applicationId: 'Commerce', action: 'get-cart', params: {}, requestId: 4242 },
  });
  h.send(MSG.RUN_CONSOLE_COMPLETED, { success: true, cart: [] }, 4242);
  assert.deepEqual(await mine, { success: true, cart: [] });

  const auto = h.transport.request(MSG.AUTH, { action: 'sign-out' });
  const { requestId } = h.sent(MSG.AUTH)[0].data.message;
  assert.equal(typeof requestId, 'number');
  h.send(MSG.AUTH_COMPLETED, { ok: true }, requestId);
  assert.deepEqual(await auto, { ok: true });

  const consent = h.transport.request(MSG.CONSENT, { scopes: ['x'] });
  const consentId = h.sent(MSG.CONSENT)[0].data.message.requestId;
  h.send(MSG.CONSENT_COMPLETED, { approved: false, reason: 'timeout' }, consentId);
  assert.deepEqual(await consent, { approved: false, reason: 'timeout' });
});

test('request rejects when the post throws, and leaves nothing pending', async (t) => {
  const h = setup(t);
  await h.transport.open();
  h.pair.host.postMessage = () => { throw new Error('boom'); };

  await assert.rejects(h.transport.request(MSG.AUTH, {}), /boom/);
});

test('notify posts without a requestId', async (t) => {
  const h = setup(t);
  await h.transport.open();

  h.transport.notify(MSG.AUTH, { action: 'x' });

  assert.deepEqual(h.sent(MSG.AUTH)[0].data, { name: 'host:auth', message: { action: 'x' } });
  assert.equal(h.sent(MSG.AUTH)[0].targetOrigin, h.hostOrigin);
});

// ---------------------------------------------------------------------------
// pushes
// ---------------------------------------------------------------------------

test('api:trigger connection reconnected emits RECONNECTED', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const triggers = h.heard(Transport.TRIGGER);
  const reconnected = h.heard(Transport.RECONNECTED);

  h.send(MSG.TRIGGER, { action: 'connection', data: { state: 'reconnecting' } });
  assert.equal(h.transport.connectionState, 'reconnecting');
  assert.equal(reconnected.length, 0);

  h.send(MSG.TRIGGER, { action: 'connection', data: { state: 'ready', reconnected: true } });

  assert.equal(h.transport.connectionState, 'ready');
  assert.deepEqual(reconnected, [{ state: 'ready', reconnected: true }]);
  assert.deepEqual(triggers, [
    { action: 'connection', data: { state: 'reconnecting' } },
    { action: 'connection', data: { state: 'ready', reconnected: true } },
  ], 'every push is also a TRIGGER, as it came');
});

test('api:trigger auth updates hostState, and every other push is forwarded as it came', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const triggers = h.heard(Transport.TRIGGER);

  h.send(MSG.TRIGGER, { action: 'auth', data: { signedIn: false, user: null, network: null, reason: 'session_expired' } });
  assert.deepEqual(h.transport.hostState, { ...READY.host, signedIn: false, user: null, network: null });

  h.send(MSG.TRIGGER, {
    action: 'auth', data: { signedIn: true, user: { id: 'u2', name: 'Bo' }, network: { id: 'n1', name: 'Roomful' } },
  });
  assert.deepEqual(h.transport.hostState.user, { id: 'u2', name: 'Bo' });
  assert.equal(h.transport.hostState.protocol, 1);
  assert.equal(h.transport.hostState.mode, 'dedicated');

  h.send(MSG.TRIGGER, { action: 'commerce', data: { event: 'cart-updated', count: 2 } });
  assert.equal(triggers.length, 3);
  assert.deepEqual(triggers[2], { action: 'commerce', data: { event: 'cart-updated', count: 2 } });
  assert.equal(h.transport.hostState.user.id, 'u2', 'a Commerce push does not touch the state');
});

test('hostState is a copy: changing it changes nothing', async (t) => {
  const h = setup(t);
  await h.transport.open();
  h.transport.hostState.signedIn = false;
  assert.equal(h.transport.hostState.signedIn, true);
});

// ---------------------------------------------------------------------------
// ping and recovery
// ---------------------------------------------------------------------------

test('ping posts host:ping with a requestId every interval, and a pong keeps the host', async (t) => {
  const h = setup(t);
  await h.transport.open();

  h.clock.tick(4999);
  assert.equal(h.sent(MSG.PING).length, 0);
  h.clock.tick(1);
  h.clock.tick(5000);
  h.clock.tick(5000);

  const pings = h.sent(MSG.PING);
  assert.equal(pings.length, 3);
  assert.equal(pings[0].targetOrigin, h.hostOrigin);
  assert.deepEqual(Object.keys(pings[0].data), ['name', 'message']);
  assert.equal(typeof pings[0].data.message.requestId, 'number');
  assert.equal(new Set(pings.map((p) => p.data.message.requestId)).size, 3);
  await settle();
  assert.equal(h.doc.frames.length, 1, 'answered pings never reload the iframe');
  assert.equal(h.clock.pending, 1);
});

test('missed pong reloads the iframe once and fails in-flight calls with host_restarted', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const triggers = h.heard(Transport.TRIGGER);
  const reconnected = h.heard(Transport.RECONNECTED);
  const ready = h.heard(Transport.READY);
  const { call } = await callOut(h);
  const request = h.transport.request(MSG.AUTH, { action: 'sign-out' });
  const requestOutcome = assert.rejects(request, (error) => error.code === 'host_restarted');
  const [firstFrame] = h.doc.frames;

  h.clock.tick(5000);
  h.clock.tick(5000);
  h.answers.ping = false;
  h.clock.tick(5000);
  assert.equal(h.sent(MSG.PING).length, 3);
  h.clock.tick(1999);
  await settle();
  assert.equal(h.doc.frames.length, 1, 'not yet: the pong has until pingTimeoutMs');
  assert.equal(await settled(call), false);

  h.clock.tick(1);
  await settle();

  assert.deepEqual(await call, errorAck(503, 'host_restarted'));
  await requestOutcome;
  assert.equal(h.doc.frames.length, 2, 'one new iframe');
  assert.equal(firstFrame.parentNode, null, 'the old one is removed');
  assert.equal(h.doc.frames[1].parentNode, h.doc.body);
  assert.equal(h.doc.frames[1].src, `${h.hostOrigin}/host/`);
  assert.equal(h.sent(MSG.HELLO).length, 2, 'the handshake ran again');
  assert.equal(h.transport.connected, true);
  assert.equal(h.transport.connectionState, 'ready');
  assert.deepEqual(triggers, [
    { action: 'connection', data: { state: 'reconnecting' } },
    { action: 'connection', data: { state: 'ready', reconnected: true } },
  ]);
  assert.deepEqual(reconnected, [{ state: 'ready', reconnected: true }], 'the SDK cache is told to clear');
  assert.equal(ready.length, 0, 'an app\'s onCreate is not run again');
  assert.equal(h.clock.pending, 1, 'the dead call left no timer; the ping runs again');

  // the new host serves, and is pinged
  const next = await callOut(h);
  h.send(MSG.CALL_COMPLETED, { data: 'again' }, next.requestId);
  assert.deepEqual(await next.call, { data: 'again' });
  h.clock.tick(5000);
  assert.equal(h.sent(MSG.PING).length, 4);
  assert.equal(h.doc.frames.length, 2, 'and an answered ping does not reload it');
});

test('a pong for another ping does not count', async (t) => {
  const h = setup(t);
  await h.transport.open();
  h.answers.ping = false;
  h.clock.tick(5000);
  const { requestId } = h.sent(MSG.PING)[0].data.message;

  h.send(MSG.PONG, {}, requestId + 1000);
  h.send(MSG.PONG, {}, String(requestId));
  h.clock.tick(2000);
  await settle();

  assert.equal(h.doc.frames.length, 2);
});

test('a write that was in flight when the host died is not safe to repeat', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const { call } = await callOut(h, WRITE);

  h.doc.frames[0].fire('error');
  await settle();

  assert.deepEqual(await call, { error: { status: true, code: 503, message: 'host_restarted', retryable: false } });
});

test('an iframe error event recovers the same way', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const reconnected = h.heard(Transport.RECONNECTED);
  const { call } = await callOut(h);

  h.doc.frames[0].fire('error');
  await settle();

  assert.deepEqual(await call, errorAck(503, 'host_restarted'));
  assert.equal(h.doc.frames.length, 2);
  assert.equal(reconnected.length, 1);

  h.doc.frames[0].fire('error');
  await settle();
  assert.equal(h.doc.frames.length, 2, 'an error from the iframe that was replaced is not this one\'s');
});

test('a second failure is host_unreachable, pushed as connection offline', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const triggers = h.heard(Transport.TRIGGER);
  const reconnected = h.heard(Transport.RECONNECTED);
  h.answers.ping = false;
  h.answers.onHello = () => {};
  h.clock.tick(5000);
  h.clock.tick(2000);
  await settle();
  assert.equal(h.doc.frames.length, 2);
  const held = h.transport.callService(READ, {}, { timeoutMs: 60_000 });
  const heldRequest = h.transport.request(MSG.AUTH, {});
  const heldOutcome = assert.rejects(heldRequest, { code: 'host_unreachable' });
  await settle();
  assert.equal(h.sent(MSG.CALL).length, 0, 'a call made while the host is coming back waits for it');

  h.clock.tick(1000);
  await settle();

  assert.deepEqual(await held, errorAck(503, 'host_unreachable'));
  await heldOutcome;
  assert.deepEqual(triggers, [
    { action: 'connection', data: { state: 'reconnecting' } },
    { action: 'connection', data: { state: 'offline', reason: 'host_unreachable' } },
  ]);
  assert.equal(h.transport.connectionState, 'offline');
  assert.equal(h.transport.connected, false);
  assert.equal(reconnected.length, 0);
  assert.equal(h.doc.frames.length, 2, 'it tried once, and no more');
  assert.equal(h.doc.body.children.length, 0);
  assert.equal(h.clock.pending, 0, 'no ping, no timeout, nothing left');

  assert.deepEqual(await h.transport.callService(READ, {}), errorAck(503, 'host_unreachable'));
  await assert.rejects(h.transport.request(MSG.AUTH, {}), { code: 'host_unreachable' });
});

test('the reason of connection offline is the host\'s own error code, host_unreachable only when it gave none', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const triggers = h.heard(Transport.TRIGGER);
  h.answers.onHello = () => h.send(MSG.ERROR, { code: 'unknown_app', message: 'gone' });

  h.doc.frames[0].fire('error');
  await settle();

  assert.deepEqual(triggers[1], { action: 'connection', data: { state: 'offline', reason: 'unknown_app' } });
  assert.equal(h.clock.pending, 0);
});

test('a call made while the host is coming back is held, then sent to the new host', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const earlier = await callOut(h);
  h.send(MSG.CALL_COMPLETED, { data: 'earlier' }, earlier.requestId);
  await earlier.call;
  h.answers.onHello = () => {};
  h.doc.frames[0].fire('error');
  await settle();

  const call = h.transport.callService(READ, {}, { timeoutMs: 60_000 });
  await settle();
  assert.equal(h.sent(MSG.CALL).length, 1, 'only the earlier call went out');
  // The ids are a counter, so a host that guessed this call's could answer it
  // before it was sent: that answers nothing.
  h.send(MSG.CALL_COMPLETED, { data: 'guessed' }, earlier.requestId + 1);
  assert.equal(await settled(call), false);

  h.send(MSG.READY, READY);
  await settle();

  const post = h.sent(MSG.CALL)[1];
  assert.equal(h.sent(MSG.CALL).length, 2);
  assert.equal(post.data.message.requestId, earlier.requestId + 1);
  h.send(MSG.CALL_COMPLETED, { data: 'held' }, post.data.message.requestId);
  assert.deepEqual(await call, { data: 'held' });
});

test('a call held for one recovery is not failed by the next one, which starts before it was sent', async (t) => {
  const h = setup(t);
  await h.transport.open();
  h.answers.onHello = () => {};
  h.doc.frames[0].fire('error');
  await settle();
  const call = h.transport.callService(READ, {}, { timeoutMs: 60_000 });
  await settle();
  // The new frame dies the moment the app hears of the reconnect, before the
  // held call has been sent.
  h.transport.addEventListener(Transport.RECONNECTED, () => {
    h.answers.onHello = () => h.send(MSG.READY, READY);
    h.doc.frames[1].fire('error');
  });

  h.send(MSG.READY, READY);
  await settle();

  assert.equal(h.doc.frames.length, 3);
  const posts = h.sent(MSG.CALL);
  assert.equal(posts.length, 1, 'sent once, to the third frame');
  h.send(MSG.CALL_COMPLETED, { data: 'held' }, posts[0].data.message.requestId);
  assert.deepEqual(await call, { data: 'held' });
  assert.equal(h.clock.pending, 1, 'one ping chain, not two');
});

test('a held call still times out on its own clock', async (t) => {
  const h = setup(t);
  await h.transport.open();
  h.answers.onHello = () => {};
  h.doc.frames[0].fire('error');
  await settle();

  const call = h.transport.callService(READ, {}, { timeoutMs: 300 });
  h.clock.tick(300);

  assert.deepEqual(await call, errorAck(408, 'timeout'));
  h.send(MSG.READY, READY);
  await settle();
  assert.equal(h.sent(MSG.CALL).length, 0, 'and is not sent once it has answered');
});

test('a host that comes back signed out announces the change', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const triggers = h.heard(Transport.TRIGGER);
  const signedOut = { ...READY, host: { ...READY.host, signedIn: false, user: null, network: null } };
  h.answers.ready = signedOut;

  h.doc.frames[0].fire('error');
  await settle();

  assert.deepEqual(triggers, [
    { action: 'connection', data: { state: 'reconnecting' } },
    { action: 'auth', data: { signedIn: false, user: null, network: null } },
    { action: 'connection', data: { state: 'signed_out', reconnected: true } },
  ]);
  assert.deepEqual(h.transport.hostState, signedOut.host);
  assert.equal(h.transport.connectionState, 'signed_out');
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

test('close removes the iframe, stops the ping and rejects what is pending with transport closed', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const { call } = await callOut(h);
  const request = h.transport.request(MSG.AUTH, {});
  const outcome = assert.rejects(request, new Error('transport closed'));

  await h.transport.close();

  assert.deepEqual(await call, errorAck(503, 'transport closed'));
  await outcome;
  assert.equal(h.doc.body.children.length, 0);
  assert.equal(h.clock.pending, 0);
  assert.equal(h.pair.app.listeners.size, 0);
  assert.equal(h.transport.connected, false);

  h.clock.tick(60_000);
  h.send(MSG.TRIGGER, { action: 'auth', data: { signedIn: false, user: null, network: null } });
  assert.equal(h.sent(MSG.PING).length, 0);

  assert.deepEqual(await h.transport.callService(READ, {}), errorAck(503, 'transport closed'));
  await assert.rejects(h.transport.request(MSG.AUTH, {}), /transport closed/);
  await assert.rejects(h.transport.open(), /transport closed/);
  await h.transport.close();
});

test('close during open rejects open', async (t) => {
  const h = setup(t, { answers: { onHello: () => {} } });
  const opening = h.transport.open();
  const outcome = assert.rejects(opening, /transport closed/);
  await settle();

  await h.transport.close();

  await outcome;
  assert.equal(h.doc.body.children.length, 0);
  assert.equal(h.clock.pending, 0);
});

test('close during a recovery ends it', async (t) => {
  const h = setup(t);
  await h.transport.open();
  h.answers.onHello = () => {};
  h.doc.frames[0].fire('error');
  await settle();
  const held = h.transport.callService(READ, {}, { timeoutMs: 60_000 });

  await h.transport.close();
  await settle();

  assert.deepEqual(await held, errorAck(503, 'transport closed'));
  assert.equal(h.doc.body.children.length, 0);
  assert.equal(h.clock.pending, 0);
});

test('close from a listener of the reconnecting push starts nothing', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const { call } = await callOut(h);
  h.transport.addEventListener(Transport.TRIGGER, (message) => {
    if (message.data?.state === 'reconnecting') h.transport.close();
  });

  h.doc.frames[0].fire('error');
  await settle();

  assert.equal(h.doc.frames.length, 1, 'no new iframe was made');
  assert.equal(h.doc.body.children.length, 0);
  assert.equal(h.sent(MSG.HELLO).length, 1, 'and no new hello was posted');
  assert.equal(h.clock.pending, 0, 'no ready timer, no ping');
  assert.equal(h.pair.app.listeners.size, 0);
  assert.deepEqual(await call, errorAck(503, 'host_restarted'), 'what was in flight was answered before the push');
  assert.deepEqual(await h.transport.callService(READ, {}), errorAck(503, 'transport closed'));
});

test('close from a listener of the auth push after a recovery says no reconnect', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const triggers = h.heard(Transport.TRIGGER);
  const reconnected = h.heard(Transport.RECONNECTED);
  h.answers.ready = { ...READY, host: { ...READY.host, signedIn: false, user: null, network: null } };
  h.transport.addEventListener(Transport.TRIGGER, (message) => {
    if (message.action === 'auth') h.transport.close();
  });

  h.doc.frames[0].fire('error');
  await settle();

  assert.deepEqual(triggers.map((m) => m.action), ['connection', 'auth'], 'reconnecting, then the auth change, then nothing');
  assert.deepEqual(reconnected, []);
  assert.equal(h.doc.body.children.length, 0);
  assert.equal(h.clock.pending, 0, 'the ping the recovery started is stopped');
  assert.equal(h.transport.connected, false);
});

test('a listener that loses the new host again keeps its own recovery, and the old one announces nothing', async (t) => {
  const h = setup(t);
  await h.transport.open();
  const reconnected = h.heard(Transport.RECONNECTED);
  h.answers.ready = { ...READY, host: { ...READY.host, signedIn: false, user: null, network: null } };
  let once = true;
  h.transport.addEventListener(Transport.TRIGGER, (message) => {
    if (message.action === 'auth' && once) {
      once = false;
      h.doc.frames[1].fire('error');
    }
  });

  h.doc.frames[0].fire('error');
  await settle();

  assert.equal(h.doc.frames.length, 3, 'the second death is recovered once');
  assert.equal(reconnected.length, 1, 'one reconnect, from the host that stayed');
  assert.equal(h.clock.pending, 1, 'one ping chain');
});

test('close does not close a localTransport it was given', async (t) => {
  let closed = 0;
  const h = setup(t, { localTransport: { callService: async () => ({}), close: async () => { closed += 1; } } });
  await h.transport.open();
  await h.transport.close();
  assert.equal(closed, 0);
});
