// ===========================================================================
// Application intents — one dynamic call, no functions.
//
// This replaces FrameCommands, and the reason is the whole architecture in one
// sentence: the Valu Social application registers its intents at RUNTIME, so a
// package that ships a method per intent is a snapshot of a list that moves
// without it.
//
// `openApplication()`, `closeSelf()`, `pickSingle()` were fifteen hand-written
// methods for fifteen things this package cannot do — it can only ask the
// application to. Ask it by name, and the same eleven lines serve the fifteen
// in the catalogue, the ones the app added last week, and the ones it will add
// next: `run('SomeService.some-action', params)` posts what it is given.
//
// The catalogue is still worth having, but as DOCUMENTATION rather than as a
// gate — `list()` and `describe()` are what a frame app (or a chat session
// generating tools on the fly) reads to find out what it may ask for. The
// application's own registry is the authority; this is a snapshot of it.
//
// Nothing about the wire changed: `api:service-intent`, the same envelope
// `ServiceClient` sends over the bridge and the same one FrameCommands sent.
// ===========================================================================
import { findDescriptor, listDescriptors, APPLICATION_INTENTS } from '../services/descriptors.js';
import { ERROR_CODES, errorAck } from '../Errors.js';
import { dataAck } from '../socket/ValuSocket.js';

/**
 * Split a name into the application it addresses and the action it asks for.
 *
 * A declared name resolves through the catalogue, which also normalises the
 * three name forms (`close-application`, `close_application`,
 * `closeApplication`) onto the one the application registered. An UNDECLARED
 * name is split on the first dot and sent as written — that is the dynamic
 * path, and refusing it would make this class exactly the snapshot it replaces.
 */
export function parseIntentName(name) {
  if (typeof name !== 'string' || !name.includes('.')) return undefined;
  const descriptor = findDescriptor(name);
  if (descriptor) {
    return { applicationId: descriptor.service, action: descriptor.action, descriptor };
  }
  const dot = name.indexOf('.');
  return { applicationId: name.slice(0, dot), action: name.slice(dot + 1), descriptor: undefined };
}

/**
 * Run any intent the Valu Social application declares, over the postMessage
 * bridge.
 *
 * Answers the SAME ack envelope a service call does, so a caller that handles
 * `{data} | {error}` handles these too.
 */
export class ApplicationIntents {
  #transport;

  /**
   * @param {import('../transport/Transport.js').Transport} transport
   *   A `PostMessageTransport`. A socket transport is refused at construction:
   *   there is no application behind a socket to ask, and finding that out per
   *   call would be the same surprise once per intent.
   */
  constructor(transport) {
    if (!transport?.supportsPostMessage) {
      throw new TypeError(
        'ApplicationIntents needs a transport that speaks the postMessage bridge; '
        + `${transport?.name ?? transport} does not. Service functions run anywhere `
        + '(createValuServices); application intents run only inside a Valu Social frame.',
      );
    }
    this.#transport = transport;
  }

  get transport() { return this.#transport; }

  /**
   * Every intent the application declares, as of this package's snapshot —
   * including the ones the SDK also implements as service functions, because
   * over the bridge the application can serve those too.
   *
   * Only `declaredBy: 'manifest'` appears here: a function this package
   * declares itself (scripts/extensions.js) is not something the application
   * knows how to answer.
   * @param {{service?: string, availability?: string}} [filter]
   */
  static list(filter = {}) { return listDescriptors({ ...filter, declaredBy: 'manifest' }); }

  /**
   * The intents ONLY the application can serve — the 15 with no service
   * function, and the honest answer to "what do I lose outside a frame".
   */
  static exclusive() { return [...APPLICATION_INTENTS]; }

  /** What the catalogue knows about a name, or `undefined` for one it has never seen. */
  static describe(name) { return findDescriptor(name); }

  list(filter) { return ApplicationIntents.list(filter); }
  exclusive() { return ApplicationIntents.exclusive(); }
  describe(name) { return ApplicationIntents.describe(name); }

  /**
   * Ask the application to run an intent.
   *
   * @param {string} name `Application.close-application`, or any
   *   `Service.action` the application registers — declared in this snapshot
   *   or not.
   * @param {object} [params]
   * @returns {Promise<import('../socket/ValuSocket.js').ValuAck>}
   */
  async run(name, params = {}) {
    const target = parseIntentName(name);
    if (!target) {
      return errorAck(
        ERROR_CODES.UNKNOWN_FUNCTION,
        `"${name}" is not an intent name — expected "Service.action"`,
      );
    }
    if (!this.#transport.connected) {
      return errorAck(
        ERROR_CODES.DISCONNECTED,
        `${target.applicationId}.${target.action}: not connected to the Valu Social application`,
      );
    }

    try {
      const result = await this.#transport.request('api:service-intent', {
        applicationId: target.applicationId,
        action: target.action,
        params,
      });
      if (result && typeof result === 'object' && result.error) {
        const { error } = result;
        return typeof error === 'string' ? errorAck(undefined, error) : { error: { status: true, ...error } };
      }
      return dataAck(result);
    } catch (error) {
      return errorAck(
        ERROR_CODES.DISCONNECTED,
        `${target.applicationId}.${target.action}: ${error?.message ?? error}`,
      );
    }
  }
}
