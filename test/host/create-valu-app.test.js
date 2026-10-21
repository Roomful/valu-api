// ===========================================================================
// createValuApp — the one entry point an app uses (spec §4.8, §4.4 steps 1 and
// 5, §4.6 "Consent flow", §4.11 "Observable").
//
// Dedicated mode runs over a FakeWindowPair (the app page and the host iframe),
// a fake document and a fake clock; the host is a few lines that answer hello,
// ping and `api:call` the way HostBridge does, and everything else it says the
// test says by hand with `send`. Embedded mode runs over a FakeWindow whose
// parent is the embedding application. Popups are a fake `popup` function that
// records what it was asked and hands back a window the test can close.
//
// The numbers a test ticks past are the module's: the sign-in popup is polled
// every 500 ms, and a closed one is given 10 s to be followed by its result
// (the sign-in page closes itself right after it hands the token over, and the
// host is still redeeming it).
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createValuApp, HostTransport as ExportedHostTransport, ValuApi, Intent, ValuServiceApi,
} from '../../src/ValuApi.js';
import { HostTransport } from '../../src/transport/HostTransport.js';
import { MSG, toParent } from '../../src/host/protocol.js';
import { findDescriptor } from '../../src/services/descriptors.js';
import { FakeWindowPair, fakeDocumentFor, fakeClock } from '../helpers/hostFakes.js';
import { FakeWindow } from '../helpers/fakes.js';

const POLL_MS = 500;
const CLOSED_GRACE_MS = 10_000;
const SIGN_IN_TIMEOUT_MS = 300_000;

const settle = () => new Promise((resolve) => { setImmediate(resolve); });

const USER = { id: 'u1', name: 'Ada Lovelace' };
const NETWORK = { id: 'n1', name: 'Roomful' };
const READY = {
  applicationId: 'ws_1/demo',
  action: 'start',
  params: {},
  host: { protocol: 1, mode: 'dedicated', signedIn: true, user: USER, network: NETWORK },
};
const SIGNED_OUT = { ...READY, host: { ...READY.host, signedIn: false, user: null, network: null } };
const SIGNED_IN_PUSH = { action: 'auth', data: { signedIn: true, user: USER, network: NETWORK } };

const CONSENT_REQUIRED = { error: { status: true, code: 403, message: 'consent_required', scope: 'rooms:read' } };

/** A promise's outcome, tracked from the moment it is made (so a rejection is never unhandled). */
function track(promise) {
  const box = { settled: false, value: undefined, error: undefined };
  promise.then(
    (value) => { box.settled = true; box.value = value; },
    (error) => { box.settled = true; box.error = error; },
  );
  return box;
}

/** `window.open`, as a test sees it: what it was asked, and the windows it handed out. */
function fakePopups() {
  const open = (url, name, features) => {
    open.calls.push({ url, name, features });
    open.onOpen?.();
    if (open.blocked) return null;
    const win = { closed: false, close() { win.closed = true; } };
    open.windows.push(win);
    return win;
  };
  open.calls = [];
  open.windows = [];
  open.blocked = false;
  open.onOpen = null;
  return open;
}

/**
 * The app page, its host iframe and the world around them. `create()` makes the
 * app; `setup` makes it and waits for the handshake.
 */
function harness(t, { ready = READY, search = '', activation = false, framedBy, ...options } = {}) {
  const pair = FakeWindowPair();
  pair.app.location = { search };
  pair.app.navigator = { userActivation: { isActive: activation } };
  if (framedBy) pair.app.parent = framedBy;
  const doc = fakeDocumentFor(pair);
  const clock = fakeClock();
  const popups = fakePopups();
  const send = (name, message, requestId) => pair.app.postMessage(toParent(name, message, requestId), pair.app.origin);
  const host = {
    ready,
    /** Whether the host answers `host:ping`; off, it looks dead. */
    ping: true,
    onHello: () => send(MSG.READY, host.ready),
    call: () => ({ data: { id: 'x' } }),
    intent: () => ({ success: true }),
  };
  pair.host.addEventListener('message', ({ data }) => {
    const { name, message } = data;
    if (name === MSG.HELLO) host.onHello();
    else if (name === MSG.PING) { if (host.ping) send(MSG.PONG, {}, message.requestId); }
    else if (name === MSG.CALL) send(MSG.CALL_COMPLETED, host.call(message), message.requestId);
    else if (name === MSG.SERVICE_INTENT) send(MSG.RUN_CONSOLE_COMPLETED, host.intent(message), message.requestId);
    else if (name === MSG.RUN_INTENT) send(MSG.RUN_COMPLETED, { error: { code: 'not_available' } }, message.requestId);
  });
  const sent = (name) => pair.host.posted.filter((post) => post.data.name === name);
  const h = {
    pair, doc, clock, popups, host, send, sent, valu: null,
    create: () => createValuApp({
      window: pair.app,
      document: doc,
      popup: popups,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      ...options,
    }),
  };
  t.after(() => h.valu?.close());
  return h;
}

async function setup(t, options) {
  const h = harness(t, options);
  h.valu = await h.create();
  return h;
}

/** An embedded page: a window framed by the Valu Social application, which is `parent`. */
function embeddedHarness(t, options = {}) {
  const win = new FakeWindow();
  win.parent = win.appSource();
  win.location = { search: '' };
  win.navigator = {};
  const noDocument = { createElement() { throw new Error('embedded mode makes no iframe'); } };
  const h = { win, valu: null };
  h.create = () => createValuApp({ window: win, document: noDocument, ...options });
  t.after(() => h.valu?.close());
  return h;
}

async function setupEmbedded(t, options) {
  const h = embeddedHarness(t, options);
  h.valu = await h.create();
  return h;
}

// ---------------------------------------------------------------------------
// The package entry
// ---------------------------------------------------------------------------

test('createValuApp and HostTransport are exported from the package entry', () => {
  assert.equal(typeof createValuApp, 'function');
  assert.equal(ExportedHostTransport, HostTransport);
});

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

test('top-level page is dedicated and framed page is embedded', async (t) => {
  const top = await setup(t);
  assert.equal(top.valu.mode, 'dedicated');
  assert.equal(top.doc.frames.length, 1, 'the host iframe is injected');
  assert.equal(top.doc.frames[0].src, 'https://valuguru.texpo.io/host/', 'the default hostOrigin');

  const framed = await setupEmbedded(t);
  assert.equal(framed.valu.mode, 'embedded');
});

test('?valu-mode=dedicated forces dedicated in a frame', async (t) => {
  const forced = await setup(t, { framedBy: {}, search: '?x=1&valu-mode=dedicated' });
  assert.equal(forced.valu.mode, 'dedicated');
  assert.equal(forced.doc.frames.length, 1);
});

test('a frame without the query parameter, or with another value, is embedded', async (t) => {
  for (const search of ['', '?valu-mode=embedded', '?valu-mode=', '?other=dedicated', '?valu-mode=Dedicated']) {
    const h = await setup(t, { framedBy: {}, search });
    assert.equal(h.valu.mode, 'embedded', search);
    assert.equal(h.doc.frames.length, 0, 'no iframe is injected in embedded mode');
  }
});

test('the mode option wins over the page and the query', async (t) => {
  const embedded = await setup(t, { mode: 'embedded', search: '?valu-mode=dedicated' });
  assert.equal(embedded.valu.mode, 'embedded');

  const dedicated = await setup(t, { mode: 'dedicated', framedBy: {} });
  assert.equal(dedicated.valu.mode, 'dedicated');
});

test('configuration mistakes reject before anything is made', async (t) => {
  for (const options of [
    { mode: 'both' },
    { hostOrigin: 'https://valuguru.texpo.io/' },
    { hostOrigin: 'valuguru.texpo.io' },
    { signInOrigin: 'https://live.valuverse.io/auth' },
    { signInOrigin: '*' },
  ]) {
    const h = harness(t, options);
    await assert.rejects(h.create(), TypeError, JSON.stringify(options));
    assert.equal(h.doc.frames.length, 0, 'no iframe');
    assert.equal(h.pair.app.listeners.size, 0, 'no listener');
    assert.equal(h.clock.pending, 0, 'no timer');
  }
});

// ---------------------------------------------------------------------------
// Opening the host
// ---------------------------------------------------------------------------

test('the app option reaches the host in host:hello, and is absent without it', async (t) => {
  const named = await setup(t, { app: 'ws_057a1a6e/valu-api-sample' });
  const [hello] = named.sent(MSG.HELLO);
  assert.equal(hello.data.message.app, 'ws_057a1a6e/valu-api-sample');

  const plain = await setup(t);
  assert.equal(Object.hasOwn(plain.sent(MSG.HELLO)[0].data.message, 'app'), false);

  // Embedded mode has no host and ignores it: nothing is posted to the parent, hello or otherwise.
  const embedded = await setupEmbedded(t, { app: 'ws_057a1a6e/valu-api-sample' });
  assert.equal(embedded.valu.mode, 'embedded');
  assert.deepEqual(embedded.win.posted, [], 'nothing was posted to the fake target');
});

test('a host that does not answer rejects host_unreachable and leaves nothing behind', async (t) => {
  const h = harness(t);
  h.host.onHello = () => {};
  const outcome = track(h.create());
  await settle();
  assert.equal(outcome.settled, false, 'waiting for api:ready');

  h.clock.tick(10_000);
  await settle();

  assert.equal(outcome.error.code, 'host_unreachable');
  assert.equal(h.doc.frames[0].parentNode, null, 'the iframe is gone');
  assert.equal(h.pair.app.listeners.size, 0);
  assert.equal(h.clock.pending, 0);
});

test('a host:error rejects with its code', async (t) => {
  for (const code of ['unknown_app', 'nested', 'bad_origin', 'protocol_unsupported', 'resolve_unavailable']) {
    const h = harness(t);
    h.host.onHello = () => h.send(MSG.ERROR, { code, message: `refused: ${code}` });
    const outcome = track(h.create());
    await settle();
    assert.equal(outcome.error.code, code);
    assert.equal(h.doc.frames[0].parentNode, null);
    assert.equal(h.clock.pending, 0);
  }
});

test('the api:ready launch intent reaches the application the app registers afterwards', async (t) => {
  const h = await setup(t);
  const seen = [];
  h.valu.bridge.setApplication({ onCreate: async (intent) => { seen.push(intent); } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].applicationId, 'ws_1/demo');
  assert.equal(seen[0].action, 'start');
});

test('ready resolves in dedicated mode, which only returns once the host is there', async (t) => {
  const h = await setup(t);
  await h.valu.ready;
  assert.equal(h.valu.connection.state, 'ready');
});

// ---------------------------------------------------------------------------
// State: auth, network, connection
// ---------------------------------------------------------------------------

test('auth.state and network come from api:ready', async (t) => {
  const signedIn = await setup(t);
  assert.deepEqual(signedIn.valu.auth.state, { signedIn: true, user: USER, network: NETWORK });
  assert.deepEqual(signedIn.valu.network, NETWORK);
  assert.equal(signedIn.valu.connection.state, 'ready');

  const signedOut = await setup(t, { ready: SIGNED_OUT });
  assert.deepEqual(signedOut.valu.auth.state, { signedIn: false, user: null, network: null });
  assert.equal(signedOut.valu.network, null);
  assert.equal(signedOut.valu.connection.state, 'signed_out');
});

test('auth.on change fires on every auth push, with the new state, and stops when unsubscribed', async (t) => {
  const h = await setup(t, { ready: SIGNED_OUT });
  const seen = [];
  const off = h.valu.auth.on('change', (state) => seen.push(state));

  h.send(MSG.TRIGGER, SIGNED_IN_PUSH);
  assert.deepEqual(seen, [{ signedIn: true, user: USER, network: NETWORK }]);
  assert.deepEqual(h.valu.auth.state, seen[0]);
  assert.deepEqual(h.valu.network, NETWORK);

  h.send(MSG.TRIGGER, { action: 'auth', data: { signedIn: false, user: null, network: null } });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].signedIn, false);

  off();
  h.send(MSG.TRIGGER, SIGNED_IN_PUSH);
  assert.equal(seen.length, 2, 'unsubscribed');
});

test('the reason of the last auth push is in the state until the next push', async (t) => {
  const h = await setup(t);
  h.send(MSG.TRIGGER, { action: 'auth', data: { signedIn: false, user: null, network: null, reason: 'session_expired' } });
  assert.deepEqual(h.valu.auth.state, { signedIn: false, user: null, network: null, reason: 'session_expired' });

  h.send(MSG.TRIGGER, SIGNED_IN_PUSH);
  assert.deepEqual(h.valu.auth.state, { signedIn: true, user: USER, network: NETWORK });
});

test('a state read is a copy: changing it changes nothing', async (t) => {
  const h = await setup(t);
  const state = h.valu.auth.state;
  state.signedIn = false;
  assert.equal(h.valu.auth.state.signedIn, true);
});

test('connection.on change reports every connection push, and lastError follows the reason', async (t) => {
  const h = await setup(t);
  assert.equal(h.valu.connection.lastError, null);
  const seen = [];
  const off = h.valu.connection.on('change', (change) => seen.push(change));

  h.send(MSG.TRIGGER, { action: 'connection', data: { state: 'reconnecting' } });
  assert.equal(h.valu.connection.state, 'reconnecting');
  h.send(MSG.TRIGGER, { action: 'connection', data: { state: 'ready', reconnected: true } });
  h.send(MSG.TRIGGER, { action: 'connection', data: { state: 'offline', reason: 'host_unreachable' } });
  assert.deepEqual(h.valu.connection.lastError, { code: 'host_unreachable' });
  h.send(MSG.TRIGGER, { action: 'connection', data: { state: 'ready' } });
  assert.equal(h.valu.connection.lastError, null, 'a link that is back has no error');

  assert.deepEqual(seen, [
    { state: 'reconnecting', reconnected: false, lastError: null },
    { state: 'ready', reconnected: true, lastError: null },
    { state: 'offline', reconnected: false, lastError: { code: 'host_unreachable' } },
    { state: 'ready', reconnected: false, lastError: null },
  ]);

  off();
  h.send(MSG.TRIGGER, { action: 'connection', data: { state: 'reconnecting' } });
  assert.equal(seen.length, 4);
});

test('on accepts only change, with a function', async (t) => {
  const h = await setup(t);
  for (const target of [h.valu.auth, h.valu.connection]) {
    assert.throws(() => target.on('signedIn', () => {}), TypeError);
    assert.throws(() => target.on('change', 'not a function'), TypeError);
  }
});

test('a listener that throws does not stop the others or the transport', async (t) => {
  const h = await setup(t, { ready: SIGNED_OUT });
  const errors = t.mock.method(console, 'error', () => {});
  const seen = [];
  h.valu.auth.on('change', () => { throw new Error('boom'); });
  h.valu.auth.on('change', (state) => seen.push(state.signedIn));

  h.send(MSG.TRIGGER, SIGNED_IN_PUSH);

  assert.deepEqual(seen, [true]);
  assert.equal(errors.mock.callCount(), 1);
});

// ---------------------------------------------------------------------------
// signIn
// ---------------------------------------------------------------------------

test('signIn opens the popup synchronously before any await', async (t) => {
  const h = await setup(t, { ready: SIGNED_OUT });
  const order = [];
  let microtaskRan = false;
  h.popups.onOpen = () => order.push(microtaskRan ? 'popup after a microtask' : 'popup before any await');
  queueMicrotask(() => { microtaskRan = true; order.push('microtask'); });

  const outcome = track(h.valu.auth.signIn());

  assert.deepEqual(order, ['popup before any await']);
  await settle();
  assert.deepEqual(order, ['popup before any await', 'microtask']);
  assert.equal(outcome.settled, false);
});

test('signIn opens the sign-in page of the configured origin, named valu-signin', async (t) => {
  const h = await setup(t, { ready: SIGNED_OUT });
  const outcome = track(h.valu.auth.signIn());
  assert.deepEqual(h.popups.calls, [{
    url: 'https://live.valuverse.io/auth/host',
    name: 'valu-signin',
    features: 'popup,width=480,height=640',
  }]);

  const chabad = await setup(t, { ready: SIGNED_OUT, signInOrigin: 'https://chabaduniverse.com' });
  const second = track(chabad.valu.auth.signIn());
  assert.equal(chabad.popups.calls[0].url, 'https://chabaduniverse.com/auth/host');
  assert.equal(outcome.settled || second.settled, false);
});

test('popup urls are built from the configured origins and nothing the host says', async (t) => {
  const h = await setup(t, { ready: { ...SIGNED_OUT, signInOrigin: 'https://evil.test', url: 'https://evil.test/x' } });
  h.send(MSG.TRIGGER, { action: 'auth', data: { signedIn: false, user: null, network: null, signInOrigin: 'https://evil.test', url: 'https://evil.test/y' } });
  h.send(MSG.TRIGGER, { action: 'connection', data: { state: 'ready', url: 'https://evil.test/z' } });
  const outcome = track(h.valu.auth.signIn());
  const consent = track(h.valu.auth.requestConsent(['rooms:read']));

  assert.equal(h.popups.calls[0].url, 'https://live.valuverse.io/auth/host');
  assert.match(h.popups.calls[1].url, /^https:\/\/valuguru\.texpo\.io\/host\/consent\.html\?nonce=[0-9a-f]+$/);
  assert.equal(outcome.settled || consent.settled, false);
});

test('signIn rejects popup_blocked on null, and a later call works', async (t) => {
  const h = await setup(t, { ready: SIGNED_OUT });
  h.popups.blocked = true;
  const base = h.clock.pending;

  await assert.rejects(h.valu.auth.signIn(), { code: 'popup_blocked' });
  assert.equal(h.clock.pending, base, 'no timer for a popup that never opened');

  h.popups.blocked = false;
  const outcome = track(h.valu.auth.signIn());
  h.send(MSG.TRIGGER, SIGNED_IN_PUSH);
  await settle();
  assert.equal(outcome.value.signedIn, true);
});

test('signIn rejects popup_blocked when opening the popup throws', async (t) => {
  const h = await setup(t, {
    ready: SIGNED_OUT,
    popup: () => { throw new Error('SecurityError: sandboxed'); },
  });
  await assert.rejects(h.valu.auth.signIn(), { code: 'popup_blocked' });
});

test('signIn resolves on the auth trigger', async (t) => {
  const h = await setup(t, { ready: SIGNED_OUT });
  const base = h.clock.pending;
  const changes = [];
  h.valu.auth.on('change', (state) => changes.push(state));

  const outcome = track(h.valu.auth.signIn());
  await settle();
  assert.equal(outcome.settled, false, 'nothing yet');
  assert.equal(h.valu.auth.state.signedIn, false);

  h.send(MSG.TRIGGER, SIGNED_IN_PUSH);
  await settle();

  assert.deepEqual(outcome.value, { signedIn: true, user: USER, network: NETWORK });
  assert.deepEqual(changes, [outcome.value]);
  assert.equal(h.clock.pending, base, 'the poll and the deadline are gone');
});

test('signIn rejects cancelled on a cancelled push, signed in or not', async (t) => {
  for (const signedIn of [false, true]) {
    const h = await setup(t, { ready: signedIn ? READY : SIGNED_OUT });
    const base = h.clock.pending;
    const outcome = track(h.valu.auth.signIn());

    // The host's cancelled push carries the CURRENT signedIn: the reason comes first.
    h.send(MSG.TRIGGER, { action: 'auth', data: { signedIn, user: signedIn ? USER : null, network: signedIn ? NETWORK : null, reason: 'cancelled' } });
    await settle();

    assert.equal(outcome.error?.code, 'cancelled', `signedIn ${signedIn}`);
    assert.equal(h.clock.pending, base);
  }
});

test('signIn rejects with the reason the host gives', async (t) => {
  for (const reason of ['master_mismatch', 'not_a_member', 'invalid_token', 'unavailable']) {
    for (const signedIn of [false, true]) {
      const h = await setup(t, { ready: signedIn ? READY : SIGNED_OUT });
      const base = h.clock.pending;
      const outcome = track(h.valu.auth.signIn());

      h.send(MSG.TRIGGER, { action: 'auth', data: { signedIn, user: signedIn ? USER : null, network: null, reason } });
      await settle();

      assert.equal(outcome.error?.code, reason, `${reason} with signedIn ${signedIn}`);
      assert.ok(outcome.error instanceof Error);
      assert.equal(h.clock.pending, base);
    }
  }
});

test('master_mismatch rejects with its code', async (t) => {
  const h = await setup(t, { ready: SIGNED_OUT });
  const outcome = track(h.valu.auth.signIn());
  h.send(MSG.TRIGGER, { action: 'auth', data: { signedIn: false, user: null, network: null, reason: 'master_mismatch' } });
  await settle();
  assert.equal(outcome.error.code, 'master_mismatch');
  assert.equal(h.valu.auth.state.reason, 'master_mismatch');
});

test('a push that is not an answer leaves signIn waiting', async (t) => {
  const h = await setup(t, { ready: SIGNED_OUT });
  const outcome = track(h.valu.auth.signIn());

  h.send(MSG.TRIGGER, { action: 'auth', data: { signedIn: false, user: null, network: null, reason: 'signed_out_elsewhere' } });
  h.send(MSG.TRIGGER, { action: 'auth', data: { signedIn: false, user: null, network: null } });
  h.send(MSG.TRIGGER, { action: 'connection', data: { state: 'ready' } });
  await settle();
  assert.equal(outcome.settled, false);

  h.send(MSG.TRIGGER, SIGNED_IN_PUSH);
  await settle();
  assert.equal(outcome.value.signedIn, true);
});

test('a session_expired push rejects a sign-in that is waiting, at once', async (t) => {
  const h = await setup(t, { ready: SIGNED_OUT });
  const base = h.clock.pending;
  const outcome = track(h.valu.auth.signIn());

  h.send(MSG.TRIGGER, { action: 'auth', data: { signedIn: false, user: null, network: null, reason: 'session_expired' } });
  await settle();

  assert.equal(outcome.error?.code, 'session_expired');
  assert.ok(outcome.error instanceof Error);
  assert.equal(h.valu.auth.state.reason, 'session_expired');
  assert.equal(h.clock.pending, base);

  // The window was closed, and its grace is running: the push does not wait for it.
  const closing = await setup(t, { ready: SIGNED_OUT });
  const waiting = track(closing.valu.auth.signIn());
  closing.popups.windows[0].closed = true;
  closing.clock.tick(POLL_MS);
  closing.send(MSG.TRIGGER, { action: 'auth', data: { signedIn: false, user: null, network: null, reason: 'session_expired' } });
  await settle();
  assert.equal(waiting.error?.code, 'session_expired');
});

test('a session_expired push with no sign-in waiting is state, not an error', async (t) => {
  const h = await setup(t);
  h.send(MSG.TRIGGER, { action: 'auth', data: { signedIn: false, user: null, network: null, reason: 'session_expired' } });
  assert.equal(h.valu.auth.state.reason, 'session_expired');

  // And it does not poison the next sign-in.
  const outcome = track(h.valu.auth.signIn());
  h.send(MSG.TRIGGER, SIGNED_IN_PUSH);
  await settle();
  assert.equal(outcome.value.signedIn, true);
});

test('signIn rejects cancelled when the popup closes first', async (t) => {
  const h = await setup(t, { ready: SIGNED_OUT });
  const base = h.clock.pending;
  const outcome = track(h.valu.auth.signIn());

  h.clock.tick(POLL_MS * 3);
  assert.equal(outcome.settled, false, 'open popup, no answer: still waiting');

  h.popups.windows[0].closed = true;
  h.clock.tick(POLL_MS);
  await settle();
  assert.equal(outcome.settled, false, 'the host may still be redeeming the token the page just handed over');

  h.clock.tick(CLOSED_GRACE_MS - 1);
  await settle();
  assert.equal(outcome.settled, false);

  h.clock.tick(1);
  await settle();
  assert.equal(outcome.error.code, 'cancelled');
  assert.equal(h.clock.pending, base);
});

test('a sign-in that finishes after its popup closed still resolves', async (t) => {
  const h = await setup(t, { ready: SIGNED_OUT });
  const base = h.clock.pending;
  const outcome = track(h.valu.auth.signIn());

  // Continue: the page posts the token and closes; the host redeems for a few seconds.
  h.popups.windows[0].closed = true;
  h.clock.tick(POLL_MS);
  h.clock.tick(3_000);
  await settle();
  assert.equal(outcome.settled, false);

  h.send(MSG.TRIGGER, SIGNED_IN_PUSH);
  await settle();

  assert.equal(outcome.value?.signedIn, true);
  assert.equal(h.clock.pending, base, 'the grace timer is gone too');
});

test('a cancelled push after the popup closed is cancelled at once', async (t) => {
  const h = await setup(t, { ready: SIGNED_OUT });
  const outcome = track(h.valu.auth.signIn());
  h.popups.windows[0].closed = true;
  h.clock.tick(POLL_MS);

  h.send(MSG.TRIGGER, { action: 'auth', data: { signedIn: false, user: null, network: null, reason: 'cancelled' } });
  await settle();

  assert.equal(outcome.error.code, 'cancelled');
});

test('signIn rejects timeout after five minutes, and closes the popup', async (t) => {
  const h = await setup(t, { ready: SIGNED_OUT });
  const base = h.clock.pending;
  const outcome = track(h.valu.auth.signIn());

  h.clock.tick(SIGN_IN_TIMEOUT_MS - 1);
  await settle();
  assert.equal(outcome.settled, false);

  h.clock.tick(1);
  await settle();

  assert.equal(outcome.error.code, 'timeout');
  assert.equal(h.popups.windows[0].closed, true, 'the window the client opened is closed');
  assert.equal(h.clock.pending, base);
});

test('a second signIn while one is waiting shares it and opens no second popup', async (t) => {
  const h = await setup(t, { ready: SIGNED_OUT });
  const first = track(h.valu.auth.signIn());
  const second = track(h.valu.auth.signIn());
  assert.equal(h.popups.calls.length, 1);

  h.send(MSG.TRIGGER, SIGNED_IN_PUSH);
  await settle();
  assert.deepEqual(first.value, second.value);
  assert.equal(first.value.signedIn, true);

  // Settled: the next call is a new sign-in.
  const third = track(h.valu.auth.signIn());
  assert.equal(h.popups.calls.length, 2);
  assert.equal(third.settled, false);
});

test('signIn in embedded mode rejects not_available and opens nothing', async (t) => {
  const popups = fakePopups();
  const h = await setupEmbedded(t, { popup: popups });
  await assert.rejects(h.valu.auth.signIn(), { code: 'not_available' });
  assert.equal(popups.calls.length, 0);
});

// ---------------------------------------------------------------------------
// signOut
// ---------------------------------------------------------------------------

test('signOut resolves on host:auth-completed', async (t) => {
  const h = await setup(t);
  const outcome = track(h.valu.auth.signOut());
  await settle();

  const [post] = h.sent(MSG.AUTH);
  assert.equal(post.data.message.action, 'sign-out');
  assert.equal(post.targetOrigin, h.pair.host.origin);
  assert.equal(outcome.settled, false, 'not until the host has finished');

  h.send(MSG.TRIGGER, { action: 'auth', data: { signedIn: false, user: null, network: null } });
  h.send(MSG.AUTH_COMPLETED, { ok: true }, post.data.message.requestId);
  await settle();

  assert.equal(outcome.settled, true);
  assert.equal(outcome.value, undefined);
  assert.equal(outcome.error, undefined);
  assert.equal(h.valu.auth.state.signedIn, false);
});

test('signOut rejects with the code of an error reply', async (t) => {
  const h = await setup(t);
  const outcome = track(h.valu.auth.signOut());
  await settle();
  const [post] = h.sent(MSG.AUTH);

  h.send(MSG.AUTH_COMPLETED, { error: { code: 'not_available', message: 'nope' } }, post.data.message.requestId);
  await settle();

  assert.equal(outcome.error.code, 'not_available');
});

test('signOut in embedded mode rejects not_available', async (t) => {
  const h = await setupEmbedded(t);
  await assert.rejects(h.valu.auth.signOut(), { code: 'not_available' });
});

// ---------------------------------------------------------------------------
// requestConsent
// ---------------------------------------------------------------------------

test('requestConsent opens the consent page synchronously, asks the host, and resolves approved', async (t) => {
  const h = await setup(t);
  const order = [];
  let microtaskRan = false;
  h.popups.onOpen = () => order.push(microtaskRan ? 'after a microtask' : 'synchronous');
  queueMicrotask(() => { microtaskRan = true; });

  const outcome = track(h.valu.auth.requestConsent(['rooms:read', 'rooms:write']));

  assert.deepEqual(order, ['synchronous']);
  const [popup] = h.popups.calls;
  assert.match(popup.url, /^https:\/\/valuguru\.texpo\.io\/host\/consent\.html\?nonce=[0-9a-f]{32}$/);
  assert.equal(popup.name, 'valu-consent');
  assert.equal(popup.features, 'popup,width=480,height=640');

  const [post] = h.sent(MSG.CONSENT);
  assert.deepEqual(Object.keys(post.data.message).sort(), ['nonce', 'requestId', 'scopes']);
  assert.deepEqual(post.data.message.scopes, ['rooms:read', 'rooms:write']);
  assert.equal(popup.url.endsWith(`nonce=${post.data.message.nonce}`), true, 'the page and the host share the nonce');
  assert.equal(post.targetOrigin, h.pair.host.origin);

  await settle();
  assert.equal(outcome.settled, false, 'waiting for the user');

  h.send(MSG.CONSENT_COMPLETED, { approved: true }, post.data.message.requestId);
  await settle();
  assert.equal(outcome.value, true);
});

test('requestConsent resolves false when the user declines or the host refuses', async (t) => {
  for (const reply of [{ approved: false }, { approved: false, reason: 'sign_in_required' }, { approved: 'yes' }, {}]) {
    const h = await setup(t);
    const base = h.clock.pending;
    const outcome = track(h.valu.auth.requestConsent(['rooms:read']));
    h.send(MSG.CONSENT_COMPLETED, reply, h.sent(MSG.CONSENT)[0].data.message.requestId);
    await settle();
    assert.equal(outcome.value, false, JSON.stringify(reply));
    assert.equal(h.clock.pending, base);
  }
});

test('a consent the host refused before the dialog closes the popup it opened', async (t) => {
  for (const reason of ['sign_in_required', 'busy', 'invalid_request', 'timeout', 'unavailable']) {
    const h = await setup(t);
    const outcome = track(h.valu.auth.requestConsent(['rooms:read']));
    assert.equal(h.popups.windows[0].closed, false, 'open while the host has not answered');

    h.send(MSG.CONSENT_COMPLETED, { approved: false, reason }, h.sent(MSG.CONSENT)[0].data.message.requestId);
    await settle();

    assert.equal(outcome.value, false, reason);
    assert.equal(h.popups.windows[0].closed, true, `${reason}: the popup is closed`);
  }
});

test('a decision made in the dialog leaves the popup to the page that made it', async (t) => {
  for (const approved of [true, false]) {
    const h = await setup(t);
    const outcome = track(h.valu.auth.requestConsent(['rooms:read']));
    h.send(MSG.CONSENT_COMPLETED, { approved }, h.sent(MSG.CONSENT)[0].data.message.requestId);
    await settle();
    assert.equal(outcome.value, approved);
    assert.equal(h.popups.windows[0].closed, false, 'the consent page closes itself');
  }
});

test('every consent has its own nonce, long enough to guess nothing', async (t) => {
  const h = await setup(t);
  const a = track(h.valu.auth.requestConsent(['rooms:read']));
  const b = track(h.valu.auth.requestConsent(['rooms:write']));
  const nonces = h.sent(MSG.CONSENT).map((post) => post.data.message.nonce);
  assert.equal(new Set(nonces).size, 2);
  for (const nonce of nonces) assert.ok(nonce.length >= 16);
  assert.equal(a.settled || b.settled, false);
});

test('requestConsent rejects popup_blocked on null and posts nothing', async (t) => {
  const h = await setup(t);
  h.popups.blocked = true;
  await assert.rejects(h.valu.auth.requestConsent(['rooms:read']), { code: 'popup_blocked' });
  assert.equal(h.sent(MSG.CONSENT).length, 0);
});

test('requestConsent refuses scopes that are not a list of names, before opening anything', async (t) => {
  const h = await setup(t);
  for (const scopes of [undefined, 'rooms:read', [], [''], [1], ['rooms:read', null]]) {
    await assert.rejects(h.valu.auth.requestConsent(scopes), TypeError, JSON.stringify(scopes));
  }
  assert.equal(h.popups.calls.length, 0);
  assert.equal(h.sent(MSG.CONSENT).length, 0);
});

test('a consent popup that is closed without an answer resolves false after the grace', async (t) => {
  const h = await setup(t);
  const base = h.clock.pending;
  const outcome = track(h.valu.auth.requestConsent(['rooms:read']));

  h.popups.windows[0].closed = true;
  h.clock.tick(POLL_MS + CLOSED_GRACE_MS - 1);
  await settle();
  assert.equal(outcome.settled, false, 'the host may be writing the grant');

  h.clock.tick(1);
  await settle();
  assert.equal(outcome.value, false);
  assert.equal(h.clock.pending, base);
});

test('a consent answered after its popup closed still counts', async (t) => {
  const h = await setup(t);
  const base = h.clock.pending;
  const outcome = track(h.valu.auth.requestConsent(['rooms:read']));

  h.popups.windows[0].closed = true;
  h.clock.tick(POLL_MS + 2_000);
  h.send(MSG.CONSENT_COMPLETED, { approved: true }, h.sent(MSG.CONSENT)[0].data.message.requestId);
  await settle();

  assert.equal(outcome.value, true);
  assert.equal(h.clock.pending, base);
});

test('the same consent asked twice at once is asked once', async (t) => {
  const h = await setup(t);
  const first = track(h.valu.auth.requestConsent(['rooms:read']));
  const second = track(h.valu.auth.requestConsent(['rooms:read']));
  assert.equal(h.popups.calls.length, 1);
  assert.equal(h.sent(MSG.CONSENT).length, 1);

  h.send(MSG.CONSENT_COMPLETED, { approved: true }, h.sent(MSG.CONSENT)[0].data.message.requestId);
  await settle();
  assert.equal(first.value, true);
  assert.equal(second.value, true);
});

test('requestConsent in embedded mode rejects not_available', async (t) => {
  const popups = fakePopups();
  const h = await setupEmbedded(t, { popup: popups });
  await assert.rejects(h.valu.auth.requestConsent(['rooms:read']), { code: 'not_available' });
  assert.equal(popups.calls.length, 0);
});

// ---------------------------------------------------------------------------
// The service tree, and consent_required
// ---------------------------------------------------------------------------

test('valu.Users.current() in dedicated mode goes through api:call', async (t) => {
  const h = await setup(t);
  const descriptor = findDescriptor('Users.current');
  h.host.call = () => ({ data: { user: USER } });

  const ack = await h.valu.Users.current();

  assert.deepEqual(ack, { data: { user: USER } });
  const [post] = h.sent(MSG.CALL);
  assert.deepEqual(
    { ...post.data.message, requestId: undefined },
    { service: descriptor.service, action: descriptor.action, params: {}, requestId: undefined, timeoutMs: 30_000 },
  );
  assert.equal(post.targetOrigin, h.pair.host.origin);
  assert.deepEqual(await h.valu.data.Users.current(), { user: USER }, 'the unwrapped tree is on it too');
});

test('local functions run in the page and never reach the host', async (t) => {
  const h = await setup(t);
  const ack = await h.valu.Time.getLocalTime();
  assert.ok(ack.data.iso, 'answered');
  assert.equal(h.sent(MSG.CALL).length, 0);
});

test('fetchImpl and localTransport reach the local functions', async (t) => {
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

test('no service name collides with a member of the app', async (t) => {
  const h = await setup(t);
  const members = ['mode', 'ready', 'auth', 'network', 'connection', 'data', 'bridge', 'close', 'callService',
    'sendIntent', 'onCommerceEvent', 'addEventListener', 'removeEventListener'];
  for (const service of ValuServiceApi.services()) {
    assert.equal(members.includes(service), false, service);
    assert.equal(typeof h.valu[service], 'object', `valu.${service} is the namespace`);
  }
  for (const member of members) assert.ok(member in h.valu, member);
});

/** A host that refuses the first `refusals` calls for consent, then answers `answer`. */
function refusing(h, { refusals = 1, scope = 'rooms:read', answer = { data: { id: 'r1' } } } = {}) {
  let refused = 0;
  h.host.call = () => {
    if (refused < refusals) {
      refused += 1;
      return { error: { ...CONSENT_REQUIRED.error, scope } };
    }
    return answer;
  };
}

const grant = (h) => h.send(MSG.CONSENT_COMPLETED, { approved: true }, h.sent(MSG.CONSENT).at(-1).data.message.requestId);

test('consent_required with user activation opens consent and retries once', async (t) => {
  const h = await setup(t, { activation: true });
  refusing(h);

  const call = track(h.valu.Rooms.getRoom({ roomId: 'r1' }));
  await settle();

  assert.equal(h.popups.calls.length, 1, 'the consent popup opened');
  assert.match(h.popups.calls[0].url, /\/host\/consent\.html\?nonce=/);
  assert.deepEqual(h.sent(MSG.CONSENT)[0].data.message.scopes, ['rooms:read'], 'the scope the host named');
  assert.equal(call.settled, false, 'the call waits for the user');
  assert.equal(h.sent(MSG.CALL).length, 1);

  grant(h);
  await settle();

  assert.deepEqual(call.value, { data: { id: 'r1' } });
  const calls = h.sent(MSG.CALL).map((post) => post.data.message);
  assert.equal(calls.length, 2, 'exactly one retry');
  assert.deepEqual(
    { service: calls[1].service, action: calls[1].action, params: calls[1].params },
    { service: calls[0].service, action: calls[0].action, params: calls[0].params },
    'the same call',
  );
  assert.notEqual(calls[1].requestId, calls[0].requestId);
});

test('without user activation the ack is returned as it is and nothing opens', async (t) => {
  for (const navigator of [{ userActivation: { isActive: false } }, { userActivation: {} }, {}, undefined]) {
    const h = await setup(t);
    h.pair.app.navigator = navigator;
    refusing(h);

    const ack = await h.valu.Rooms.getRoom({ roomId: 'r1' });

    assert.deepEqual(ack, CONSENT_REQUIRED, 'the app sees consent_required and asks from its own click');
    assert.equal(h.popups.calls.length, 0);
    assert.equal(h.sent(MSG.CALL).length, 1);
  }
});

test('the retry is one: a second consent_required is the answer', async (t) => {
  const h = await setup(t, { activation: true });
  refusing(h, { refusals: 5 });

  const call = track(h.valu.Rooms.getRoom({ roomId: 'r1' }));
  await settle();
  grant(h);
  await settle();

  assert.deepEqual(call.value, CONSENT_REQUIRED);
  assert.equal(h.sent(MSG.CALL).length, 2);
  assert.equal(h.popups.calls.length, 1, 'no second dialog');
});

test('a consent the user declines leaves the ack as it was', async (t) => {
  const h = await setup(t, { activation: true });
  refusing(h, { refusals: 5 });

  const call = track(h.valu.Rooms.getRoom({ roomId: 'r1' }));
  await settle();
  h.send(MSG.CONSENT_COMPLETED, { approved: false }, h.sent(MSG.CONSENT)[0].data.message.requestId);
  await settle();

  assert.deepEqual(call.value, CONSENT_REQUIRED);
  assert.equal(h.sent(MSG.CALL).length, 1, 'no retry');
});

test('a blocked consent popup leaves the ack as it was', async (t) => {
  const h = await setup(t, { activation: true });
  h.popups.blocked = true;
  refusing(h, { refusals: 5 });

  const ack = await h.valu.Rooms.getRoom({ roomId: 'r1' });

  assert.deepEqual(ack, CONSENT_REQUIRED);
  assert.equal(h.sent(MSG.CALL).length, 1);
});

test('a consent that fails (the host went away) leaves the ack as it was', async (t) => {
  const h = await setup(t, { activation: true });
  refusing(h, { refusals: 5 });

  const call = track(h.valu.Rooms.getRoom({ roomId: 'r1' }));
  await settle();
  await h.valu.close();
  await settle();

  assert.deepEqual(call.value, CONSENT_REQUIRED);
});

test('other errors are not consent: no popup, no retry', async (t) => {
  const h = await setup(t, { activation: true });
  for (const error of [
    { status: true, code: 403, message: 'forbidden' },
    { status: true, code: 401, message: 'sign_in_required' },
    { status: true, code: 403, message: 'consent_required' },
    { status: true, code: 403, message: 'consent_required', scope: 7 },
    { status: true, code: 500, message: 'consent_required', scope: 'rooms:read' },
  ]) {
    h.host.call = () => ({ error });
    const ack = await h.valu.Rooms.getRoom({ roomId: `r-${error.message}-${error.code}-${error.scope}` });
    assert.deepEqual(ack, { error });
  }
  assert.equal(h.popups.calls.length, 0);
});

test('calls waiting on the same consent share the dialog', async (t) => {
  const h = await setup(t, { activation: true });
  let refused = 0;
  h.host.call = () => (refused++ < 2 ? CONSENT_REQUIRED : { data: { id: 'ok' } });

  const a = track(h.valu.Rooms.getRoom({ roomId: 'a' }));
  const b = track(h.valu.Rooms.getRoom({ roomId: 'b' }));
  await settle();
  assert.equal(h.popups.calls.length, 1, 'one dialog');
  assert.equal(h.sent(MSG.CONSENT).length, 1);

  grant(h);
  await settle();

  assert.deepEqual(a.value, { data: { id: 'ok' } });
  assert.deepEqual(b.value, { data: { id: 'ok' } });
  assert.equal(h.sent(MSG.CALL).length, 4, 'both calls retried once');
});

test('a call for another scope while a dialog is open does not open a second one', async (t) => {
  const h = await setup(t, { activation: true });
  h.host.call = (message) => (message.action === 'get-room'
    ? CONSENT_REQUIRED
    : { error: { status: true, code: 403, message: 'consent_required', scope: 'textchat:read' } });

  const first = track(h.valu.Rooms.getRoom({ roomId: 'a' }));
  await settle();
  const other = await h.valu.Rooms.getPermissions({ roomId: 'a' });

  assert.equal(other.error.scope, 'textchat:read', 'answered as it is');
  assert.equal(h.popups.calls.length, 1);
  assert.equal(first.settled, false);
});

test('consent retry covers the unwrapped tree and calls by name', async (t) => {
  const h = await setup(t, { activation: true });
  refusing(h);

  const call = track(h.valu.data.Rooms.getRoom({ roomId: 'r1' }));
  await settle();
  assert.equal(h.popups.calls.length, 1);
  grant(h);
  await settle();

  assert.deepEqual(call.value, { id: 'r1' });
});

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

test('callService runs an intent over the host: api:service-intent', async (t) => {
  const h = await setup(t);
  h.host.intent = () => ({ success: true, cart: { count: 1 } });

  const result = await h.valu.callService(new Intent('Commerce', 'add-to-cart', { productId: 'p1' }));

  assert.deepEqual(result, { success: true, cart: { count: 1 } });
  const [post] = h.sent(MSG.SERVICE_INTENT);
  assert.deepEqual(
    { ...post.data.message, requestId: undefined },
    { applicationId: 'Commerce', action: 'add-to-cart', params: { productId: 'p1' }, requestId: undefined },
  );
});

test('sendIntent posts api:run-intent and resolves the host\'s answer', async (t) => {
  const h = await setup(t);
  const result = await h.valu.sendIntent(new Intent('chat', Intent.ACTION_OPEN, { roomId: '1' }));
  assert.deepEqual(result, { error: { code: 'not_available' } });
  assert.equal(h.sent(MSG.RUN_INTENT).length, 1);
});

test('commerce pushes reach onCommerceEvent and addEventListener(ON_COMMERCE) until removed', async (t) => {
  const h = await setup(t);
  const viaMethod = [];
  const viaEvent = [];
  const off = h.valu.onCommerceEvent((data) => viaMethod.push(data));
  const onEvent = (data) => viaEvent.push(data);
  h.valu.addEventListener(ValuApi.ON_COMMERCE, onEvent);

  h.send(MSG.TRIGGER, { action: 'commerce', data: { event: 'cart-updated', count: 2 } });
  assert.deepEqual(viaMethod, [{ event: 'cart-updated', count: 2 }]);
  assert.deepEqual(viaEvent, [{ event: 'cart-updated', count: 2 }]);

  off();
  h.valu.removeEventListener(ValuApi.ON_COMMERCE, onEvent);
  h.send(MSG.TRIGGER, { action: 'commerce', data: { event: 'cart-updated', count: 3 } });
  assert.equal(viaMethod.length, 1);
  assert.equal(viaEvent.length, 1);
  assert.throws(() => h.valu.onCommerceEvent('nope'), TypeError);
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

test('close removes the iframe, the listener and every timer, and fails what is waiting', async (t) => {
  const h = await setup(t);
  const signIn = track(h.valu.auth.signIn());
  const consent = track(h.valu.auth.requestConsent(['rooms:read']));
  h.host.call = () => { throw new Error('not reached'); };

  await h.valu.close();
  await settle();

  assert.equal(h.doc.frames[0].parentNode, null);
  assert.equal(h.pair.app.listeners.size, 0);
  assert.equal(h.clock.pending, 0);
  assert.equal(signIn.error.code, 'closed');
  assert.equal(consent.error?.code, 'closed', 'the consent request ended with the app, saying so');
  assert.ok(consent.error instanceof Error);

  // A write: a read that fails 503 is retried by the client's policy, after real sleeps.
  const ack = await h.valu.ApplicationStorage.resourceDelete({ resourceId: 'r1' });
  assert.equal(ack.error.message, 'transport closed');
  await assert.rejects(h.valu.auth.signIn(), { code: 'closed' });
  await assert.rejects(h.valu.auth.requestConsent(['rooms:read']), { code: 'closed' });
  assert.equal(h.popups.calls.length, 2, 'nothing opened after the close');
  await h.valu.close();
});

test('close closes the sign-in and consent popups it opened', async (t) => {
  const h = await setup(t);
  const signIn = track(h.valu.auth.signIn());
  const consent = track(h.valu.auth.requestConsent(['rooms:read']));
  const [signInWindow, consentWindow] = h.popups.windows;
  assert.equal(h.popups.windows.length, 2);
  assert.equal(signInWindow.closed || consentWindow.closed, false);

  await h.valu.close();
  await settle();

  assert.equal(signInWindow.closed, true, 'the sign-in popup');
  assert.equal(consentWindow.closed, true, 'the consent popup');
  assert.equal(signIn.error?.code, 'closed');
  assert.equal(consent.error?.code, 'closed');
});

/** Make a popup window count its `close()` calls (the fake's own close is idempotent, which hides a second call). */
function countCloses(win) {
  const count = { closes: 0 };
  win.close = () => { count.closes += 1; };
  return count;
}

test('a popup is closed once at close(), not again by the flow that fails with it', async (t) => {
  const h = await setup(t);
  const signIn = track(h.valu.auth.signIn());
  const consent = track(h.valu.auth.requestConsent(['rooms:read']));
  const [signInCount, consentCount] = h.popups.windows.map(countCloses);

  await h.valu.close();
  await settle();

  assert.equal(signIn.error?.code, 'closed');
  assert.equal(consent.error?.code, 'closed');
  assert.equal(signInCount.closes, 1, 'the sign-in popup');
  assert.equal(consentCount.closes, 1, 'the consent popup');
});

test('a push that fails a sign-in closes its popup, once', async (t) => {
  for (const reason of ['cancelled', 'session_expired', 'master_mismatch', 'not_a_member', 'invalid_token', 'unavailable']) {
    const h = await setup(t, { ready: SIGNED_OUT });
    const outcome = track(h.valu.auth.signIn());
    const popup = countCloses(h.popups.windows[0]);

    h.send(MSG.TRIGGER, { action: 'auth', data: { signedIn: false, user: null, network: null, reason } });
    await settle();

    assert.equal(outcome.error?.code, reason);
    assert.equal(popup.closes, 1, `${reason}: the popup is closed`);

    // Nothing that ends the app touches it again.
    await h.valu.close();
    assert.equal(popup.closes, 1, `${reason}: not closed again at close()`);
  }
});

test('a sign-in that succeeds leaves its popup to the page', async (t) => {
  const h = await setup(t, { ready: SIGNED_OUT });
  const outcome = track(h.valu.auth.signIn());
  const popup = countCloses(h.popups.windows[0]);

  h.send(MSG.TRIGGER, SIGNED_IN_PUSH);
  await settle();

  assert.equal(outcome.value.signedIn, true);
  assert.equal(popup.closes, 0, 'the sign-in page closes itself');
});

test('a popup that already ended is not closed again by close', async (t) => {
  const h = await setup(t, { ready: SIGNED_OUT });
  const signIn = track(h.valu.auth.signIn());
  const consent = track(h.valu.auth.requestConsent(['rooms:read']));
  h.send(MSG.TRIGGER, SIGNED_IN_PUSH);
  h.send(MSG.CONSENT_COMPLETED, { approved: true }, h.sent(MSG.CONSENT)[0].data.message.requestId);
  await settle();
  assert.equal(signIn.value.signedIn, true);
  assert.equal(consent.value, true);
  let closes = 0;
  for (const win of h.popups.windows) win.close = () => { closes += 1; };

  await h.valu.close();

  assert.equal(closes, 0, 'the pages closed them; the client has let go of them');
});

test('a consent whose request fails closes its popup and rejects with the failure', async (t) => {
  const h = await setup(t);
  const outcome = track(h.valu.auth.requestConsent(['rooms:read']));

  // The host stops answering pings: the transport replaces it and fails what was on the wire.
  h.host.ping = false;
  h.clock.tick(15_000);
  h.clock.tick(10_000);
  await settle();

  assert.equal(outcome.error?.code, 'host_restarted');
  assert.equal(h.popups.windows[0].closed, true);
});

test('signOut after close, and one waiting at close, reject closed', async (t) => {
  const h = await setup(t);
  const waiting = track(h.valu.auth.signOut());
  await settle();
  assert.equal(h.sent(MSG.AUTH).length, 1);

  await h.valu.close();
  await settle();
  assert.equal(waiting.error?.code, 'closed');
  assert.ok(waiting.error instanceof Error);

  await assert.rejects(h.valu.auth.signOut(), { code: 'closed' });
  assert.equal(h.sent(MSG.AUTH).length, 1, 'nothing more was posted');
});

// ---------------------------------------------------------------------------
// Embedded mode
// ---------------------------------------------------------------------------

test('embedded: ready resolves on api:ready, which the factory does not wait for', async (t) => {
  const h = embeddedHarness(t);
  h.valu = await h.create();
  const ready = track(h.valu.ready);
  const changes = [];
  h.valu.connection.on('change', (change) => changes.push(change));

  await settle();
  assert.equal(ready.settled, false);
  assert.equal(h.valu.connection.state, 'connecting');

  h.win.ready({ applicationId: 'app-1' });
  await settle();

  assert.equal(ready.settled, true);
  assert.equal(h.valu.connection.state, 'ready');
  assert.deepEqual(changes, [{ state: 'ready', reconnected: false, lastError: null }]);

  h.win.ready({ applicationId: 'app-1' });
  assert.equal(changes.length, 1, 'a repeated api:ready is not a change of connection');
});

test('embedded: auth is the embedding application\'s, and the page sees none of it', async (t) => {
  const h = await setupEmbedded(t);
  h.win.ready();
  assert.deepEqual(h.valu.auth.state, { signedIn: false, user: null, network: null });
  assert.equal(h.valu.network, null);
  const off = h.valu.auth.on('change', () => {});
  off();
});

test('embedded: the service tree answers 501 and posts nothing', async (t) => {
  const h = await setupEmbedded(t);
  h.win.ready();

  const ack = await h.valu.Users.current();
  assert.equal(ack.error.code, 501);
  assert.match(ack.error.message, /not available in embedded mode/);
  assert.equal((await h.valu.data.Users.current().catch((error) => error)).code, 501);
  assert.equal(h.win.posted.length, 0);
});

test('embedded: the bridge methods are the ones ValuApi has', async (t) => {
  const h = await setupEmbedded(t);
  h.win.ready({ applicationId: 'app-1' });

  const pending = h.valu.callService(new Intent('Weather', 'forecast-tomorrow', { city: 'Kyiv' }));
  const posted = h.win.lastPost();
  assert.equal(posted.name, 'api:service-intent');
  assert.equal(posted.message.applicationId, 'Weather');
  h.win.deliver({ name: 'api:run-console-completed', message: { c: 21 }, requestId: posted.message.requestId });
  assert.deepEqual(await pending, { c: 21 });

  const seen = [];
  h.valu.onCommerceEvent((data) => seen.push(data));
  h.win.deliver({ name: 'api:trigger', message: { action: 'commerce', data: { event: 'cart-updated', count: 1 } } });
  assert.deepEqual(seen, [{ event: 'cart-updated', count: 1 }]);
});

test('embedded: the peer is the parent only', async (t) => {
  const h = await setupEmbedded(t);
  const stranger = { postMessage() {} };
  h.win.deliver({ name: 'api:ready', message: { applicationId: 'evil' }, source: stranger });
  await settle();
  assert.equal(h.valu.connection.state, 'connecting');
});

test('embedded: close removes the listener', async (t) => {
  const h = await setupEmbedded(t);
  assert.equal(h.win.listeners.size, 1);
  await h.valu.close();
  assert.equal(h.win.listeners.size, 0);
});
