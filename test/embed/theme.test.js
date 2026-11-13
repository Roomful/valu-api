import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createValuApp} from '../../src/ValuApi.js';
import {createTheme} from '../../src/Theme.js';
import {FakeWindowPair, fakeClock} from '../helpers/hostFakes.js';

const HOST = 'https://live.valuverse.io';
const APP = 'https://app.example';
const settle = () => new Promise(resolve => setImmediate(resolve));
const media = () => {
  const listeners = new Set();
  return {matches: false, listeners,
    addEventListener: (_, handler) => listeners.add(handler),
    removeEventListener: (_, handler) => listeners.delete(handler),
    change(value) { this.matches = value; for (const handler of listeners) handler(); },
  };
};
async function framed(t, theme = {scheme: 'dark', toggle: true}) {
  const {app: parent, host: frame} = FakeWindowPair({appOrigin: HOST, hostOrigin: APP});
  const clock = fakeClock();
  const query = media();
  frame.matchMedia = () => query;
  const valu = await createValuApp({window: frame, mode: 'embedded', setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout});
  t.after(() => valu.close());
  const send = (name, message, requestId) => frame.postMessage({target: 'valuApi', name, message, requestId}, APP);
  send('api:ready', {applicationId: 'app', theme});
  await valu.ready;
  return {valu, frame, parent, send, clock, query};
}

test('initial host scheme and live pushes win over system changes; spoofed and invalid pushes do not', async t => {
  const {valu, frame, parent, send, query} = await framed(t);
  assert.equal(valu.theme.scheme, 'dark');
  const changes = [];
  const off = valu.theme.on('change', value => changes.push(value));
  send('api:trigger', {action: 'color-scheme', data: {scheme: 'light'}});
  query.change(true);
  frame.dispatch({data: {target: 'valuApi', name: 'api:color-scheme', message: {scheme: 'dark'}}, origin: HOST, source: {}});
  frame.dispatch({data: {target: 'valuApi', name: 'api:color-scheme', message: {scheme: 'dark'}}, origin: 'https://wrong.example', source: parent});
  send('api:color-scheme', {scheme: 'invalid'});
  assert.equal(valu.theme.scheme, 'light');
  assert.deepEqual(changes, ['light']);
  off();
  send('api:color-scheme', {scheme: 'dark'});
  assert.deepEqual(changes, ['light']);
  await valu.close();
  assert.equal(query.listeners.size, 0);
  await assert.rejects(valu.theme.toggle(), {code: 'closed'});
});

test('toggle requests are coalesced and host permission refusals are surfaced', async t => {
  const {valu, parent, send} = await framed(t);
  const first = valu.theme.toggle();
  const second = valu.theme.toggle();
  await settle();
  const calls = parent.posted.filter(post => post.data.name === 'api:theme');
  assert.equal(calls.length, 1);
  send('api:theme-completed', {error: {code: 'permission_not_declared'}}, calls[0].data.message.requestId);
  await assert.rejects(first, {code: 'permission_not_declared'});
  await assert.rejects(second, {code: 'permission_not_declared'});
  assert.equal(valu.theme.scheme, 'dark');
});

test('a toggle answer updates the scheme, while a newer push takes precedence', async t => {
  const {valu, parent, send} = await framed(t);
  const first = valu.theme.toggle();
  await settle();
  send('api:theme-completed', {scheme: 'light'}, parent.posted.at(-1).data.message.requestId);
  assert.equal(await first, 'light');
  const second = valu.theme.toggle();
  await settle();
  send('api:trigger', {action: 'color-scheme', data: {scheme: 'light'}});
  send('api:theme-completed', {scheme: 'dark'}, parent.posted.at(-1).data.message.requestId);
  assert.equal(await second, 'light');
});

test('older hosts refuse immediately and unanswered toggles expire', async t => {
  const old = await framed(t, undefined);
  // Override the default used by the helper with an explicitly absent capability.
  old.send('api:ready', {applicationId: 'app'});
  await assert.rejects(old.valu.theme.toggle(), {code: 'not_available'});
  const current = await framed(t);
  const pending = current.valu.theme.toggle();
  const rejected = assert.rejects(pending, {code: 'timeout'});
  await settle();
  current.clock.tick(10000);
  await rejected;
});

test('dedicated mode follows the system until a local choice and releases listeners on close', async () => {
  const query = media();
  const theme = createTheme({mode: 'dedicated', win: {matchMedia: () => query}, ready: Promise.resolve()});
  assert.equal(theme.api.scheme, 'light');
  query.change(true);
  assert.equal(theme.api.scheme, 'dark');
  assert.equal(await theme.api.toggle(), 'light');
  query.change(true);
  assert.equal(theme.api.scheme, 'light');
  theme.close();
  assert.equal(query.listeners.size, 0);
});

test('a failed dedicated handshake releases the media-query listener', async () => {
  const {app: page, host} = FakeWindowPair({appOrigin: APP, hostOrigin: HOST});
  const {fakeDocumentFor} = await import('../helpers/hostFakes.js');
  const query = media();
  page.matchMedia = () => query;
  const clock = fakeClock();
  const pending = createValuApp({mode: 'dedicated', window: page, hostOrigin: HOST,
    document: fakeDocumentFor(host), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const failed = assert.rejects(pending, {code: 'host_unreachable'});
  await settle();
  clock.tick(10000);
  await failed;
  assert.equal(query.listeners.size, 0);
});
