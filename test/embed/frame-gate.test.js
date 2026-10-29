// ===========================================================================
// FrameGate: the permission gate Valu Social holds a framed app to (the
// owner's decision, 2026-10-29). Off: nothing changes. Report: nothing
// changes, misses are counted. Enforce: the host's order, and a consent asked
// right there, once.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFrameGate } from '../../src/embed/FrameGate.js';
import { createFrameServer } from '../../src/embed/FrameServer.js';
import { findDescriptor } from '../../src/services/descriptors.js';

function parts({ mode = 'enforce', scopes = ['users:read', 'groups:read'], granted = [], answer = true } = {}) {
  const misses = [];
  const asked = [];
  const held = new Set(granted);
  const declarations = {
    get: async () => ({ mode, scopes }),
    reportMiss: (scope, m) => misses.push([scope, m]),
  };
  const grants = {
    has: async (scope) => held.has(scope),
    grant: async (list) => { for (const s of list) held.add(s); },
  };
  const ask = async (list) => { asked.push(list); return typeof answer === 'function' ? answer(list) : answer; };
  return { declarations, grants, ask, misses, asked, held };
}

test('off: everything runs, nothing is read but the mode', async () => {
  const p = parts({ mode: 'off', scopes: null });
  const gate = createFrameGate(p);
  for (const scope of ['users:read', 'cbac:write', 'rooms:write', null]) assert.deepEqual(await gate.permit(scope), { ok: true });
  assert.deepEqual(p.misses, []);
  assert.deepEqual(p.asked, []);
});

test('report: everything runs; an undeclared scope is counted; no one is asked', async () => {
  const p = parts({ mode: 'report', scopes: ['users:read'] });
  const gate = createFrameGate(p);
  assert.deepEqual(await gate.permit('rooms:write'), { ok: true });
  assert.deepEqual(await gate.permit('users:read'), { ok: true });
  assert.deepEqual(p.misses, [['rooms:write', 'report']]);
  assert.deepEqual(p.asked, []);
});

test('enforce: the host\'s order', async () => {
  const p = parts({ scopes: ['users:read', 'groups:read', 'cbac:write'] });
  const gate = createFrameGate(p);
  assert.deepEqual(await gate.permit('users:read'), { ok: true });
  assert.deepEqual(await gate.permit('networks:read'), { ok: false, code: 'permission_not_declared', scope: 'networks:read' });
  assert.deepEqual(await gate.permit('cbac:write'), { ok: false, code: 'forbidden', scope: 'cbac:write' });
  assert.deepEqual(await gate.permit('http:read'), { ok: false, code: 'permission_not_declared', scope: 'http:read' });
  assert.deepEqual(await gate.permit(null), { ok: false, code: 'unknown_function', scope: null });
  assert.deepEqual(p.misses, [['networks:read', 'enforce'], ['http:read', 'enforce']]);
  const http = parts({ scopes: ['http:read'] });
  assert.deepEqual(await createFrameGate(http).permit('http:read'), { ok: true }, 'the bridge runs a declared Http intent');
});

test('enforce: a declared consent scope without a grant asks once; yes is written and runs, no is consent_required', async () => {
  const yes = parts();
  const gate = createFrameGate(yes);
  const [a, b] = await Promise.all([gate.permit('groups:read'), gate.permit('groups:read')]);
  assert.deepEqual([a, b], [{ ok: true }, { ok: true }]);
  assert.deepEqual(yes.asked, [['groups:read']], 'two calls at once share one question');
  assert.ok(yes.held.has('groups:read'));
  assert.deepEqual(await gate.permit('groups:read'), { ok: true });
  assert.equal(yes.asked.length, 1, 'a held grant is not asked again');

  const no = parts({ answer: false });
  assert.deepEqual(await createFrameGate(no).permit('groups:read'), { ok: false, code: 'consent_required', scope: 'groups:read' });
  assert.equal(no.held.size, 0);
});

test('enforce: an undeclared consent scope is never asked about', async () => {
  const p = parts({ scopes: ['users:read'] });
  assert.deepEqual(await createFrameGate(p).permit('groups:read'), { ok: false, code: 'permission_not_declared', scope: 'groups:read' });
  assert.deepEqual(p.asked, []);
});

test('a declaration or grants that cannot be read are unavailable, never a pass; permit never rejects', async () => {
  const unreadable = parts();
  unreadable.declarations.get = async () => { throw Object.assign(new Error('x'), { code: 'timeout' }); };
  assert.deepEqual(await createFrameGate({ ...unreadable, log: () => {} }).permit('users:read'),
    { ok: false, code: 'unavailable', scope: 'users:read' });

  const badGrants = parts();
  badGrants.grants.has = async () => { throw new Error('down'); };
  assert.deepEqual(await createFrameGate({ ...badGrants, log: () => {} }).permit('groups:read'),
    { ok: false, code: 'unavailable', scope: 'groups:read' });

  const throwingAsk = parts({ answer: () => { throw new Error('dialog'); } });
  assert.deepEqual(await createFrameGate({ ...throwingAsk, log: () => {} }).permit('groups:read'),
    { ok: false, code: 'unavailable', scope: 'groups:read' });
});

test('needs its parts', () => {
  const p = parts();
  assert.throws(() => createFrameGate({ ...p, declarations: null }), TypeError);
  assert.throws(() => createFrameGate({ ...p, grants: {} }), TypeError);
  assert.throws(() => createFrameGate({ ...p, ask: null }), TypeError);
});

test('the frame server answers a refused api:call as the host does, and runs nothing', async () => {
  const calls = [];
  const services = { call: async (name, params) => { calls.push(name); return { data: {} }; } };
  const p = parts({ scopes: ['users:read'] });
  const server = createFrameServer({ services, gate: createFrameGate(p).permit, log: () => {} });
  const users = findDescriptor('Users.current');
  const network = findDescriptor('Networks.get-current-network');

  assert.deepEqual(await server.handle({ service: users.service, action: users.action, params: {} }), { data: {} });
  assert.deepEqual(await server.handle({ service: network.service, action: network.action, params: {} }), {
    error: {
      status: true, code: 403, message: 'permission_not_declared', scope: 'networks:read',
      description: 'This app does not declare networks:read in valu-permissions.json.',
    },
  });
  assert.deepEqual(calls, ['Users.current']);
  assert.throws(() => createFrameServer({ services, gate: 'yes' }), TypeError);
});
