// ===========================================================================
// The conformance adapter for EMBEDDED mode: an app framed by Valu Social,
// built the way an app builds itself (`createValuApp()`), whose calls travel
// over the postMessage bridge to a Valu Social that answers them with the
// frame server over its own connection.
//
//   valu (createValuApp, embedded: validation, cache, retry, consent retry)
//     -> EmbeddedTransport         local functions in the page; the rest as api:call
//       -> PostMessageTransport    over a FakeWindowPair: the frame and its parent
//         -> createFrameServer     what Valu Social mounts (spec §5): no gate, ONE attempt
//           -> services            connectValuServices({ socket: webSocketService, userId })
//             -> BrowserSocketAdapter on FakeWebSocketService(responder)
//
// The responder the case scripted is Valu Social's socket, so a clause that
// reads `responder.calls` reads the real wire.
//
// WHAT IS REFUSED: nothing a direct socket serves. `local` functions run in the
// page (the case's `fetchImpl`, `config`, `now` and `registry` reach them as
// they reach a SocketTransport); the permission tiers are the host's and there
// is none here; the `app-state` functions run with the case's app state, which
// Valu Social hands its frame server.
// ===========================================================================
import { createValuApp } from '../../src/createValuApp.js';
import { createFrameServer } from '../../src/embed/FrameServer.js';
import { MSG, toParent } from '../../src/host/protocol.js';
import { connectValuServices } from '../../src/services/api.js';
import { SocketTransport } from '../../src/transport/SocketTransport.js';
import { FakeWebSocketService } from '../helpers/fakes.js';
import { FakeWindowPair } from '../helpers/hostFakes.js';

export const VALU_SOCIAL_ORIGIN = 'https://live.valuverse.io';
export const FRAME_ORIGIN = 'https://demo-ws-1.valuguru.app';

/** Who Valu Social's socket is credentialed as: what the cases' payloads (`forUser`, `app:app-1:...:user-1`) expect. */
const USER = Object.freeze({ id: 'user-1', name: 'Ada Lovelace' });
const NETWORK = Object.freeze({ id: 'roomful', name: 'Roomful' });

/** Embedded mode makes no iframe: a document that says so if it is asked to. */
const noDocument = { createElement() { throw new Error('embedded mode makes no iframe'); } };

/**
 * Valu Social, as far as a framed app sees it: one frame server over its
 * services, answering the frame's `api:call` (only from that frame and its
 * origin) with `api:call-completed`, to the frame's origin.
 * @param {{app: object, host: object}} pair `app` is Valu Social, `host` the frame.
 * @param {ReturnType<typeof createFrameServer>} frames
 */
function answerFrames(pair, frames) {
  const { app: valuSocial, host: frame } = pair;
  valuSocial.addEventListener('message', async ({ data, source, origin }) => {
    if (source !== frame || origin !== FRAME_ORIGIN || data?.name !== MSG.CALL) return;
    const ack = await frames.handle(data.message);
    frame.postMessage(toParent(MSG.CALL_COMPLETED, ack, data.message.requestId), FRAME_ORIGIN);
  });
}

/**
 * @param {import('../helpers/fakes.js').Responder} responder
 * @param {object} options What the suite configures: the `appState`, `fetchImpl`, `config`, `now`,
 *   `applicationId` and `registry` a SocketTransport would be given.
 */
export async function makeEmbeddedServices(responder, options = {}) {
  const logs = [];
  const services = await connectValuServices({
    socket: new FakeWebSocketService(responder),
    userId: USER.id,
    networkId: NETWORK.id,
    cache: null,
    registry: options.registry,
    fetchImpl: options.fetchImpl,
    config: options.config,
    now: options.now,
    applicationId: options.applicationId,
  });
  const frames = createFrameServer({
    services,
    appState: options.appState ?? null,
    log: (level, message) => logs.push({ level, message }),
  });

  const pair = FakeWindowPair({ appOrigin: VALU_SOCIAL_ORIGIN, hostOrigin: FRAME_ORIGIN });
  pair.host.location = { search: '' };
  pair.host.navigator = {};
  answerFrames(pair, frames);

  const valu = await createValuApp({
    window: pair.host,
    document: noDocument,
    localTransport: new SocketTransport({
      socket: null, fetchImpl: options.fetchImpl, config: options.config, now: options.now, registry: options.registry,
    }),
  });
  pair.host.postMessage(toParent(MSG.READY, {
    applicationId: 'app-1', action: 'open', params: {}, valuApi: frames.readyInfo({ user: USER, network: NETWORK }),
  }), FRAME_ORIGIN);
  await valu.ready;

  let closed = false;
  return {
    services: valu,
    pair,
    close: async () => {
      if (closed) return;
      closed = true;
      await valu.close();
      await services.close();
      // A frame server that logged met something it did not expect (a leak, a throw).
      if (logs.length > 0) throw new Error(`the frame server logged: ${JSON.stringify(logs)}`);
    },
  };
}
