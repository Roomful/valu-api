// ===========================================================================
// Frame commands — Phase 2d.
//
// Fifteen of the ninety-two declared intents are not service functions and
// should stop pretending to be. They open and close applications, expand a
// pane, render a picker and wait for a choice, hand back the Valu Social
// application's log buffer, mint an identity token. Every one of them needs the
// frame — they are `binding: 'postmessage'` for that reason — none of them has
// a socket form, and a socket transport answers all fifteen with the same 501,
// which is correct and useless as an API.
//
// So they get a named one. `FrameCommands` is the SAME postMessage traffic
// `api:service-intent` already carries — nothing on the wire changes here —
// with a method per command, the params the manifest declares, and a return
// the caller can read. What changes is that a developer reading the SDK can
// see which fifteen things live on the frame and why, instead of discovering
// it one 501 at a time.
//
// Phase 3.4 removes `api:service-intent` and keeps `api:run-command` for these.
// ===========================================================================
import { findDescriptor, listDescriptors } from '../services/descriptors.js';
import { ERROR_CODES, errorAck } from '../Errors.js';
import { dataAck } from '../socket/ValuSocket.js';

/** The fifteen, grouped by what they actually do. */
export const FRAME_COMMAND_KINDS = {
  /** Window management on the application dock. */
  window: [
    'AiGuru.open', 'AiGuru.close', 'AiGuru.has-application', 'AiGuru.get-applications',
    'AiGuru.is-application-loaded', 'Application.expand-application',
    'Application.close-application', 'Application.close_all',
  ],
  /** Application UI that returns the user's choice. */
  picker: ['DataProvider.pick-single', 'DataProvider.pick-multiple'],
  /** Navigating the Valu Social application to one of its own surfaces. */
  navigate: ['Commerce.open-cart', 'Commerce.open-purchases', 'Commerce.open-products'],
  /** State only the frame holds. (Not `channel: 'app-state'` — those five are
   *  socket-bound intents; these two are postMessage-bound.) */
  frameState: ['Application.get-identity-token', 'Logging.get-logs'],
};

/** Every postMessage-bound key, flat. */
export const FRAME_COMMANDS = Object.values(FRAME_COMMAND_KINDS).flat();

/** What kind of frame command a key is, or undefined when it is not one. */
export function frameCommandKind(key) {
  const descriptor = findDescriptor(key);
  if (!descriptor) return undefined;
  return Object.keys(FRAME_COMMAND_KINDS).find((kind) => FRAME_COMMAND_KINDS[kind].includes(descriptor.key));
}

/**
 * The fifteen frame commands, over a bridge transport.
 *
 * Every method resolves the SAME ack envelope a service call does, so a caller
 * that already handles `{data} | {error}` handles these too — the difference
 * between a frame command and a service function is where it runs, not how its
 * failure is read.
 */
export class FrameCommands {
  #transport;

  /**
   * @param {import('../transport/Transport.js').Transport} transport
   *   A `PostMessageTransport`. A socket transport is refused outright rather
   *   than failing per call: there is no frame there to command.
   */
  constructor(transport) {
    if (!transport?.supportsPostMessage) {
      // Asking a socket transport would answer 501 fifteen times. There is no
      // frame behind a socket, and the honest place to say so is here.
      throw new TypeError(
        `FrameCommands needs a transport that speaks the postMessage bridge; ${transport?.name ?? transport} does not`,
      );
    }
    this.#transport = transport;
  }

  get transport() { return this.#transport; }

  /** Descriptors for the fifteen, for a caller that wants to enumerate them. */
  static descriptors() { return listDescriptors({ binding: 'postmessage' }); }

  /**
   * Run one frame command by its declared name.
   *
   * @param {string} name Any name form `findDescriptor` accepts.
   * @param {object} [params]
   * @returns {Promise<import('../socket/ValuSocket.js').ValuAck>}
   */
  async run(name, params = {}) {
    const descriptor = findDescriptor(name);
    if (!descriptor) {
      return errorAck(ERROR_CODES.UNKNOWN_FUNCTION, `unknown frame command: ${name}`);
    }
    // The symmetric refusal to the socket transport's: a socket cannot serve a
    // postMessage-bound intent, and this cannot serve a socket one.
    if (descriptor.binding !== 'postmessage') {
      return errorAck(
        ERROR_CODES.UNSUPPORTED,
        `${descriptor.key} is not a frame command (binding: ${descriptor.binding})`,
        'Call it through ServiceClient, which routes it to the socket that serves it.',
      );
    }
    if (!this.#transport.connected) {
      return errorAck(ERROR_CODES.DISCONNECTED, `${descriptor.key}: not connected to the Valu Social application`);
    }

    try {
      const result = await this.#transport.request('api:service-intent', {
        applicationId: descriptor.service,
        action: descriptor.action,
        params,
      });
      if (result && typeof result === 'object' && result.error) {
        const { error } = result;
        return typeof error === 'string' ? errorAck(undefined, error) : { error: { status: true, ...error } };
      }
      return dataAck(result);
    } catch (error) {
      return errorAck(ERROR_CODES.DISCONNECTED, `${descriptor.key}: ${error?.message ?? error}`);
    }
  }

  // --- window ------------------------------------------------------------

  /** Open an application in the dock. */
  openApplication(applicationId) { return this.run('AiGuru.open', { applicationId }); }
  /** Close an open application. */
  closeApplication(applicationId) { return this.run('AiGuru.close', { applicationId }); }
  /** Whether the dock knows this application at all. */
  hasApplication(applicationId) { return this.run('AiGuru.has-application', { applicationId }); }
  /** Whether it is loaded right now — a different question from `hasApplication`. */
  isApplicationLoaded(applicationId) { return this.run('AiGuru.is-application-loaded', { applicationId }); }
  /** Every application the dock can open. */
  getApplications() { return this.run('AiGuru.get-applications'); }
  /** Expand the CALLING application's pane. */
  expandSelf() { return this.run('Application.expand-application'); }
  /** Close the CALLING application. */
  closeSelf() { return this.run('Application.close-application'); }
  /** Close every open application. */
  closeAll() { return this.run('Application.close_all'); }

  // --- pickers -----------------------------------------------------------

  /**
   * Render the application's picker and resolve what the user chose.
   *
   * These are the two commands whose latency is a PERSON, not a network: the
   * call policy's 30s timeout is meaningless here, so a picker is never given
   * one — it settles when the user does.
   */
  pickSingle({ providers, title, width, height } = {}) {
    return this.run('DataProvider.pick-single', { providers, title, width, height });
  }

  pickMultiple({ providers, title, confirmLabel, confirmIcon, width, height } = {}) {
    return this.run('DataProvider.pick-multiple', { providers, title, confirmLabel, confirmIcon, width, height });
  }

  // --- navigate ----------------------------------------------------------

  openCart() { return this.run('Commerce.open-cart'); }
  openPurchases() { return this.run('Commerce.open-purchases'); }
  /** The SELLER's console — the seller's whole catalogue, not this app's part. */
  openProducts() { return this.run('Commerce.open-products'); }

  // --- application state --------------------------------------------------------

  /**
   * A short-lived identity token for the calling application.
   *
   * The one command whose RESULT is a credential. It is returned and never
   * logged, cached or put in an error message — `assertNoCredentialLeak`
   * (src/auth/AuthProvider.js) is what keeps that true elsewhere.
   */
  getIdentityToken() { return this.run('Application.get-identity-token'); }

  /** The Valu Social application's own captured log buffer. */
  getLogs(format) { return this.run('Logging.get-logs', format ? { format } : {}); }
}
