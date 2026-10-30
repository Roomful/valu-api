// ===========================================================================
// The publish-time scanner (src/scan/detectScopes.js): reads an app's SOURCE and
// says which valu-api scopes its calls need, where each call is, which Valu
// Social bridge calls it makes, and which calls name their function at run time
// so cannot be read. It reads source, not the built bundle: valu-api ships its
// whole catalogue inside every bundle, so a bundle names every function there is.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectScopes } from '../../src/scan/detectScopes.js';

const scan = (text, path = 'src/app.ts') => detectScopes([{ path, text }]);
const only = (result) => {
  assert.equal(result.findings.length, 1, JSON.stringify(result.findings));
  return result.findings[0];
};

test('a member call on the app object', () => {
  assert.deepEqual(only(scan('await valu.Rooms.searchMyRooms({});')), {
    scope: 'rooms:read', call: 'Rooms.search-my-rooms', kind: 'function', file: 'src/app.ts', line: 1,
  });
});

test('the data namespace, and a destructured service', () => {
  assert.equal(only(scan('const me = await x.data.Users.current();')).scope, 'users:read');
  assert.equal(only(scan('const { Events } = valu;\nEvents.listEvents();')).scope, 'events:read');
});

test('a method name two services share resolves by its service', () => {
  assert.equal(only(scan('e.CMS.resourceSearch(a)')).scope, 'cms:read');
  assert.equal(only(scan('e.ApplicationStorage.resourceUpload(a)')).scope, 'applicationstorage:write');
  assert.deepEqual(scan('resourceSearch(a)').findings, []);
});

test('a call by name, in any of the names the catalogue accepts', () => {
  const found = scan("valu.call('Rooms.search-my-rooms', p);\nvalu.invoke(\"users.current\");").findings;
  assert.deepEqual(found.map((f) => [f.scope, f.call, f.line]), [
    ['rooms:read', 'Rooms.search-my-rooms', 1],
    ['users:read', 'Users.current', 2],
  ]);
});

test('an unrelated .call with a string is not a valu call', () => {
  assert.deepEqual(scan("phone.call('555-0100'); fn.call(this, 1);").findings, []);
  assert.deepEqual(scan("fn.call(this, 1);").unresolved, []);
});

test('intents: Commerce, the identity token, the older bridge\'s, and one with no scope', () => {
  assert.deepEqual(only(scan("valu.callService(new Intent('Commerce', 'get-cart'))")), {
    scope: 'commerce:read', call: 'Commerce.get-cart', kind: 'intent', file: 'src/app.ts', line: 1,
  });
  assert.equal(only(scan("new Intent('Application','get-identity-token')")).scope, 'application:identity');
  assert.equal(only(scan("new Intent('commerce', 'get-cart')")).scope, 'commerce:read');
  // Valu Social checks the older bridge's intents too, so they need their scopes (BridgeScopes.js).
  assert.deepEqual(only(scan("new Intent('textchat', 'open-channel', {userId})")), {
    scope: 'ui:open', call: 'textchat.open-channel', kind: 'bridge', file: 'src/app.ts', line: 1,
  });
  assert.equal(only(scan("new Intent('RoomZones', 'claim-zone')")).scope, 'rooms:write');
  const result = scan("new Intent('auth', 'logout')");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.bridge, [{ scope: null, call: 'auth.logout', kind: 'bridge', file: 'src/app.ts', line: 1 }]);
});

test('an intent that names a catalogue function needs that function\'s scope', () => {
  assert.equal(only(scan("new Intent('Rooms', 'search-my-rooms')")).scope, 'rooms:read');
});

test('bridge calls: an API pointer and a console command', () => {
  const result = scan("const id = await valuApi.getApi('network').run('id');\nvaluApi.runConsoleCommand('room open 1');");
  assert.deepEqual(result.findings.map((f) => [f.call, f.scope, f.kind, f.line]), [['network.id', 'networks:read', 'bridge', 1]]);
  assert.deepEqual(result.bridge.map((f) => [f.call, f.line]), [['console:room open 1', 2]]);
  assert.deepEqual(scan("valuApi.getApi('crypto').run('setSeed')").bridge.map((f) => f.call), ['crypto.setSeed']);
  assert.deepEqual(scan("const net = await valuApi.getApi('network');").bridge.map((f) => f.call), ['network']);
});

test('scopes an app asks for by name count, even with no call beside them', () => {
  const result = scan("await valu.auth.signIn({ scopes: ['rooms:read'] });\nvalu.auth.requestConsent(['events:read']);");
  assert.deepEqual(result.findings.map((f) => [f.kind, f.scope, f.line]), [['asked', 'rooms:read', 1], ['asked', 'events:read', 2]]);
  assert.deepEqual(result.scopes, ['events:read', 'rooms:read']);
});

test('calls whose name is decided at run time are listed as unreadable', () => {
  const result = scan('valu.call(name);\nnew Intent(svc, act);\nvalu[svc][fn]();');
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.unresolved.map((u) => [u.line, u.text]), [
    [1, 'valu.call(name);'],
    [2, 'new Intent(svc, act);'],
    [3, 'valu[svc][fn]();'],
  ]);
});

test('calls inside comments are not calls', () => {
  const text = [
    '// valu.Rooms.createRoomFromTemplate(x)',
    '/* valu.Rooms.inviteToProp(',
    '   still a comment */ const url = "https://example.com"; // valu.Users.current()',
    'valu.Users.current();',
  ].join('\n');
  const result = scan(text);
  assert.deepEqual(result.findings.map((f) => [f.call, f.line]), [['Users.current', 4]]);
});

test('a regex literal is not a comment, so the calls after it are read', () => {
  const text = "s.replace(/\\/*$/, '');\nvalu.Rooms.searchMyRooms();\nvalu.VerusWallet.transfer();";
  assert.deepEqual(scan(text).scopes, ['rooms:read', 'veruswallet:write']);
  assert.deepEqual(scan("if (/^\\/\\//.test(x)) valu.Users.current();").scopes, ['users:read']);
  assert.deepEqual(scan("const r = /`/; const t = `a // b`; valu.Users.current();").scopes, ['users:read']);
});

test('an unterminated block comment hides nothing', () => {
  assert.deepEqual(scan('/* never closed\nvalu.Users.current();').scopes, ['users:read']);
});

test('any receiver chain, optional chaining, and a call inside a call', () => {
  assert.equal(only(scan('this.valu.Rooms.searchMyRooms()')).scope, 'rooms:read');
  assert.equal(only(scan('window.valu.data.Users.current()')).scope, 'users:read');
  assert.equal(only(scan('valu?.Rooms?.searchMyRooms()')).scope, 'rooms:read');
  assert.deepEqual(scan('valu.Rooms.getRoom(valu.Users.current())').scopes, ['rooms:read', 'users:read']);
});

test('text inside a string is not a call', () => {
  assert.deepEqual(scan('const help = "Try valu.Rooms.searchMyRooms( to list rooms";').findings, []);
  assert.deepEqual(scan('const t = `Use valu.VerusWallet.transfer() to pay`;').findings, []);
});

test('code inside a template expression is still code', () => {
  assert.equal(only(scan('const t = `${await valu.Users.current()}`;')).scope, 'users:read');
});

test('in an HTML page only the scripts are code', () => {
  const html = [
    '<p>Call valu.VerusWallet.transfer() to pay</p>',
    '<!-- old: valu.VerusWallet.transfer() -->',
    '<script type="module">',
    '  valu.Users.current();',
    '</script>',
  ].join('\n');
  const result = scan(html, 'index.html');
  assert.deepEqual(result.findings.map((f) => [f.scope, f.line]), [['users:read', 4]]);
});

test("an app's own module with a service's name is not valu-api", () => {
  assert.deepEqual(scan("import * as Http from './http';\nHttp.post(x);\nUsers.get(1);").findings, []);
});

test('more names decided at run time are listed as unreadable', () => {
  const result = scan('valu.Rooms[method]();\nvalu.auth.requestConsent(scopes);\nvalu.auth.signIn({ scopes: SCOPES });');
  assert.deepEqual(result.unresolved.map((u) => u.line), [1, 2, 3]);
});

test('value, values and valuation are not the valu-api object', () => {
  const text = [
    'const first = e.target.value[0];',
    'const total = values[i] + 1;',
    "setValue(form.values['title']);",
    'valuation.call(this);',
  ].join('\n');
  assert.deepEqual(scan(text).unresolved, []);
});

test('the valu-api object under its usual names still counts', () => {
  const result = scan('valu.call(name);\nvaluApp.Rooms[method]();\nvaluApi.invoke(fn);\nvalu_app.call(x);');
  assert.deepEqual(result.unresolved.map((u) => u.line), [1, 2, 3, 4]);
});

test('each finding keeps its own file and line', () => {
  const result = detectScopes([
    { path: 'a.js', text: '\n\nvalu.Rooms.getRoom({})' },
    { path: 'b.jsx', text: 'valu.Events.createMeeting({})' },
  ]);
  assert.deepEqual(result.findings.map((f) => [f.file, f.line, f.scope]), [
    ['a.js', 3, 'rooms:read'],
    ['b.jsx', 1, 'events:write'],
  ]);
  assert.deepEqual(result.scopes, ['events:write', 'rooms:read']);
});

test('the same call five times is kept three times, and says it was cut', () => {
  const text = Array.from({ length: 5 }, () => 'valu.Users.current();').join('\n');
  const result = scan(text);
  assert.equal(result.findings.length, 3);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.scopes, ['users:read']);
});

test('nothing to find is an empty answer', () => {
  assert.deepEqual(detectScopes([]), { scopes: [], findings: [], bridge: [], unresolved: [], truncated: false });
});

// ---------------------------------------------------------------------------
// Helpers (2026-10-30): the form the Commerce skill teaches, read at its call sites.
// ---------------------------------------------------------------------------

const APP = [
  { path: 'src/valu/valu.js', text: [
    "import { Intent } from '@arkeytyp/valu-api';",
    'export async function callService(service, action, params = {}) {',
    '  return (await getValu()).callService(new Intent(service, action, params));',
    '}',
  ].join('\n') },
  { path: 'src/state/store.jsx', text: [
    "import { callService } from '../valu/valu.js';",
    'const commerce = (action, params = {}) => callService(`Commerce`, action, params);',
    "export const listProducts = (query) => commerce('list-products', query);",
    "export const addToCart = (productId) => commerce('add-to-cart', { productId });",
    "export const openCart = () => commerce('open-cart', { popup: true });",
  ].join('\n') },
  { path: 'src/components/AppHeader.jsx', text: [
    "import { callService } from '../valu/valu.js';",
    "const p = (e) => callService('Application', e).catch(() => {});",
    'const m = (e) => { close(); p(e); };',
    "<li onClick={() => m('expand-application')}/>",
  ].join('\n') },
];

test('a helper around new Intent(service, action) is read at its call sites, through the levels', () => {
  const result = detectScopes(APP);
  assert.deepEqual(result.findings.map((f) => [f.call, f.scope, f.kind, f.file, f.line, f.via]), [
    ['Application.expand-application', 'ui:open', 'intent', 'src/components/AppHeader.jsx', 4, 'm'],
    ['Commerce.list-products', 'commerce:read', 'intent', 'src/state/store.jsx', 3, 'commerce'],
    ['Commerce.add-to-cart', 'commerce:write', 'intent', 'src/state/store.jsx', 4, 'commerce'],
    ['Commerce.open-cart', 'ui:open', 'intent', 'src/state/store.jsx', 5, 'commerce'],
  ]);
  assert.deepEqual(result.scopes, ['commerce:read', 'commerce:write', 'ui:open']);
  assert.deepEqual(result.unresolved, [], 'the helpers themselves are no longer unreadable');
});

test('a helper nobody calls keeps its own line as unreadable', () => {
  const result = detectScopes([APP[0]]);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.unresolved.map((u) => [u.file, u.line]), [['src/valu/valu.js', 3]]);
});

test('a call site that passes a value on is unreadable at its own line, and the literal ones still count', () => {
  const result = detectScopes([APP[0], { path: 'src/x.js', text: [
    "import { callService } from './valu/valu.js';",
    "callService('Commerce', 'get-cart');",
    'callService(svc, chosen);',
  ].join('\n') }]);
  assert.deepEqual(result.findings.map((f) => [f.call, f.line]), [['Commerce.get-cart', 2]]);
  assert.deepEqual(result.unresolved.map((u) => [u.file, u.line]), [['src/x.js', 3]]);
});

test('a helper around valu.call(name) resolves its literal call sites to catalogue functions', () => {
  const result = detectScopes([{ path: 'src/api.js', text: [
    'const run = (name, params) => valu.call(name, params);',
    "run('Rooms.search-my-rooms', {});",
    "run('Users.current');",
    "run('Nope.nothing');",
  ].join('\n') }]);
  assert.deepEqual(result.findings.map((f) => [f.call, f.scope, f.line, f.via]), [
    ['Rooms.search-my-rooms', 'rooms:read', 2, 'run'],
    ['Users.current', 'users:read', 3, 'run'],
  ]);
  assert.deepEqual(result.unresolved.map((u) => u.line), [4]);
});

test('a class method and a plain function are helpers too; a call with the name computed inside is not', () => {
  const result = detectScopes([{ path: 'src/store.js', text: [
    'class Store {',
    '  async commerce(action, params) { return this.valu.callService(new Intent("Commerce", action, params)); }',
    "  cart() { return this.commerce('get-cart'); }",
    '}',
    'function byName(action) { return valu.callService(new Intent("Rooms", `${prefix}-${action}`)); }',
  ].join('\n') }]);
  assert.deepEqual(result.findings.map((f) => [f.call, f.line, f.via]), [['Commerce.get-cart', 3, 'commerce']]);
  assert.deepEqual(result.unresolved.map((u) => u.line), [5]);
});

test('a typed intent on the tree is read like any function', () => {
  const result = scan("await valu.Commerce.getCart();\nvalu.Commerce.openCart({ popup: true });\nvalu.Application.expandApplication();");
  assert.deepEqual(result.findings.map((f) => [f.call, f.scope, f.kind, f.line]), [
    ['Commerce.get-cart', 'commerce:read', 'function', 1],
    ['Commerce.open-cart', 'ui:open', 'function', 2],
    ['Application.expand-application', 'ui:open', 'function', 3],
  ]);
});
