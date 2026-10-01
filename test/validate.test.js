import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateParams, validationAck } from '../src/services/validate.js';
import { findDescriptor, SERVICE_DESCRIPTORS } from '../src/services/descriptors.js';
import { ERROR_CODES } from '../src/Errors.js';

const events = findDescriptor('Events.list-events');
const createMeeting = findDescriptor('Events.create-meeting');
const connectionRequests = findDescriptor('Users.list-connection-requests');

test('optional-only params: an empty call is valid', () => {
  assert.deepEqual(validateParams(events, {}), { ok: true, errors: [] });
  assert.deepEqual(validateParams(events), { ok: true, errors: [] });
});

test('a missing required param is reported by name and type', () => {
  const { ok, errors } = validateParams(createMeeting, { title: 'Standup' });
  assert.equal(ok, false);
  assert.deepEqual(errors, ['missing required param "type" (string)']);
});

test('null counts as missing, not as a value', () => {
  const { errors } = validateParams(createMeeting, { title: 'a', type: null });
  assert.deepEqual(errors, ['missing required param "type" (string)']);
});

test('types are checked', () => {
  const { errors } = validateParams(createMeeting, {
    title: 1, type: 'room', participants: ['a', 2], recurringWeekly: 'yes',
  });
  assert.deepEqual(errors, [
    'param "title" must be string',
    'param "participants" must be string[]',
    'param "recurringWeekly" must be boolean',
  ]);
});

test('NaN is not a number', () => {
  const rooms = findDescriptor('Rooms.search-rooms');
  const { errors } = validateParams(rooms, { size: Number.NaN });
  assert.deepEqual(errors, ['param "size" must be number']);
});

test('an enum param only accepts its options', () => {
  assert.equal(validateParams(connectionRequests, { category: 'received' }).ok, true);
  assert.deepEqual(validateParams(connectionRequests, { category: 'inbound' }).errors,
    ['param "category" must be one of: received, sent']);
});

test('an unknown param is refused, not dropped', () => {
  const { ok, errors } = validateParams(events, { rnage: 'week' });
  assert.equal(ok, false);
  assert.match(errors[0], /unknown param "rnage"/);
  assert.match(errors[0], /accepts: range, startDate, filter, id/);
});

test('params must be an object', () => {
  assert.deepEqual(validateParams(events, 'week'), { ok: false, errors: ['params must be an object'] });
  assert.deepEqual(validateParams(events, []), { ok: false, errors: ['params must be an object'] });
});

test('validationAck carries the first error in the message and all of them in the description', () => {
  const ack = validationAck(createMeeting, { participants: 'someone' });

  assert.equal(ack.error.code, ERROR_CODES.INVALID_PARAMS);
  assert.match(ack.error.message, /^Events\.create-meeting: missing required param "title"/);
  assert.match(ack.error.description, /participants" must be string\[\]/);
  assert.equal(validationAck(createMeeting, { title: 'a', type: 'room' }), null);
});

test('every declared param type has a check', () => {
  const types = new Set();
  for (const d of SERVICE_DESCRIPTORS) {
    for (const p of [...d.params.required, ...d.params.optional]) types.add(p.type);
  }
  // A type with no check silently accepts anything — catch a new one on sight.
  assert.deepEqual([...types].sort(),
    ['FileList', 'array', 'boolean', 'number', 'object', 'object[]', 'string', 'string[]']);
});
