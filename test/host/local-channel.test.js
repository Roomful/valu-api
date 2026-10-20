// ===========================================================================
// `local` functions without a socket.
//
// In dedicated mode the app page runs the eight `local` functions (Http, Time,
// the resource-URL builders) itself, through a SocketTransport that holds no
// socket — the Roomful connection lives in the host iframe. Everything else
// still needs the socket, and says so.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../../src/services/impl/index.js';
import { SocketTransport } from '../../src/transport/SocketTransport.js';
import { findDescriptor } from '../../src/services/descriptors.js';
import { fakeFetch } from '../helpers/fakes.js';

const socketless = (extra = {}) => new SocketTransport({
  socket: null,
  fetchImpl: fakeFetch(),
  config: { webBase: 'https://app.example.test', apiGate: 'https://api.example.test' },
  ...extra,
});

test('local functions run without a socket', async () => {
  const transport = socketless();
  assert.equal(transport.socket, null);

  const time = await transport.callService(findDescriptor('Time.get-local-time'), {});
  assert.equal(time.error, undefined);
  assert.equal(typeof time.data.iso, 'string');

  const url = await transport.callService(
    findDescriptor('Resources.generate-public-url'), { resourceId: 'res-1' },
  );
  assert.equal(url.error, undefined);
  assert.match(JSON.stringify(url.data), /app\.example\.test/);
});

test('a local Http function uses the injected fetch, not a socket', async () => {
  const fetchImpl = fakeFetch();
  const transport = socketless({ fetchImpl });

  const ack = await transport.callService(
    findDescriptor('Http.ping'), { url: 'https://example.test/health' },
  );

  assert.equal(ack.error, undefined);
  assert.equal(fetchImpl.puts.length, 1, 'the request went through the injected fetch');
});

test('roomful and app-state functions still answer 503 without a socket', async () => {
  const transport = socketless();

  for (const key of ['Users.current', 'VerusWallet.get-balance']) {
    const descriptor = findDescriptor(key);
    assert.notEqual(descriptor.channel, 'local', `${key} is not a local function`);
    const ack = await transport.callService(descriptor, {});
    assert.equal(ack.error.code, 503, key);
    assert.match(ack.error.message, new RegExp(`${key}: no socket`));
  }
});

test('a transport built without a socket argument is still an error', () => {
  assert.throws(() => new SocketTransport({}), /needs a ValuSocket/);
});
