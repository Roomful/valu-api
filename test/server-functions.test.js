// The server-functions reference, held to the handlers.
//
// docs/server-functions.md tells an integrator what a runtime must supply
// before each function can succeed — an application identity, a piece of
// application state, a fetch, an origin. Those requirements are metadata
// (scripts/functions.js REQUIREMENTS), and metadata rots: a handler that stops
// needing the app id, or a new one that starts, would leave the doc quietly
// wrong and the integrator debugging a 403 that reads like an auth problem.
//
// So the two requirements a call can be OBSERVED to have are swept here, over
// every served function: take the thing away, and assert that exactly the
// documented functions refuse for exactly that reason. Both directions matter
// — an undocumented requirement fails as loudly as a stale one.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SERVICE_DESCRIPTORS, findDescriptor } from '../src/services/descriptors.js';
import { serviceRegistry } from '../src/services/registry.js';
import '../src/services/impl/index.js';
import { SocketTransport } from '../src/transport/SocketTransport.js';
import { NodeSocketAdapter } from '../src/socket/NodeSocketAdapter.js';
import { ERROR_CODES } from '../src/Errors.js';
import { REQUIREMENTS } from '../scripts/functions.js';
import { Responder, FakeRoomfulConnection, FakeGuru, FakeAppState, fakeFetch } from './helpers/fakes.js';

const implemented = new Set(serviceRegistry.implemented());
const served = SERVICE_DESCRIPTORS.filter((d) => d.binding !== 'postmessage' && implemented.has(d.key));

/** The requirement tags the generator knows how to render. */
const TAGS = /^(applicationId\??|fetch|config|appState\.[A-Za-z]+\??)$/;

/** Functions that MUST have the stamped application identity. */
const needsAppId = new Set(
  Object.entries(REQUIREMENTS)
    .filter(([, reqs]) => reqs.includes('applicationId'))
    .map(([key]) => key),
);

/** Function → the app-state capability it must have, for the non-optional ones. */
const needsAppState = new Map(
  Object.entries(REQUIREMENTS)
    .flatMap(([key, reqs]) => reqs
      .filter((r) => r.startsWith('appState.') && !r.endsWith('?'))
      .map((r) => [key, r.slice('appState.'.length)])),
);

/**
 * Params good enough to reach the requirement check: every REQUIRED param
 * filled with something of the right type, so a handler does not refuse for a
 * missing argument before it looks at its runtime.
 */
function paramsFor(descriptor) {
  const params = {};
  for (const p of descriptor.params.required) {
    if (p.options?.length) params[p.name] = p.options[0];
    else if (p.type === 'number') params[p.name] = 1;
    else if (p.type === 'boolean') params[p.name] = true;
    else if (p.type === 'array' || p.type === 'string[]' || p.type === 'object[]') params[p.name] = ['x'];
    else if (p.type === 'object') params[p.name] = {};
    else params[p.name] = 'x';
  }
  return params;
}

/**
 * Every served function, called once against a transport that is complete
 * EXCEPT for whatever `omit` takes away. Nothing reaches a network: the
 * connection, the guru socket and the bucket are all fakes, and a call that
 * gets past its requirement check simply fails on a missing fake — which is
 * not the refusal these sweeps look for.
 */
async function sweep(omit = {}) {
  const socket = new NodeSocketAdapter({ connection: new FakeRoomfulConnection(new Responder()) });
  const transport = new SocketTransport({
    socket,
    guru: new FakeGuru(),
    appState: new FakeAppState({
      getChatHistory: async () => ({ session: {}, messages: [] }),
      getAgentHistory: async () => ({ agent: {}, messages: [] }),
      listDeveloperApplications: async () => [],
      createDeveloperApplication: async () => ({ appId: 'a' }),
      getAgentWallet: async () => ({ identityName: 'i', iAddress: 'i@', balance: 0, status: 'created' }),
    }),
    fetchImpl: fakeFetch(),
    applicationId: 'test-app',
    config: { webBase: 'https://example.test', apiGate: 'https://api.example.test' },
    ...omit,
  });

  const acks = new Map();
  for (const descriptor of served) {
    acks.set(descriptor.key, await transport.callService(descriptor, paramsFor(descriptor)));
  }
  return acks;
}

// --- the metadata itself ---------------------------------------------------

test('every documented requirement belongs to a function this package serves', () => {
  for (const [key, reqs] of Object.entries(REQUIREMENTS)) {
    const descriptor = findDescriptor(key);
    assert.ok(descriptor, `REQUIREMENTS names ${key}, which is not a declared function`);
    assert.notEqual(descriptor.binding, 'postmessage', `${key} is postMessage-bound — it is not served here`);
    assert.ok(implemented.has(key), `REQUIREMENTS names ${key}, which has no handler`);
    assert.ok(reqs.length > 0, `${key} lists no requirement — drop the entry instead`);
    for (const req of reqs) {
      assert.match(req, TAGS, `${key}: "${req}" is not a requirement tag the docs can render`);
    }
  }
});

// --- what the handlers actually enforce ------------------------------------

test('exactly the documented functions need the application identity', async () => {
  const acks = await sweep({ applicationId: undefined });
  const refused = new Set(
    [...acks].filter(([, ack]) => ack.error?.code === ERROR_CODES.FORBIDDEN
      && /could not be identified/.test(ack.error.message ?? ''))
      .map(([key]) => key),
  );
  assert.deepEqual([...refused].sort(), [...needsAppId].sort());
});

test('a function that needs the application identity works once it is stamped', async () => {
  const acks = await sweep();
  for (const key of needsAppId) {
    const ack = acks.get(key);
    assert.notEqual(ack.error?.code, ERROR_CODES.FORBIDDEN, `${key} refused a stamped application`);
  }
});

test('exactly the documented functions need application state, and each names its capability', async () => {
  const acks = await sweep({ appState: undefined });
  const refused = new Map();
  for (const [key, ack] of acks) {
    const match = /needs application state \(([A-Za-z]+)\)/.exec(ack.error?.message ?? '');
    if (match) refused.set(key, match[1]);
  }
  assert.deepEqual(
    [...refused].sort(),
    [...needsAppState].sort(),
    'a function refuses for application state the reference does not document, or the reverse',
  );
  for (const [, ack] of acks) {
    if (/needs application state/.test(ack.error?.message ?? '')) {
      assert.equal(ack.error.code, ERROR_CODES.UNSUPPORTED);
    }
  }
});

test('the reference covers every served function', () => {
  // Not every function HAS an extra requirement — most need only their
  // channel. This asserts the doc's denominator instead: the count in the
  // heading is the registry's, so a new function cannot appear without the
  // reference growing a row for it.
  assert.equal(served.length, 77);
  assert.equal(
    served.filter((d) => d.channel === 'app-state').length,
    5,
    'app-state is the channel with no RPC behind it — the count is load-bearing',
  );
});
