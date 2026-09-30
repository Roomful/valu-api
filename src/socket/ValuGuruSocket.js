// ===========================================================================
// The Valu Guru socket contract.
//
// The SECOND socket. `ValuSocket` carries the Roomful platform RPCs
// (`social:*`, `room:*`, `channel:*`); this one carries the Valu Guru server's
// own request/response channel — the `valuguru.*` op catalogue that Commerce
// and the RAG search ride (valusocial-web src/Services/Commerce/
// CommerceDataService.js, AiGuruService.request / #catalogueWrite).
//
// Phase 1 called both of them "socket", which was true and useless: a handler
// has to know WHICH one, because the envelope, the auth and the failure modes
// are all different. `descriptor.channel` says which, and a function whose
// channel is `valuguru` gets this object as `ctx.guru`.
//
// Two verbs, because the server has two envelopes:
//   request(op, params)  `{type: 'data_request', op, params}` → the op's data
//   send(message)        a typed catalogue message (e.g. `{type: 'rag_search'}`)
// Both RESOLVE their answer and THROW on failure, mirroring the app's own
// transport; `guruAck` turns either outcome into the SDK's ack envelope so a
// caller never has to know which socket served them.
// ===========================================================================
import { ERROR_CODES, errorAck } from '../Errors.js';

/**
 * @typedef {object} ValuGuruSocket
 * @property {(op: string, params?: object, options?: {timeoutMs?: number}) => Promise<any>} request
 *   Run a `valuguru.*` op and resolve its response data.
 * @property {(message: object, options?: {timeoutMs?: number}) => Promise<any>} [send]
 *   Send a typed catalogue message and resolve its reply. Omitted by
 *   transports that only carry `data_request`.
 * @property {string} [networkId] Active network, when the transport knows it.
 */

/** True when the object can carry Valu Guru traffic. */
export const isGuruSocket = (guru) => Boolean(guru) && typeof guru.request === 'function';

/**
 * Run a Valu Guru call and answer in the ack envelope.
 *
 * The app's transport rejects — with `code: 'timeout'`, `name: 'AbortError'`,
 * or the server's own `{code, message}`. Those become ack error codes here, so
 * `Commerce.get-cart` timing out and `Users.get` timing out look identical to
 * the caller and retry under the same policy.
 *
 * @param {() => Promise<any>} call
 * @param {string} what Names the call in the error message.
 * @returns {Promise<import('./ValuSocket.js').ValuAck>}
 */
export async function guruAck(call, what) {
  try {
    return { data: await call() };
  } catch (error) {
    return errorAck(guruErrorCode(error), `${what}: ${error?.message ?? error}`, error?.code ? String(error.code) : undefined);
  }
}

/** Map a Valu Guru transport rejection onto an ack error code. */
export function guruErrorCode(error) {
  const code = error?.code;
  if (code === 'timeout') return ERROR_CODES.TIMEOUT;
  if (code === 'aborted' || error?.name === 'AbortError') return ERROR_CODES.TIMEOUT;
  if (code === 'forbidden' || code === 'not_eligible_kyc') return ERROR_CODES.FORBIDDEN;
  if (typeof code === 'number') return code;
  const text = String(error?.message ?? '');
  if (/timed? ?out/i.test(text)) return ERROR_CODES.TIMEOUT;
  if (/not connected|disconnect|cannot .*connect/i.test(text)) return ERROR_CODES.DISCONNECTED;
  return ERROR_CODES.DISCONNECTED;
}

/**
 * Wrap the app's `AiGuruService` (or anything with the same two methods) as a
 * `ValuGuruSocket`. Identical in the browser and on node — the app's service
 * and a headless client both expose `request`/`send`.
 *
 * @param {{request: Function, send?: Function, catalogueWrite?: Function, networkId?: string}} service
 * @returns {ValuGuruSocket}
 */
export function guruAdapter(service) {
  if (!service || typeof service.request !== 'function') {
    throw new TypeError('a ValuGuruSocket needs a request(op, params) method');
  }
  const send = service.send ?? service.catalogueWrite;
  return {
    get networkId() { return service.networkId; },
    request: (op, params = {}, options = {}) => service.request(op, params, options),
    ...(typeof send === 'function'
      ? { send: (message, options = {}) => send.call(service, message, options) }
      : {}),
  };
}

/**
 * The ack a `valuguru` function answers when no Valu Guru socket was given.
 *
 * UNSUPPORTED, not DISCONNECTED: a missing socket is a fact of how the
 * transport was built, and nothing about it changes between attempts — a
 * retriable code would buy three attempts and two backoffs for an answer that
 * cannot improve. Same reason `noAppStateAck` is 501.
 */
export const noGuruAck = (descriptor) => errorAck(
  ERROR_CODES.UNSUPPORTED,
  `${descriptor.key} needs the Valu Guru socket, and none was supplied`,
  `${descriptor.key} is served over the Valu Guru channel (descriptor.channel: "valuguru"), not the Roomful socket. Pass { guru } to the SocketTransport.`,
);
