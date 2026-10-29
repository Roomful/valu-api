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

test('intents: Commerce, the identity token, and one with no scope', () => {
  assert.deepEqual(only(scan("valu.callService(new Intent('Commerce', 'get-cart'))")), {
    scope: 'commerce:read', call: 'Commerce.get-cart', kind: 'intent', file: 'src/app.ts', line: 1,
  });
  assert.equal(only(scan("new Intent('Application','get-identity-token')")).scope, 'application:identity');
  assert.equal(only(scan("new Intent('commerce', 'get-cart')")).scope, 'commerce:read');
  const result = scan("new Intent('textchat', 'open-channel', {userId})");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.bridge, [{
    scope: null, call: 'textchat.open-channel', kind: 'bridge', file: 'src/app.ts', line: 1,
  }]);
});

test('an intent that names a catalogue function needs that function\'s scope', () => {
  assert.equal(only(scan("new Intent('Rooms', 'search-my-rooms')")).scope, 'rooms:read');
});

test('bridge calls: an API pointer and a console command', () => {
  const result = scan("const id = await valuApi.getApi('network').run('id');\nvaluApi.runConsoleCommand('room open 1');");
  assert.deepEqual(result.bridge.map((f) => [f.call, f.line]), [['network.id', 1], ['console:room open 1', 2]]);
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
