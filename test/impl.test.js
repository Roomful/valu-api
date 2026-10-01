// The pure logic behind the functions, tested directly.
//
// The conformance table exercises all of this through a socket, which is the
// point of it — but a distribution rule or a bundle-price translation is
// easier to pin down as itself, and a failure here says which RULE broke
// rather than which function noticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planDistribution, groupProps, propDisplayName, propGroupId, templateGroupCount,
} from '../src/services/impl/propGroups.js';
import { sanitizeButtons, sanitizeCustomParams } from '../src/services/impl/TextChat.js';
import { computeDateRange, hexToRgba, rgbaToHex, parseOccurrence } from '../src/services/impl/Events.js';
import { normalizeIcon } from '../src/services/impl/Developer.js';
import { resolveBelonging, applicationStorageBelonging } from '../src/services/impl/belonging.js';
import { getLocalTime } from '../src/services/impl/Time.js';
import { readFile, toFileArray, uploadResources, MAX_UPLOAD_BYTES } from '../src/upload/ResourceUpload.js';
import { resolveConfig } from '../src/Config.js';
import { ERROR_CODES } from '../src/Errors.js';
import { Responder, FakeRoomfulConnection, fakeFetch } from './helpers/fakes.js';
import { NodeSocketAdapter } from '../src/socket/NodeSocketAdapter.js';

// --- distribution ----------------------------------------------------------

test('spread gives contiguous, order-preserving shares', () => {
  const pool = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const plan = planDistribution(pool, ['1', '2', '3', '4', '5', '6', '7'], 'spread');
  // 7 over 3 is 3/2/2 — the first `remainder` props take the extra, so the
  // story reads in order. Round-robin would shuffle it, which is why it is
  // deliberately not offered.
  assert.deepEqual(plan.map((p) => p.resourceIds), [['1', '2', '3'], ['4', '5'], ['6', '7']]);
});

test('fewer resources than props leaves the trailing props untouched', () => {
  const plan = planDistribution([{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['1'], 'spread');
  assert.equal(plan.length, 1);
  assert.equal(plan[0].prop.id, 'a');
});

test('stack is one slideshow, replicate is everything everywhere', () => {
  const pool = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(planDistribution(pool, ['1', '2'], 'stack'), [{ prop: pool[0], resourceIds: ['1', '2'] }]);
  assert.deepEqual(planDistribution(pool, ['1', '2'], 'replicate').map((p) => p.resourceIds),
    [['1', '2'], ['1', '2']]);
});

test('an empty pool or an empty list plans nothing', () => {
  assert.deepEqual(planDistribution([], ['1']), []);
  assert.deepEqual(planDistribution([{ id: 'a' }], []), []);
});

// --- prop grouping ---------------------------------------------------------

test('a group id is its tags, normalized and sorted', () => {
  assert.equal(propGroupId(['Floor 0', 'team']), 'floor-0+team');
  assert.equal(propGroupId(['team', 'Floor 0']), 'floor-0+team', 'order-independent');
  assert.equal(propGroupId([]), null, 'no tags is no group');
});

test('an untagged prop belongs to no group and is skipped', () => {
  const groups = groupProps([
    { id: 'p-1', tags: ['team'], navIndex: 0 },
    { id: 'p-2', tags: [], navIndex: 1 },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].props.map((p) => p.id), ['p-1']);
});

test('a prop is named by what it SHOWS, and a template stub does not count', () => {
  assert.equal(propDisplayName({ title: 'Signed' }), 'Signed');
  assert.equal(propDisplayName({ assetTitle: 'Frame', content: [{ title: 'photo.jpg' }] }), 'photo.jpg');
  // "slide-bg-04.jpg" READS like a real name, and would be relayed as one —
  // an untouched frame must fall through to its asset name instead.
  assert.equal(propDisplayName({ assetTitle: 'Frame', content: [{ title: 'slide-bg-04.jpg', fromTemplate: true }] }), 'Frame');
  assert.equal(propDisplayName({ id: 'p-1' }), 'p-1', 'the id tells the model the frame is empty');
});

test('a template declares its group count in a tag, spelled several ways', () => {
  assert.equal(templateGroupCount(['prop-groups_5']), 5);
  assert.equal(templateGroupCount(['3-groups']), 3);
  assert.equal(templateGroupCount(['community']), null);
});

// --- text chat -------------------------------------------------------------

test('a JSON-stringified buttons array is parsed, and said so', () => {
  const { buttons, warnings } = sanitizeButtons(JSON.stringify([
    { text: 'Go', intent: { applicationId: 'rooms', action: 'open' } },
  ]));
  assert.equal(buttons.length, 1);
  assert.match(warnings[0], /JSON string/);
});

test('a button with no usable intent is dropped, and named', () => {
  const { buttons, warnings } = sanitizeButtons([{ text: 'Go' }, { text: '' }, 'nope']);
  assert.deepEqual(buttons, []);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /invalid "intent"/);
});

test('only whitelisted customParams survive', () => {
  assert.deepEqual(sanitizeCustomParams({ 'open-thread': true, runId: 'forged' }), { 'open-thread': true });
  assert.equal(sanitizeCustomParams({ runId: 'forged' }), null);
  assert.equal(sanitizeCustomParams('nope'), null);
});

// --- events ----------------------------------------------------------------

test('a colour survives the round trip the wire forces on it', () => {
  assert.deepEqual(hexToRgba('#4299f5'), { r: 0x42 / 255, g: 0x99 / 255, b: 0xf5 / 255, a: 1 });
  assert.equal(rgbaToHex(hexToRgba('#4299f5')), '#4299f5');
  assert.equal(rgbaToHex(null), null);
});

test('a range is a whole local period, inclusive at both ends', () => {
  const anchor = new Date(2026, 5, 15, 13, 30);
  const month = computeDateRange(anchor, 'month');
  assert.equal(month.start.getDate(), 1);
  assert.equal(month.start.getHours(), 0);
  assert.equal(month.end.getMonth(), 5);
  assert.equal(month.end.getDate(), 30);
  assert.equal(month.end.getHours(), 23);

  const week = computeDateRange(anchor, 'week');
  assert.equal(week.start.getDay(), 0, 'weeks start on Sunday, as the calendar draws them');
  assert.equal(Math.round((week.end - week.start) / 86_400_000), 7);

  const day = computeDateRange(anchor, 'day');
  assert.equal(day.start.getDate(), day.end.getDate());
});

test('an occurrence id is built from the field the backend actually sent', () => {
  // Go serializes untagged fields in PascalCase, so the same value arrives
  // under two spellings — and an id built from the wrong one matches nothing.
  assert.equal(parseOccurrence({ meetingId: 'm', OriginalStartDate: 'D', startDate: 'S' }).id, 'm_D');
  assert.equal(parseOccurrence({ meetingId: 'm', startDate: 'S' }).id, 'm_S');
  assert.equal(parseOccurrence({ meetingId: 'm', occurrenceId: 'occ-1' }).id, 'occ-1');
  assert.equal(parseOccurrence({ seriesId: 's', IsCancelled: true, startDate: 'S' }).isCanceled, true);
});

// --- developer / belonging / time -------------------------------------------

test('an icon is normalized or dropped, never half-stamped', () => {
  assert.equal(normalizeIcon('fa-rocket'), 'fa-light fa-rocket');
  assert.equal(normalizeIcon('fa-solid fa-rocket'), 'fa-solid fa-rocket');
  assert.equal(normalizeIcon('https://example.com/icon.png'), '');
  assert.equal(normalizeIcon('fa-solid'), '', 'a weight with no icon is not an icon');
});

test('the belonging is decided by which ids the caller passed', () => {
  const caller = { applicationId: 'app-1', userId: 'u-1' };
  assert.equal(resolveBelonging({ roomId: 'r', propId: 'p' }, caller), 'room:r/p');
  assert.equal(resolveBelonging({ roomId: 'r' }, caller), 'roomSortingTable:r');
  assert.equal(resolveBelonging({ directoryId: 'd' }, caller), 'directory:d');
  assert.equal(resolveBelonging({ communityId: 'c' }, caller), 'community:c');
  assert.equal(resolveBelonging({}, caller), applicationStorageBelonging('app-1', 'u-1'));
});

test('local time describes one instant several ways', () => {
  const now = new Date('2026-06-15T12:34:56.789Z');
  const time = getLocalTime({ now });
  assert.equal(time.utcIso, '2026-06-15T12:34:56.789Z');
  assert.match(time.iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  assert.equal(new Date(time.iso).getTime(), now.getTime(), 'the same moment, written locally');
});

// --- upload ----------------------------------------------------------------

test('a file is anything that can name itself and produce bytes', async () => {
  assert.deepEqual(await readFile({ name: 'a.txt', contentType: 'text/plain', bytes: new Uint8Array([1]) }),
    { fileName: 'a.txt', contentType: 'text/plain', bytes: new Uint8Array([1]) });

  const blobLike = { name: 'b.png', type: 'image/png', arrayBuffer: async () => new Uint8Array([1, 2]).buffer };
  const read = await readFile(blobLike);
  assert.equal(read.contentType, 'image/png');
  assert.equal(read.bytes.length, 2);

  await assert.rejects(() => readFile({ name: 'empty', bytes: new Uint8Array() }), /is empty/);
  await assert.rejects(() => readFile({ name: 'no bytes' }), /carries no bytes/);
  await assert.rejects(
    () => readFile({ name: 'huge', bytes: { length: MAX_UPLOAD_BYTES + 1, BYTES_PER_ELEMENT: 1 } }),
    /over the/,
  );
});

test('a FileList, an array and a lone file all become an array', () => {
  assert.equal(toFileArray(null).length, 0);
  assert.equal(toFileArray([1, 2]).length, 2);
  assert.equal(toFileArray({ length: 2, 0: 'a', 1: 'b' }).length, 2);
  assert.equal(toFileArray({ name: 'one' }).length, 1);
});

test('one bad file does not lose the good ones', async () => {
  const responder = new Responder({
    'resource:create': { data: { resource: { id: 'res-1' } } },
    'resource:getUploadLink': { data: { url: 'https://bucket/1' } },
    'resource:completeUploadLink': { data: {} },
  });
  const socket = new NodeSocketAdapter({ connection: new FakeRoomfulConnection(responder) });

  const { resolved, failed } = await uploadResources({
    socket,
    files: [{ name: 'good.png', bytes: new Uint8Array([1]) }, { name: 'bad.png' }],
    belonging: 'app:a:userSortingTable:u',
    fetchImpl: fakeFetch(),
  });

  assert.deepEqual(resolved, [{ id: 'res-1', fileName: 'good.png' }]);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /carries no bytes/);
});

test('a bucket that refuses the bytes is reported, not swallowed', async () => {
  const responder = new Responder({
    'resource:create': { data: { resource: { id: 'res-1' } } },
    'resource:getUploadLink': { data: { url: 'https://bucket/1' } },
  });
  const socket = new NodeSocketAdapter({ connection: new FakeRoomfulConnection(responder) });

  const { resolved, failed } = await uploadResources({
    socket,
    files: [{ name: 'a.png', bytes: new Uint8Array([1]) }],
    belonging: 'b',
    fetchImpl: fakeFetch({ status: 403 }),
  });

  assert.deepEqual(resolved, []);
  assert.match(failed[0].error, /HTTP 403/);
});

// --- config ----------------------------------------------------------------

test('the resource origins are configurable and trailing-slash safe', () => {
  const config = resolveConfig({ webBase: 'https://app.test/', apiGate: 'https://api.test//' });
  assert.equal(config.webBase, 'https://app.test');
  assert.equal(config.apiGate, 'https://api.test');
  assert.ok(resolveConfig().apiGate.startsWith('https://'), 'a default that is at least well-formed');
});
