// The catalogue is the parity target. These numbers are counted from the
// manifest, not estimated, and they are the ones the implementation plan
// commits to — so they are asserted, and a drift fails the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SERVICE_DESCRIPTORS, SERVER_ONLY_TOOLS, findDescriptor, listDescriptors,
  listServices, catalogSummary,
} from '../src/services/descriptors.js';
import { toolDefinition, toolDefinitions } from '../src/services/toolDefs.js';
import { ServiceRegistry } from '../src/services/registry.js';

test('the catalogue matches the parity target', () => {
  assert.deepEqual(catalogSummary(), {
    total: 92,      // declared service intents
    socket: 69,     // SDK-able, socket-backed
    local: 8,       // SDK-able, answered locally
    postmessage: 15, // UI-bound — stays on the postMessage bridge
    implemented: 32, // already server tools, exact name match
    sdkable: 77,
    remaining: 45,
    serverOnly: 7,
  });
});

test('21 services, each with at least one function', () => {
  const services = listServices();
  assert.equal(services.length, 21);
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
    assert.ok(['socket', 'local', 'postmessage'].includes(d.binding), d.key);
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

test('a write is never cached; a postMessage-bound function is never cached', () => {
  for (const d of listDescriptors({ mutates: true })) {
    assert.equal(d.cache.mode, 'none', `${d.key} is a write and must not be cached`);
  }
  for (const d of listDescriptors({ binding: 'postmessage' })) {
    assert.equal(d.cache.mode, 'none', `${d.key} is postMessage-bound and must not be cached`);
  }
});

test('the 32 already-implemented functions are all SDK-able', () => {
  const implemented = SERVICE_DESCRIPTORS.filter((d) => d.implementedBy);
  assert.equal(implemented.length, 32);
  for (const d of implemented) {
    assert.notEqual(d.binding, 'postmessage', `${d.key} cannot be both a server tool and postMessage-bound`);
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

test('the default tool surface is AI-available and never postMessage-bound', () => {
  const defs = toolDefinitions();
  const names = new Set(defs.map((d) => d.function.name));
  assert.ok(defs.length > 0);
  for (const d of listDescriptors({ availability: 'ai', binding: 'postmessage' })) {
    assert.equal(names.has(d.toolName), false, `${d.key} is postMessage-bound and must not be offered as a tool`);
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

test('the registry refuses what is not declared, and what is postMessage-bound', () => {
  const registry = new ServiceRegistry();

  assert.throws(() => registry.define('Users.teleport', async () => ({})), /not a declared service function/);
  assert.throws(() => registry.define('Logging.get-logs', async () => ({})), /postMessage-bound/);
  assert.throws(() => registry.define('Users.get', 'not a function'), /must be a function/);

  registry.define('Users.get', async () => ({ data: 1 }));
  assert.deepEqual(registry.implemented(), ['Users.get']);
  assert.ok(registry.has('service__Users__get'), 'any name form resolves to the same registration');
});

// ---------------------------------------------------------------------------
// Phase 2 — the parity matrix implemented.
// ---------------------------------------------------------------------------

test('every SDK-able function is implemented, and no postMessage-bound one is', async () => {
  const { serviceRegistry } = await import('../src/services/impl/index.js');
  const implemented = new Set(serviceRegistry.implemented());

  const sdkable = SERVICE_DESCRIPTORS.filter((d) => d.binding !== 'postmessage');
  assert.equal(sdkable.length, 77, 'the parity target: 69 socket + 8 local');

  const missing = sdkable.map((d) => d.key).filter((key) => !implemented.has(key));
  assert.deepEqual(missing, [], 'Phase 2 is not done while one of these is unimplemented');

  for (const d of listDescriptors({ binding: 'postmessage' })) {
    assert.equal(implemented.has(d.key), false, `${d.key} is a frame command, not a service function`);
  }
  assert.equal(implemented.size, 77);
});

test('the channel says WHICH socket, and every socket function has one', () => {
  const counts = { roomful: 0, valuguru: 0, 'app-state': 0, local: 0, postmessage: 0 };
  for (const d of SERVICE_DESCRIPTORS) {
    assert.ok(d.channel in counts, `${d.key} has channel "${d.channel}"`);
    counts[d.channel]++;
    // A `local` or `postmessage` function's channel restates its binding; only a
    // socket one adds anything, and it must add something.
    if (d.binding !== 'socket') assert.equal(d.channel, d.binding, d.key);
    else assert.notEqual(d.channel, 'socket', `${d.key} must say which socket`);
  }
  assert.deepEqual(counts, { roomful: 53, valuguru: 11, 'app-state': 5, local: 8, postmessage: 15 });
  assert.equal(counts.roomful + counts.valuguru + counts['app-state'], 69, 'still 69 socket-bound');
});

test('Commerce rides the Valu Guru socket, not the Roomful one', () => {
  // The finding that made `channel` necessary: ten Commerce intents and the
  // RAG search are `valuguru.*` ops over a different socket entirely.
  for (const d of listDescriptors({ service: 'Commerce', binding: 'socket' })) {
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
