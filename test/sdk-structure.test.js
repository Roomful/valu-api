// docs/sdk-structure.md is the answer to "what is this package, and why is
// there no function for `close`". It is prose, so it is not generated — and
// prose with numbers in it rots silently. Every number and every migration row
// in it is read back out of the catalogue and the code here, so the page fails
// the build rather than going quietly out of date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SERVICE_DESCRIPTORS, SERVICE_FUNCTIONS, APPLICATION_INTENTS, listDescriptors, findDescriptor,
} from '../src/services/descriptors.js';
import { SERVER_TOOLS } from '../scripts/bindings.js';
import { SDK_DECLARED } from '../scripts/extensions.js';
import { pointerSummary } from '../scripts/apiPointers.js';
import { createValuServices } from '../src/services/api.js';
import { NodeSocketAdapter } from '../src/socket/NodeSocketAdapter.js';
import { FakeRoomfulConnection, Responder } from './helpers/fakes.js';

const doc = readFileSync(new URL('../docs/sdk-structure.md', import.meta.url), 'utf8');

const row = (label) => {
  const m = new RegExp(`^\\| ${label} \\| \\**(\\d+)\\** \\|`, 'm').exec(doc);
  assert.ok(m, `no count row for "${label}"`);
  return Number(m[1]);
};
const countBy = (channel) => SERVICE_DESCRIPTORS.filter((d) => d.channel === channel).length;

test('the counts table is the catalogue', () => {
  assert.equal(row('intents the application declares'), listDescriptors({ declaredBy: 'manifest' }).length);
  assert.equal(row('functions this package declares itself'), listDescriptors({ declaredBy: 'sdk' }).length);
  assert.equal(row('\\*\\*service functions — the library\\*\\*'), SERVICE_FUNCTIONS.length);
  assert.equal(row('… on the Roomful socket'), countBy('roomful'));
  assert.equal(row('… on the Valu Guru socket'), countBy('valuguru'));
  assert.equal(row('… answered from application state'), countBy('app-state'));
  assert.equal(row('… answered locally by the SDK'), countBy('local'));
  assert.equal(
    row('\\*\\*application intents — no function, one dynamic call\\*\\*'),
    APPLICATION_INTENTS.length,
  );
  assert.equal(row('API pointer functions \\(generic, untyped\\)'), pointerSummary().functions);
});

test('the surfaces table quotes the same two numbers', () => {
  const surfaces = /\| how many \| (\d+) \| (\d+) declared here/.exec(doc);
  assert.ok(surfaces, 'the surfaces table has changed shape');
  assert.equal(Number(surfaces[1]), SERVICE_FUNCTIONS.length);
  assert.equal(Number(surfaces[2]), APPLICATION_INTENTS.length);
});

test('what the Valu Guru server gains is the measured number', () => {
  // It is a client of the Roomful socket and the SERVER of the Valu Guru one,
  // so only roomful + local are adoptable there.
  const adoptable = SERVICE_DESCRIPTORS.filter((d) => d.channel === 'roomful' || d.channel === 'local');
  const has = adoptable.filter((d) => SERVER_TOOLS.includes(d.key));
  const claim = /`roomful` \+ `local` = (\d+), of which it\s+already has (\d+), so an agent gains \*\*(\d+)\*\*/.exec(doc);
  assert.ok(claim, 'the adoption sentence has changed shape');
  assert.equal(Number(claim[1]), adoptable.length);
  assert.equal(Number(claim[2]), has.length);
  assert.equal(Number(claim[3]), adoptable.length - has.length);
});

test('every migration row names an intent that exists and a method that does not', async () => {
  const rows = [...doc.matchAll(/^\| `api\.frame\.(\w+)\([^)]*\)` \| `api\.intents\.run\('([^']+)'/gm)];
  assert.equal(rows.length, APPLICATION_INTENTS.length, 'one row per application intent');

  const covered = new Set();
  for (const [, oldMethod, key] of rows) {
    const descriptor = findDescriptor(key);
    assert.ok(descriptor, `${key} is not a declared intent`);
    assert.equal(descriptor.binding, 'postmessage', `${key} is not an application intent`);
    covered.add(descriptor.key);
    assert.ok(oldMethod.length > 0);
  }
  assert.deepEqual([...covered].sort(), APPLICATION_INTENTS.map((d) => d.key).sort());

  // And the left column is history: `api.frame` must be gone from the package.
  const { ValuApi } = await import('../src/ValuApi.js');
  assert.equal('frame' in new ValuApi({ transport: { addEventListener() {} } }), false);
});

test('the example calls in the doc are calls the package can actually make', async () => {
  const responder = new Responder({
    'social:getUsersSimpleInfo': { data: { users: [{ id: 'u-1' }] } },
    'request:listRequests': { data: { requests: [] } },
    'explorer:searchRooms': { data: { rooms: [] } },
  });
  const socket = new NodeSocketAdapter({ connection: new FakeRoomfulConnection(responder) });
  const valu = createValuServices({ socket, cache: null });

  // The three the doc opens with, verbatim.
  assert.deepEqual(await valu.data.Users.current(), { user: { id: 'u-1' } });
  assert.deepEqual(await valu.data.Users.listConnectionRequests(), { requests: [], users: [], hasMore: false });
  assert.deepEqual(await valu.data.Rooms.searchRooms({ query: 'design', size: 5 }), { rooms: [] });
});

test('the SDK-declared function the doc names is the one that exists', () => {
  assert.equal(SDK_DECLARED.length, 1, 'the doc describes exactly one');
  const [extension] = SDK_DECLARED;
  const descriptor = findDescriptor(`${extension.service}.${extension.intent.action}`);
  assert.ok(descriptor);
  assert.equal(descriptor.declaredBy, 'sdk');
  assert.ok(doc.includes(`\`${extension.rpc}\``), `the doc no longer names ${extension.rpc}`);
  assert.ok(doc.includes('listConnectionRequests'), 'the doc no longer names the method');
});
