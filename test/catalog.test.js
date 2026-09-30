// The catalogue is the parity target. These numbers are counted from the
// manifest, not estimated, and they are the ones the implementation plan
// commits to — so they are asserted, and a drift fails the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SERVICE_DESCRIPTORS, SERVER_ONLY_TOOLS, SERVICE_FUNCTIONS, APPLICATION_ONLY_INTENTS,
  findDescriptor, listDescriptors, listServices, catalogSummary, isServiceFunction,
} from '../src/services/descriptors.js';
import { APPLICATION_ONLY } from '../scripts/bindings.js';
import { toolDefinition, toolDefinitions } from '../src/services/toolDefs.js';
import { ServiceRegistry } from '../src/services/registry.js';

test('the catalogue matches the parity target', () => {
  assert.deepEqual(catalogSummary(), {
    total: 78,       // everything in the catalogue — all of it runnable here
    roomful: 54,     // the Roomful platform socket
    valuguru: 11,    // the Valu Guru server's data_request channel
    'app-state': 5,  // no RPC exists; the runtime supplies the state
    local: 8,        // answered by the SDK itself
    socket: 65,      // roomful + valuguru
    implemented: 32, // already server tools, exact name match
    // WHO declared them. 77 is a fact about valusocial-web and must not move
    // when this package adds a function; 1 is scripts/extensions.js.
    declared: 77,
    sdkDeclared: 1,
    serviceFunctions: 78,
    applicationOnly: 15,
    remaining: 46,
    serverOnly: 7,
  });
});

test('every descriptor in the catalogue is a function this package can run', () => {
  // The rule the package is shaped by: a descriptor is a promise that the SDK
  // runs this itself, given the connection its channel names. There is no
  // second kind of entry any more.
  assert.equal(SERVICE_FUNCTIONS.length, SERVICE_DESCRIPTORS.length);
  assert.equal(SERVICE_FUNCTIONS.length, 78);
  assert.equal(isServiceFunction('Users.current'), true);
  assert.equal(isServiceFunction('Users.teleport'), false);
});

test('the 15 application-only intents are declared by the app and absent here', () => {
  assert.equal(APPLICATION_ONLY_INTENTS.length, 15);
  assert.deepEqual([...APPLICATION_ONLY_INTENTS].sort(), [...APPLICATION_ONLY].sort());
  for (const key of APPLICATION_ONLY_INTENTS) {
    // No descriptor, no method, no tool definition, no alias: a caller who
    // asks for one by name gets "unknown", not a function that cannot work.
    assert.equal(findDescriptor(key), undefined, `${key} must not be in the catalogue`);
    assert.equal(isServiceFunction(key), false, key);
  }
  // They are still reachable — by name over the bridge, which needs no
  // declaration at all. api-pointers.md is where that is written down.
  assert.ok(APPLICATION_ONLY_INTENTS.includes('AiGuru.open'));
  assert.ok(APPLICATION_ONLY_INTENTS.includes('DataProvider.pick-single'));
});

test('every manifest intent is either a function here or explicitly excluded', async () => {
  // The one test that notices a NEW intent in the app: it must be classified,
  // never silently dropped by a generator that does not know about it.
  const { readFileSync } = await import('node:fs');
  const snapshot = JSON.parse(readFileSync(
    new URL('../manifests/service-manifests.snapshot.json', import.meta.url), 'utf8',
  ));
  const excluded = new Set(APPLICATION_ONLY);
  let declared = 0;
  for (const service of snapshot.services) {
    for (const intent of service.intents) {
      declared++;
      const key = `${service.id}.${intent.action}`;
      assert.ok(findDescriptor(key) || excluded.has(key), `${key} is neither implemented nor excluded`);
    }
  }
  assert.equal(declared, 92, "the app's manifest declares 92 intents");
});

test('an SDK-declared function is a service function with its provenance on it', () => {
  const sdkDeclared = listDescriptors({ declaredBy: 'sdk' });
  assert.deepEqual(sdkDeclared.map((d) => d.key), ['Users.list-connection-requests']);
  for (const d of sdkDeclared) {
    // It must be reachable without the application: declaring a function this
    // package cannot run would be worse than leaving the gap open.
    assert.ok(['roomful', 'valuguru', 'local'].includes(d.channel), d.key);
    assert.ok(d.description.length > 0, d.key);
  }
  // And the manifest's own count is untouched by it.
  assert.equal(listDescriptors({ declaredBy: 'manifest' }).length, 77);
});

test('every service in the catalogue has at least one function', () => {
  const services = listServices();
  assert.equal(services.length, 18);
  for (const service of services) {
    assert.ok(listDescriptors({ service }).length > 0, service);
  }
});

test('every descriptor is complete and frozen', () => {
  for (const d of SERVICE_DESCRIPTORS) {
    assert.ok(Object.isFrozen(d), `${d.key} must be immutable`);
    assert.equal(d.key, `${d.service}.${d.action}`);
    assert.equal(d.fn, d.action.replace(/-/g, '_'));
    assert.equal(d.toolName, `service__${d.service}__${d.fn}`);
    assert.ok(d.description.length > 0, `${d.key} has no description`);
    assert.ok(['roomful', 'valuguru', 'app-state', 'local'].includes(d.channel), d.key);
    assert.equal(d.binding, undefined, `${d.key} still carries the removed binding field`);
    assert.equal(typeof d.mutates, 'boolean');
    assert.ok(d.scopes.length > 0, `${d.key} declares no scope`);
    assert.ok(['none', 'read-through', 'seeded'].includes(d.cache.mode), d.key);
    assert.ok(Array.isArray(d.params.required) && Array.isArray(d.params.optional), d.key);
  }
});

test('keys are unique', () => {
  const keys = SERVICE_DESCRIPTORS.map((d) => d.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('a function resolves by any of the four names the platform uses', () => {
  const expected = 'Users.search-users';
  for (const name of [
    'Users.search-users', 'Users.search_users', 'Users.searchUsers',
    'service__Users__search_users', 'SERVICE__USERS__SEARCH_USERS',
  ]) {
    assert.equal(findDescriptor(name)?.key, expected, name);
  }
  assert.equal(findDescriptor('Users.nope'), undefined);
  assert.equal(findDescriptor(undefined), undefined);
});

test('a write is never cached', () => {
  for (const d of listDescriptors({ mutates: true })) {
    assert.equal(d.cache.mode, 'none', `${d.key} is a write and must not be cached`);
  }
});

test('the 32 already-implemented functions are all SDK-able', () => {
  const implemented = SERVICE_DESCRIPTORS.filter((d) => d.implementedBy);
  assert.equal(implemented.length, 32);
  for (const d of implemented) {
    assert.equal(d.implementedBy, d.toolName);
  }
});

test('the 7 server-only tools are not in the catalogue', () => {
  assert.equal(SERVER_ONLY_TOOLS.length, 7);
  const toolNames = new Set(SERVICE_DESCRIPTORS.map((d) => d.toolName));
  for (const tool of SERVER_ONLY_TOOLS) {
    assert.equal(toolNames.has(tool), false, `${tool} would not be server-ONLY`);
  }
});

test('the seeded cache policy is on the function that needs it', () => {
  // verus.ts records that the app answers getBalance from the store cache and
  // does not hit the network. The SDK must not silently change that.
  assert.equal(findDescriptor('VerusWallet.get-balance').cache.mode, 'seeded');
});

test('tool definitions are valid JSON schema and match the descriptor', () => {
  const descriptor = findDescriptor('Events.create-meeting');
  const def = toolDefinition(descriptor);

  assert.equal(def.type, 'function');
  assert.equal(def.function.name, 'service__Events__create_meeting');
  assert.deepEqual(def.function.parameters.required, ['title', 'type']);
  assert.equal(def.function.parameters.additionalProperties, false);
  assert.equal(def.function.parameters.properties.participants.type, 'array');
  assert.equal(def.function.parameters.properties.participants.items.type, 'string');
  assert.equal(def.function.parameters.properties.recurringWeekly.type, 'boolean');
});

test('an enum param becomes a schema enum', () => {
  const def = toolDefinition(findDescriptor('Commerce.list-products'));
  assert.deepEqual(def.function.parameters.properties.sort.enum,
    ['newest', 'popular', 'priceAsc', 'priceDesc', 'rating']);
});

test('the default tool surface is AI-available, and every tool has a handler', async () => {
  const { serviceRegistry } = await import('../src/services/impl/index.js');
  const defs = toolDefinitions();
  const names = new Set(defs.map((d) => d.function.name));
  assert.ok(defs.length > 0);
  for (const name of names) {
    // A tool definition handed to a model is a promise that calling it does
    // something. Every one of them resolves to a registered handler.
    assert.ok(serviceRegistry.has(name), `${name} is offered as a tool with no handler`);
  }
  for (const name of names) {
    const descriptor = findDescriptor(name);
    assert.ok(descriptor.availability.includes('ai'), `${name} is not AI-available`);
  }
});

test('a function with no params still gets an object schema', () => {
  const def = toolDefinition(findDescriptor('Users.current'));
  assert.deepEqual(def.function.parameters, { type: 'object', properties: {}, additionalProperties: false });
});

test('the registry refuses what is not declared', () => {
  const registry = new ServiceRegistry();

  assert.throws(() => registry.define('Users.teleport', async () => ({})), /not a declared service function/);
  // An application-only intent is not declared HERE, so it lands in the same
  // refusal as a typo — which is the point of taking them out of the catalogue.
  assert.throws(() => registry.define('Logging.get-logs', async () => ({})), /not a declared service function/);
  assert.throws(() => registry.define('Users.get', 'not a function'), /must be a function/);

  registry.define('Users.get', async () => ({ data: 1 }));
  assert.deepEqual(registry.implemented(), ['Users.get']);
  assert.ok(registry.has('service__Users__get'), 'any name form resolves to the same registration');
});

// ---------------------------------------------------------------------------
// Phase 2 — the parity matrix implemented.
// ---------------------------------------------------------------------------

test('every declared function is implemented', async () => {
  const { serviceRegistry } = await import('../src/services/impl/index.js');
  const implemented = new Set(serviceRegistry.implemented());

  assert.equal(SERVICE_DESCRIPTORS.length, 78, '65 socket + 5 app-state + 8 local');

  const missing = SERVICE_DESCRIPTORS.map((d) => d.key).filter((key) => !implemented.has(key));
  assert.deepEqual(missing, [], 'a declared function with no handler answers 501');
  assert.equal(implemented.size, 78);
});

test('the channel says WHICH connection, and every function has one', () => {
  const counts = { roomful: 0, valuguru: 0, 'app-state': 0, local: 0 };
  for (const d of SERVICE_DESCRIPTORS) {
    assert.ok(d.channel in counts, `${d.key} has channel "${d.channel}"`);
    counts[d.channel]++;
  }
  assert.deepEqual(counts, { roomful: 54, valuguru: 11, 'app-state': 5, local: 8 });
  assert.equal(counts.roomful + counts.valuguru, 65, 'the socket functions');
});

test('Commerce rides the Valu Guru socket, not the Roomful one', () => {
  // The finding that made `channel` necessary: ten Commerce intents and the
  // RAG search are `valuguru.*` ops over a different socket entirely.
  for (const d of listDescriptors({ service: 'Commerce' })) {
    assert.equal(d.channel, 'valuguru', d.key);
  }
  assert.equal(findDescriptor('AiGuru.query-knowledge-base').channel, 'valuguru');
  assert.equal(findDescriptor('Users.get').channel, 'roomful');
});

test('app-state functions are never cached — except the one that is only a cache', () => {
  for (const d of SERVICE_DESCRIPTORS.filter((d) => d.channel === 'app-state')) {
    if (d.key === 'VerusWallet.get-balance') {
      assert.equal(d.cache.mode, 'seeded');
      continue;
    }
    assert.equal(d.cache.mode, 'none', `${d.key} is already in memory; caching it only adds staleness`);
  }
});

test('every function declares what it returns', () => {
  for (const d of SERVICE_DESCRIPTORS) {
    assert.notEqual(d.returns.type, 'unknown', `${d.key} has no declared return shape`);
    assert.ok(d.returns.description.length > 0, `${d.key} does not say what it returns`);
  }
});

test('the 7 server-only tools are each resolved, not left as a gap', async () => {
  const { SERVER_ONLY_RECONCILIATION } = await import('../src/services/catalog.generated.js');
  assert.equal(SERVER_ONLY_RECONCILIATION.length, SERVER_ONLY_TOOLS.length);

  const tools = new Set(SERVER_ONLY_TOOLS);
  for (const entry of SERVER_ONLY_RECONCILIATION) {
    assert.ok(tools.has(entry.tool), `${entry.tool} is not a server-only tool`);
    assert.ok(['binding', 'declared', 'internal'].includes(entry.disposition), entry.tool);
    assert.ok(entry.decision.length > 40, `${entry.tool} has no stated reason`);
    // A disposition that points at declared functions must point at real ones.
    for (const key of entry.declared) {
      assert.ok(findDescriptor(key), `${entry.tool} names ${key}, which is not declared`);
    }
    if (entry.disposition === 'internal') assert.deepEqual(entry.declared, []);
    else assert.ok(entry.declared.length > 0, `${entry.tool} is ${entry.disposition} but names nothing`);
  }
});

test('every known behaviour delta names a real function', async () => {
  const { KNOWN_DELTAS } = await import('../scripts/functions.js');
  assert.ok(KNOWN_DELTAS.length > 0);
  for (const entry of KNOWN_DELTAS) {
    assert.ok(findDescriptor(entry.key), `${entry.key} is not a declared function`);
    assert.ok(entry.delta.length > 60, `${entry.key} does not say what differs`);
  }
});
