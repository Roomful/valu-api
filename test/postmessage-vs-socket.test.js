// docs/postmessage-vs-socket.md is the one doc in here that is NOT generated, because
// it is an explanation rather than a table — and it quotes a dozen numbers and
// five function names out of the catalogue. Prose with numbers in it rots
// silently, so every number and name it asserts is checked against the thing it
// describes. A doc that has stopped being true fails the build instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SERVICE_DESCRIPTORS } from '../src/services/descriptors.js';
import { FRAME_COMMANDS } from '../src/frame/FrameCommands.js';
import { pointerSummary } from '../scripts/apiPointers.js';

const doc = readFileSync(new URL('../docs/postmessage-vs-socket.md', import.meta.url), 'utf8');

const countBy = (channel) => SERVICE_DESCRIPTORS.filter((d) => d.channel === channel).length;

test('the channel counts in the table match the catalogue', () => {
  for (const channel of ['roomful', 'valuguru', 'local', 'app-state', 'postmessage']) {
    const row = new RegExp(`^\\| \`${channel}\` — (\\d+) \\|`, 'm').exec(doc);
    assert.ok(row, `no table row for channel ${channel}`);
    assert.equal(Number(row[1]), countBy(channel), `${channel} row`);
  }
});

test('the renaming table still names the renamed identifiers', () => {
  // The table is what a reader of the old docs comes here for. Each row must
  // name the identifier that actually exists now, not the one it replaced.
  for (const name of [
    "`binding: 'postmessage'`",
    "`channel: 'app-state'`",
    'SocketTransport({ appState })',
    'transport.supportsPostMessage',
  ]) {
    assert.ok(doc.includes(name), `the renaming table no longer names ${name}`);
  }
  // …and must not quietly keep using the word it replaced.
  const table = doc.slice(doc.indexOf('## This used to be called'), doc.indexOf('## Where each kind'));
  const body = doc.replace(table, '');
  assert.equal(
    /\bhost\b/i.test(body.replace(/hostname/gi, '')),
    false,
    'the word "host" is back somewhere outside the renaming table',
  );
});

test('"all 92 are available" is the declared total', () => {
  const total = /all (\d+) are available/.exec(doc);
  assert.equal(Number(total[1]), SERVICE_DESCRIPTORS.length);
});

test('the summary table counts every channel and the pointer surface', () => {
  const row = (label) => {
    const m = new RegExp(`^\\| ${label} \\| (\\d+) \\|`, 'm').exec(doc);
    assert.ok(m, `no summary row for "${label}"`);
    return Number(m[1]);
  };
  assert.equal(row('declared intents'), SERVICE_DESCRIPTORS.length);
  assert.equal(row('on the Roomful socket'), countBy('roomful'));
  assert.equal(row('on the Valu Guru socket'), countBy('valuguru'));
  assert.equal(row('local to the SDK'), countBy('local'));
  assert.equal(row('application state'), countBy('app-state'));
  assert.equal(row('postMessage-bound \\(frame commands\\)'), countBy('postmessage'));
  assert.equal(row('API pointer functions'), pointerSummary().functions);
});

test('the pointer-only claim is the measured one', () => {
  const claim = /(\d+) of its (\d+)\n?\s*functions have no declared intent/.exec(doc);
  assert.ok(claim, 'the pointer-only sentence has changed shape');
  const { only, functions } = pointerSummary();
  assert.equal(Number(claim[1]), only);
  assert.equal(Number(claim[2]), functions);
});

test('the five app-state functions are named, and only those', () => {
  const section = doc.slice(doc.indexOf('## Why the 5 are the confusing ones'));
  const named = [...section.matchAll(/`([A-Z]\w+\.[a-z-]+)`/g)].map((m) => m[1]);
  const appStateKeys = SERVICE_DESCRIPTORS.filter((d) => d.channel === 'app-state').map((d) => d.key);
  for (const key of appStateKeys) assert.ok(named.includes(key), `${key} is not named in the section`);
  // Anything else named there must not be app-state, or the list has drifted.
  for (const key of new Set(named)) {
    if (appStateKeys.includes(key)) continue;
    const descriptor = SERVICE_DESCRIPTORS.find((d) => d.key === key);
    assert.ok(!descriptor || descriptor.channel !== 'app-state', `${key} is app-state but listed as an aside`);
  }
});

test('the frame-command examples are postMessage-bound functions', () => {
  // The doc shows two refusals and two frame methods by name. If one of them
  // stops being postMessage-bound, the example stops making its point.
  for (const key of ['DataProvider.pick-single']) {
    assert.ok(doc.includes(key), `${key} is no longer the example`);
    assert.ok(FRAME_COMMANDS.includes(key), `${key} is not a frame command`);
  }
});
