// ===========================================================================
// HostDispatch — the answers and checks the bridge serves its app with, on
// their own: the refusal shapes, the replies for a busy host and a timeout, a
// write that was cut off, event names, consent scopes, the cart count, and the
// permission order against a fake `DispatchHost`. What the bridge does with
// them over a window is in `host-bridge-calls.test.js`.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as Permissions from '../../src/host/Permissions.js';
import {
  ACK, CALL_REPLIES, INTENT_REPLIES, answerCall, answerIntent, attemptTimeoutMs, callRefusal, cartCount, intentRefusal, isIdentityReply,
  isPlainObject, label, markIdentityReply, markUnretryable, notAvailable, permit, readEventNames, validConsentScopes,
} from '../../src/host/HostDispatch.js';
import { MSG } from '../../src/host/protocol.js';

/** A host seam over plain values; `grants` and `guru` throw like a bridge that cannot make the client. */
function fakeHost(overrides = {}) {
  const log = [];
  let subscribed = new Set();
  const host = {
    permissions: Permissions,
    commerce: {
      COMMERCE_INTENTS: { 'list-products': {} },
      COMMERCE_APP_EVENTS: ['cart-updated', 'order-updated'],
      runCommerceIntent: async (action, params, context) => ({ ran: { action, params, context } }),
    },
    signedIn: () => true,
    callTimeoutMs: 30_000,
    app: () => ({ slug: 'demo' }),
    services: () => ({ call: async (name, params) => ({ data: { name, params } }) }),
    grants: () => ({ has: async () => false }),
    guru: () => ({ guru: true }),
    user: () => ({ id: 'u1' }),
    networkId: () => 'n1',
    emit: async () => ({ data: { token: 'jwt' } }),
    subscribed: () => subscribed,
    setSubscribed: (events) => { subscribed = events; },
    log: (level, message) => log.push({ level, message }),
    ...overrides,
  };
  return { host, log };
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

test('callRefusal: each verdict code is its ack, and an unknown code is a 404', () => {
  assert.deepEqual(callRefusal({ code: 'sign_in_required' }), { error: { status: true, code: 401, message: 'sign_in_required' } });
  assert.deepEqual(callRefusal({ code: 'forbidden' }), { error: { status: true, code: 403, message: 'forbidden' } });
  assert.deepEqual(callRefusal({ code: 'consent_required', scope: 'groups:read' }), {
    error: { status: true, code: 403, message: 'consent_required', scope: 'groups:read' },
  });
  assert.deepEqual(callRefusal({ code: 'not_available' }), { error: { status: true, code: 501, message: 'not_available' } });
  assert.deepEqual(callRefusal({ code: 'unavailable' }), { error: { status: true, code: 503, message: 'unavailable' } });
  assert.deepEqual(callRefusal({ code: 'not_a_member' }), { error: { status: true, code: 401, message: 'not_a_member' } });
  for (const code of ['unknown_function', undefined, '__proto__', 'whatever']) {
    assert.deepEqual(callRefusal({ code }), { error: { status: true, code: 404, message: 'unknown_function' } }, String(code));
  }
  assert.equal(Object.hasOwn(callRefusal({ code: 'forbidden', scope: 'x' }).error, 'scope'), false, 'a scope rides only on consent_required');
});

test('intentRefusal: {success:false, code, error}, a scope only on consent_required, anything else not_available', () => {
  for (const code of ['sign_in_required', 'forbidden', 'not_available', 'unavailable', 'not_a_member']) {
    const answer = intentRefusal({ code, scope: 'groups:read' });
    assert.equal(answer.success, false);
    assert.equal(answer.code, code);
    assert.equal(typeof answer.error, 'string');
    assert.equal(Object.hasOwn(answer, 'scope'), false, code);
  }
  assert.deepEqual(Object.keys(intentRefusal({ code: 'consent_required', scope: 'groups:read' })).sort(), ['code', 'error', 'scope', 'success']);
  assert.equal(intentRefusal({ code: 'consent_required', scope: 'groups:read' }).scope, 'groups:read');
  for (const code of ['unknown_function', undefined, 'toString', '__proto__', 'x']) {
    assert.equal(intentRefusal({ code }).code, 'not_available', String(code));
  }
});

test('the busy, timeout and failed replies, per kind of request', () => {
  assert.equal(CALL_REPLIES.reply, MSG.CALL_COMPLETED);
  assert.deepEqual(CALL_REPLIES.busy, { error: { status: true, code: 429, message: 'busy' } });
  assert.deepEqual(CALL_REPLIES.timeout, { error: { status: true, code: 408, message: 'timeout' } });
  assert.deepEqual(CALL_REPLIES.timeoutAfterWrite, { error: { status: true, code: 408, message: 'timeout', retryable: false } });
  assert.deepEqual(CALL_REPLIES.failed, { error: { status: true, code: 500, message: 'internal' } });
  assert.equal(INTENT_REPLIES.reply, MSG.RUN_CONSOLE_COMPLETED);
  for (const [kind, code] of [['busy', 'busy'], ['timeout', 'timeout'], ['failed', 'error']]) {
    assert.equal(INTENT_REPLIES[kind].success, false);
    assert.equal(INTENT_REPLIES[kind].code, code);
    assert.equal(typeof INTENT_REPLIES[kind].error, 'string');
  }
  assert.ok(Object.isFrozen(CALL_REPLIES) && Object.isFrozen(INTENT_REPLIES));
  assert.equal(ACK.BUSY, 429);
});

test('notAvailable names what was asked for and is the {error:{code, message}} shape', () => {
  assert.deepEqual(notAvailable('Rooms.x'), { error: { code: 'not_available', message: 'Rooms.x is not available through the valu-api host' } });
});

test('label shortens a string and hides anything else', () => {
  assert.equal(label('Commerce'), 'Commerce');
  assert.equal(label('x'.repeat(500)).length, 60);
  for (const value of [undefined, null, 5, {}, ['a'], () => 'x']) assert.equal(label(value), '?');
  assert.equal(isPlainObject({}), true);
  for (const value of [undefined, null, 5, 'x', [], () => ({})]) assert.equal(isPlainObject(value), false);
});

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

test('markUnretryable: only a write that was cut off or timed out is marked, and the ack is not changed', () => {
  const cut = { error: { status: true, code: 503, message: 'disconnected' } };
  const marked = markUnretryable({ mutates: true }, cut);
  assert.deepEqual(marked, { error: { status: true, code: 503, message: 'disconnected', retryable: false } });
  assert.deepEqual(cut, { error: { status: true, code: 503, message: 'disconnected' } });
  assert.notEqual(marked, cut);

  const late = { error: { status: true, code: 408, message: 'timeout' } };
  assert.deepEqual(markUnretryable({ mutates: true }, late), { error: { status: true, code: 408, message: 'timeout', retryable: false } });
  assert.deepEqual(late, { error: { status: true, code: 408, message: 'timeout' } });

  assert.equal(markUnretryable({ mutates: false }, cut), cut, 'a read may be repeated');
  assert.equal(markUnretryable({ mutates: false }, late), late);
  const other = { error: { status: true, code: 500, message: 'no' } };
  assert.equal(markUnretryable({ mutates: true }, other), other);
  const ok = { data: { done: true } };
  assert.equal(markUnretryable({ mutates: true }, ok), ok);
});

test('readEventNames: known names once each, anything else is an error that names at most a few, shortened', () => {
  const known = ['cart-updated', 'order-updated'];
  assert.deepEqual(readEventNames(['order-updated', 'cart-updated', 'order-updated'], known), { names: ['order-updated', 'cart-updated'] });
  assert.deepEqual(readEventNames([], known), { names: [] });
  for (const value of [undefined, null, 'cart-updated', 3, { 0: 'cart-updated' }]) {
    assert.match(readEventNames(value, known).error, /list of event names/, JSON.stringify(value));
  }
  const circular = {};
  circular.self = circular;
  const { error } = readEventNames([circular, 'y'.repeat(1000), 1, 2, 3, 4, 5, 6, 7], known);
  assert.match(error, /^Unknown event object, y{40}, number/);
  assert.ok(error.length < 300);
  assert.match(error, /cart-updated, order-updated/, 'it says what the events are');
});

test('cartCount: this app\'s rows, saved-for-later left out by the one rule get-cart uses, whatever else the cart holds', () => {
  const items = [
    { appId: 'demo' }, { appId: 'demo', savedForLater: false }, { appId: 'demo', savedForLater: true }, { appId: 'demo', savedForLater: 1 },
    { appId: 'other' }, null, undefined, 'x', 5, {}, { appId: 'DEMO' },
  ];
  assert.equal(cartCount({ items }, 'demo'), 2);
  for (const data of [null, undefined, {}, { items: 'x' }, { items: {} }, 5, 'x']) assert.equal(cartCount(data, 'demo'), 0);
});

test('validConsentScopes: a short list of consent-tier scopes, each once; else null', () => {
  const tierOf = (scope) => Permissions.tierOf(scope);
  assert.deepEqual(validConsentScopes(['groups:read', 'rooms:read', 'groups:read'], tierOf), ['groups:read', 'rooms:read']);
  for (const bad of [
    undefined, null, 'groups:read', [], ['users:read'], ['veruswallet:write'], ['http:read'], ['nope'], ['groups:read', 'cbac:write'],
    ['groups:read', 5], ['groups:read', null], Array.from({ length: 65 }, () => 'groups:read'),
  ]) {
    assert.equal(validConsentScopes(bad, tierOf), null, JSON.stringify(bad));
  }
  assert.equal(validConsentScopes(Array.from({ length: 64 }, () => 'groups:read'), tierOf).length, 1);
});

// ---------------------------------------------------------------------------
// The permission order, against a fake host
// ---------------------------------------------------------------------------

test('permit: basic runs, forbidden and local are refused, neither reads the grants', async () => {
  let reads = 0;
  const { host } = fakeHost({ grants: () => { reads += 1; return { has: async () => true }; } });
  assert.deepEqual(await permit(host, 'users:read'), { ok: true });
  assert.deepEqual(await permit(host, 'cbac:write'), { ok: false, code: 'forbidden', scope: 'cbac:write' });
  assert.deepEqual(await permit(host, 'http:read'), { ok: false, code: 'not_available', scope: 'http:read' });
  assert.deepEqual(await permit(host, 'nonsense'), { ok: false, code: 'unknown_function', scope: 'nonsense' });
  assert.deepEqual(await permit(host, null), { ok: false, code: 'unknown_function', scope: null });
  assert.equal(reads, 0);
});

test('permit: a consent scope needs the grant, and only the boolean true is one', async () => {
  const answers = [true, false, 'yes', 1, {}, undefined];
  const verdicts = [];
  for (const has of answers) {
    const { host } = fakeHost({ grants: () => ({ has: async () => has }) });
    verdicts.push((await permit(host, 'groups:read')).ok);
  }
  assert.deepEqual(verdicts, [true, false, false, false, false, false]);
  const { host } = fakeHost();
  assert.deepEqual(await permit(host, 'groups:read'), { ok: false, code: 'consent_required', scope: 'groups:read' });
});

test('permit: signed out is sign_in_required; so is a session that ended while the grants were read; unreadable grants are unavailable', async () => {
  const out = fakeHost({ signedIn: () => false }).host;
  assert.deepEqual(await permit(out, 'users:read'), { ok: false, code: 'sign_in_required' });

  let signedIn = true;
  const mid = fakeHost({ signedIn: () => signedIn, grants: () => ({ has: async () => { signedIn = false; return true; } }) }).host;
  assert.deepEqual(await permit(mid, 'groups:read'), { ok: false, code: 'sign_in_required' });

  for (const grants of [() => { throw new TypeError('no client'); }, () => ({ has: async () => { throw Object.assign(new Error('x'), { code: 'timeout' }); } })]) {
    const { host, log } = fakeHost({ grants });
    assert.deepEqual(await permit(host, 'groups:read'), { ok: false, code: 'unavailable' });
    assert.equal(log.length, 1);
    assert.equal(log[0].level, 'warn');
  }
});

test('permit and answerCall: a signed-out user is refused with the host\'s signed-out code', async () => {
  const { host } = fakeHost({ signedIn: () => false, signedOutCode: () => 'not_a_member' });
  assert.deepEqual(await permit(host, 'users:read'), { ok: false, code: 'not_a_member' });
  assert.deepEqual(await answerCall(host, { service: 'Users', action: 'current', params: {} }), {
    error: { status: true, code: 401, message: 'not_a_member' },
  });
  const plain = fakeHost({ signedIn: () => false }).host;
  assert.deepEqual(await permit(plain, 'users:read'), { ok: false, code: 'sign_in_required' }, 'without the seam: sign_in_required');
});

test('answerCall tells its tracker when a write is handed to the services, and not before', async () => {
  let seenByServices;
  const track = { wrote: false };
  const { host } = fakeHost({
    grants: () => ({ has: async () => true }),
    services: () => ({ call: async () => { seenByServices = track.wrote; return { data: 1 }; } }),
  });
  await answerCall(host, { service: 'ApplicationStorage', action: 'resource-delete', params: { resourceId: 'r' } }, track);
  assert.equal(seenByServices, true, 'set before the call is made: the call may be applied even if it never answers');
  const read = { wrote: false };
  await answerCall(host, { service: 'Users', action: 'current', params: {} }, read);
  assert.equal(read.wrote, false);

  const refused = { wrote: false };
  const out = fakeHost({ signedIn: () => false }).host;
  await answerCall(out, { service: 'ApplicationStorage', action: 'resource-delete', params: { resourceId: 'r' } }, refused);
  assert.equal(refused.wrote, false, 'a call that never got to the services wrote nothing');
});

test('attemptTimeoutMs is what the client asked for, capped at the host\'s ceiling, and the ceiling for anything unusable', () => {
  assert.equal(attemptTimeoutMs(5000, 30_000), 5000);
  assert.equal(attemptTimeoutMs(30_000, 30_000), 30_000);
  assert.equal(attemptTimeoutMs(120_000, 30_000), 30_000, 'never more than the host allows');
  assert.equal(attemptTimeoutMs(1e12, 30_000), 30_000);
  assert.equal(attemptTimeoutMs(0.5, 30_000), 0.5);
  for (const unusable of [undefined, null, 0, -1, NaN, Infinity, -Infinity, '5000', {}, [], true, () => 5]) {
    assert.equal(attemptTimeoutMs(unusable, 30_000), 30_000, String(unusable));
  }
});

test('answerCall asks the services once, with no retries and the client\'s timeout (capped at the host\'s)', async () => {
  const seen = [];
  const { host } = fakeHost({ services: () => ({ call: async (name, params, options) => { seen.push(options); return { data: 1 }; } }) });
  await answerCall(host, { service: 'Users', action: 'current', params: {} });
  await answerCall(host, { service: 'Users', action: 'current', params: {}, timeoutMs: 5000 });
  await answerCall(host, { service: 'Users', action: 'current', params: {}, timeoutMs: 120_000 });
  await answerCall(host, { service: 'Users', action: 'current', params: {}, timeoutMs: 'soon' });
  assert.deepEqual(seen, [
    { retries: 0, timeoutMs: 30_000 },
    { retries: 0, timeoutMs: 5000 },
    { retries: 0, timeoutMs: 30_000 },
    { retries: 0, timeoutMs: 30_000 },
  ]);

  const short = fakeHost({ callTimeoutMs: 8000, services: () => ({ call: async (name, params, options) => { seen.push(options); return { data: 1 }; } }) }).host;
  seen.length = 0;
  await answerCall(short, { service: 'Users', action: 'current', params: {}, timeoutMs: 20_000 });
  await answerCall(short, { service: 'Users', action: 'current', params: {}, timeoutMs: 3000 });
  assert.deepEqual(seen, [{ retries: 0, timeoutMs: 8000 }, { retries: 0, timeoutMs: 3000 }]);
});

test('answerCall: the services answer is returned, a non-object is a failure, a malformed call never reaches them', async () => {
  const calls = [];
  const { host } = fakeHost({ services: () => ({ call: async (name, params) => { calls.push([name, params]); return { data: 1 }; } }) });
  assert.deepEqual(await answerCall(host, { service: 'Users', action: 'current', params: {} }), { data: 1 });
  assert.deepEqual(await answerCall(host, { service: 'users', action: 'find-user', params: undefined }), { data: 1 });
  assert.deepEqual(calls, [['Users.current', {}], ['Users.find-user', {}]]);

  assert.equal((await answerCall(host, { service: 'Users', action: 'current', params: [] })).error.code, 400);
  assert.equal((await answerCall(host, { service: 'Users', action: 'nope', params: {} })).error.code, 404);
  assert.equal(calls.length, 2);

  const odd = fakeHost({ services: () => ({ call: async () => 'not an ack' }) }).host;
  assert.deepEqual(await answerCall(odd, { service: 'Users', action: 'current', params: {} }), CALL_REPLIES.failed);
});

test('answerIntent: Commerce goes to the module with the host\'s stamp, anything unserved is not_available', async () => {
  const { host } = fakeHost({ grants: () => ({ has: async () => true }) });
  const answer = await answerIntent(host, { applicationId: 'Commerce', action: 'list-products', params: { appId: 'evil', q: 1 } });
  assert.equal(answer.ran.action, 'list-products');
  assert.deepEqual(answer.ran.params, { appId: 'evil', q: 1 }, 'params pass through untouched: it is the module that never reads an appId from them');
  assert.equal(answer.ran.context.appId, 'demo');
  assert.equal(answer.ran.context.networkId, 'n1');
  assert.deepEqual(answer.ran.context.user, { id: 'u1' });

  for (const [applicationId, action] of [['Commerce', 'nope'], ['Application', 'x'], ['Users', 'current'], [undefined, undefined]]) {
    assert.equal((await answerIntent(host, { applicationId, action, params: {} })).error.code, 'not_available');
  }
  // Params that are not an object are an empty object, not a crash.
  assert.equal((await answerIntent(host, { applicationId: 'Commerce', action: 'list-products', params: 'x' })).ran.params.constructor, Object);
});

test('answerCall: an app-state function answers 501 not_available before its scope is weighed or its params read', async () => {
  let grantsRead = 0;
  const calls = [];
  const { host } = fakeHost({
    grants: () => ({ has: async () => { grantsRead += 1; return true; } }),
    services: () => ({ call: async (name) => { calls.push(name); return { data: 1 }; } }),
  });
  const notServed = { error: { status: true, code: 501, message: 'not_available' } };
  // A consent scope (veruswallet:read): the user must never be asked about a function the host cannot serve.
  assert.deepEqual(await answerCall(host, { service: 'VerusWallet', action: 'get-balance', params: {} }), notServed);
  assert.deepEqual(await answerCall(host, { service: 'VerusWallet', action: 'get-balance', params: [] }), notServed, 'not 400');
  // Forbidden scopes: 501 as well, the same answer the channel gives.
  assert.deepEqual(await answerCall(host, { service: 'Developer', action: 'list-applications', params: {} }), notServed);
  assert.deepEqual(await answerCall(host, { service: 'Developer', action: 'create-application', params: {} }), notServed);
  assert.equal(grantsRead, 0, 'the grants were never read');
  assert.deepEqual(calls, []);

  const signedOut = fakeHost({ signedIn: () => false }).host;
  assert.equal((await answerCall(signedOut, { service: 'VerusWallet', action: 'get-balance', params: {} })).error.code, 401,
    'signed out is still asked first, as for local');
});

test('answerIntent: a service function asked for as an intent names the SDK method to call instead', async () => {
  const { host } = fakeHost();
  for (const [applicationId, action, method] of [
    ['Users', 'current', 'valu.Users.current()'],
    ['Users', 'find-user', 'valu.Users.findUser()'],
    ['users', 'search_users', 'valu.Users.searchUsers()'],
    ['VerusWallet', 'get-balance', 'valu.VerusWallet.getBalance()'],
    ['Http', 'get', 'valu.Http.get()'],
  ]) {
    const answer = await answerIntent(host, { applicationId, action, params: {} });
    assert.equal(answer.error.code, 'not_available', `${applicationId}.${action}`);
    assert.ok(answer.error.message.includes(`use ${method}`), answer.error.message);
  }
  const plain = await answerIntent(host, { applicationId: 'Rooms', action: 'list-products', params: {} });
  assert.deepEqual(plain, notAvailable('Rooms.list-products'), 'an intent that is no function keeps the plain answer');
  assert.ok(!(await answerIntent(host, { applicationId: 'Users', action: 'nope' })).error.message.includes('use valu.'));
});

test('answerIntent: the identity token marks its reply, and only that reply', async () => {
  const { host } = fakeHost();
  const reply = await answerIntent(host, { applicationId: 'Application', action: 'get-identity-token', params: {} });
  assert.deepEqual(reply, { token: 'jwt' });
  assert.equal(isIdentityReply(reply), true);
  const other = await answerIntent(host, { applicationId: 'Commerce', action: 'list-products', params: {} });
  assert.equal(isIdentityReply(other), false);
  assert.equal(isIdentityReply({ token: 'jwt' }), false, 'a lookalike is not a member');
  assert.equal(isIdentityReply({ ...reply }), false, 'a copy is not the marked reply');
  const mine = {};
  assert.equal(markIdentityReply(mine), mine, 'marking returns the same object');
  assert.equal(isIdentityReply(mine), true);

  const refused = fakeHost({ emit: async () => ({ error: { status: true, code: 503, message: 'down' } }) }).host;
  assert.deepEqual(await answerIntent(refused, { applicationId: 'Application', action: 'get-identity-token' }), {
    success: false, code: 'disconnected', error: 'down',
  });
  const bare = fakeHost({ emit: async () => ({ error: { status: true, code: 500 } }) }).host;
  assert.equal((await answerIntent(bare, { applicationId: 'Application', action: 'get-identity-token' })).error, 'the identity token could not be issued');
});
