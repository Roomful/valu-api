// ===========================================================================
// One function, two modes, one answer.
//
// Every case of the per-function table (test/conformance/functions.js) is run
// twice through the client an app builds, `createValuApp()`:
//
//   dedicated  HostTransport -> HostBridge -> MasterConnection, on readyIo(responder)
//   embedded   EmbeddedTransport -> PostMessageTransport -> createFrameServer
//              -> connectValuServices({ socket: webSocketService }), on a responder
//              with the same script
//
// and the two acks must be deep-equal, and the two wires (what reached the
// socket) the same. The functions the host refuses by design (the forbidden
// tier, the `app-state` channel) are where the modes differ on purpose: an
// embedded app needs no permissions. For those, the host's refusal is checked
// and the embedded answer is held to what a socket of its own answers.
//
// `Date` is frozen for each case: some functions stamp the wall clock into what
// they send (`updated`, `fileDate`), and two runs a millisecond apart are not
// a difference between the modes.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CASES, caseEnvironment } from '../conformance/functions.js';
import { hostRefuses, makeHostAppServices } from '../conformance/host-adapter.js';
import { makeEmbeddedServices } from '../conformance/embedded-adapter.js';
import { findDescriptor } from '../../src/services/descriptors.js';
import { BrowserSocketAdapter } from '../../src/socket/BrowserSocketAdapter.js';
import { ServiceClient } from '../../src/services/ServiceClient.js';
import { SocketTransport } from '../../src/transport/SocketTransport.js';
import { MSG } from '../../src/host/protocol.js';
import { FakeWebSocketService, Responder } from '../helpers/fakes.js';

const wire = (responder) => responder.calls.map(({ ns, data }) => ({ ns, data }));

/** One call of the case through `make`, on a responder of its own; the adapter is closed after. */
async function run(make, testCase) {
  const responder = new Responder(testCase.rpc ?? {});
  const environment = caseEnvironment(testCase);
  const made = await make(responder, environment);
  try {
    const ack = await made.services.call(testCase.key, testCase.params, { retries: 0 });
    return { ack, wire: wire(responder), puts: environment.fetchImpl.puts, posted: made.pair?.app.posted ?? [] };
  } finally {
    await made.close();
  }
}

/** The case over a socket of its own: what the embedded answer of a function the host refuses is held to. */
async function direct(testCase) {
  const responder = new Responder(testCase.rpc ?? {});
  const { appState, fetchImpl, config, now, applicationId, registry } = caseEnvironment(testCase);
  const transport = new SocketTransport({
    socket: new BrowserSocketAdapter({ socket: new FakeWebSocketService(responder), userId: 'user-1', networkId: 'roomful' }),
    appState, fetchImpl, config, now, applicationId, registry,
  });
  const ack = await new ServiceClient({ transport, cache: null }).call(testCase.key, testCase.params, { retries: 0 });
  return { ack, wire: wire(responder) };
}

for (const testCase of CASES) {
  const descriptor = findDescriptor(testCase.key);
  const title = `${testCase.key}${testCase.name ? ` — ${testCase.name}` : ''}`;
  // The host serves `local` functions in the page too, so only these differ by design.
  const refused = descriptor.channel === 'local' ? null : hostRefuses(descriptor);

  test(`dedicated and embedded answer alike: ${title}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-15T12:34:56.789Z') });
    const dedicated = await run(makeHostAppServices, testCase);
    const embedded = await run(makeEmbeddedServices, testCase);

    // The embedded call went over the bridge, unless the function runs in the page.
    const calls = embedded.posted.filter((post) => post.data.name === MSG.CALL);
    assert.equal(calls.length, descriptor.channel === 'local' ? 0 : 1, 'one api:call for a function the page does not run');

    if (refused !== null) {
      assert.equal(dedicated.ack.error?.code, refused, 'the host refuses it by design');
      assert.deepEqual(dedicated.wire, []);
      const own = await direct(testCase);
      assert.deepEqual(embedded.ack, own.ack, 'inside Valu Social it answers as over a socket of its own');
      assert.deepEqual(embedded.wire, own.wire);
      return;
    }
    assert.deepEqual(embedded.ack, dedicated.ack);
    assert.deepEqual(embedded.wire, dedicated.wire);
    assert.deepEqual(
      embedded.puts.map(({ url, method }) => ({ url, method })),
      dedicated.puts.map(({ url, method }) => ({ url, method })),
    );
  });
}
