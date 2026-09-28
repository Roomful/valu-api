import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_POLICY, DEFAULT_TIMEOUT_MS, forDescriptor, isRetriable, backoffFor, runWithPolicy,
} from '../src/CallPolicy.js';
import { findDescriptor } from '../src/services/descriptors.js';
import { ERROR_CODES, errorAck } from '../src/Errors.js';

test('the default timeout is the 30s both sides already use', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 30_000);
  assert.equal(forDescriptor().timeoutMs, 30_000);
});

test('reads retry twice, writes not at all', () => {
  assert.equal(forDescriptor(findDescriptor('Users.get')).retries, 2);
  assert.equal(forDescriptor(findDescriptor('Users.send-connection-request')).retries, 0);
});

test('a per-call override wins over the descriptor', () => {
  const policy = forDescriptor(findDescriptor('Users.get'), { retries: 0, timeoutMs: 5_000 });
  assert.equal(policy.retries, 0);
  assert.equal(policy.timeoutMs, 5_000);
});

test('only a timeout or a lost connection is retriable', () => {
  assert.equal(isRetriable(errorAck(ERROR_CODES.TIMEOUT, 'x')), true);
  assert.equal(isRetriable(errorAck(ERROR_CODES.DISCONNECTED, 'x')), true);
  assert.equal(isRetriable(errorAck(ERROR_CODES.FORBIDDEN, 'x')), false);
  assert.equal(isRetriable(errorAck(404, 'x')), false);
  assert.equal(isRetriable({ data: 1 }), false);
});

test('backoff doubles, is capped, and is jittered', () => {
  const mid = (n) => backoffFor(n, DEFAULT_POLICY, () => 0.5);
  assert.deepEqual([mid(1), mid(2), mid(3), mid(4), mid(9)], [250, 500, 1000, 2000, 4000]);

  assert.equal(backoffFor(1, DEFAULT_POLICY, () => 0), 200, '±20% jitter, low end');
  assert.equal(backoffFor(1, DEFAULT_POLICY, () => 1), 300, '±20% jitter, high end');
});

test('runWithPolicy stops at the first non-retriable answer', async () => {
  let attempts = 0;
  const slept = [];
  const ack = await runWithPolicy(
    async () => { attempts++; return errorAck(403, 'nope'); },
    forDescriptor({ mutates: false }),
    { sleep: async (ms) => slept.push(ms) },
  );

  assert.equal(attempts, 1);
  assert.deepEqual(slept, []);
  assert.equal(ack.error.code, 403);
});

test('runWithPolicy gives up after its retries and returns the last ack', async () => {
  let attempts = 0;
  const slept = [];
  const ack = await runWithPolicy(
    async () => { attempts++; return errorAck(ERROR_CODES.TIMEOUT, `try ${attempts}`); },
    forDescriptor({ mutates: false }),
    { sleep: async (ms) => slept.push(ms), random: () => 0.5 },
  );

  assert.equal(attempts, 3, 'one attempt plus two retries');
  assert.deepEqual(slept, [250, 500]);
  assert.equal(ack.error.message, 'try 3');
});

test('runWithPolicy passes the attempt number to the call', async () => {
  const seen = [];
  await runWithPolicy(
    async (attempt) => { seen.push(attempt); return attempt < 3 ? errorAck(ERROR_CODES.TIMEOUT, 'x') : { data: 1 }; },
    forDescriptor({ mutates: false }),
    { sleep: async () => {}, random: () => 0.5 },
  );
  assert.deepEqual(seen, [1, 2, 3]);
});
