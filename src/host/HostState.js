// ===========================================================================
// Host state — the five functions no RPC can answer.
//
// The manifest declares them like any other service intent, and Phase 1
// counted them as socket-backed because that is what the manifest says. Phase
// 2 went looking for the RPC and there is none: the answer lives in the host's
// own memory.
//
//   AiGuru.get-chat-history    the session's in-memory message list
//   AiGuru.get-agent-history   the agent's in-memory message list
//   Developer.list-applications   DeveloperPortalStore's application list
//   Developer.create-application  the same store, plus the app registry
//   VerusWallet.get-balance    the balance AiGuruStore cached off a push
//
// The SDK does NOT invent a network call for them. A host that holds the state
// implements this interface and passes it in; a host that does not gets an ack
// that names the missing capability, which is the one honest answer — it is
// also exactly the coupling Phase 3.1 exists to invert, so the shape here is
// deliberately the smallest thing that could work.
// ===========================================================================
import { ERROR_CODES, errorAck } from '../Errors.js';

/**
 * @typedef {object} HostState
 * @property {(chatId: string|null) => Promise<{session: object, messages: object[]}|null>} [getChatHistory]
 *   The session and its messages. `null` chatId means the active session.
 * @property {(agentId: string) => Promise<{agent: object, messages: object[]}|null>} [getAgentHistory]
 * @property {() => Promise<object[]>} [listDeveloperApplications]
 * @property {(manifest: {name: string, description?: string, url?: string, icon?: string}) => Promise<object>} [createDeveloperApplication]
 * @property {(agentId: string) => Promise<{identityName: string, iAddress: string, balance: number|null, status?: string}|null>} [getAgentWallet]
 *   The wallet attached to an agent, as AiGuruStore.getWalletForAgent returns
 *   it. Used by VerusWallet.get-balance AND by VerusWallet.transfer, which
 *   needs the identity before it can emit `verus:sendCurrency`.
 * @property {(body: string, message: object) => Promise<string>} [decryptMessage]
 *   Optional. Decrypt a channel message body. The app's key material lives in
 *   the browser, so only a browser host can do this; without it
 *   `TextChat.get-channel-history` flags an encrypted body rather than
 *   returning ciphertext that reads like a message.
 */

/**
 * The ack a host-state function answers when the host cannot serve it.
 * @param {import('../services/descriptors.js').ServiceDescriptor} descriptor
 * @param {string} capability The HostState method that was missing.
 */
export const noHostStateAck = (descriptor, capability) => errorAck(
  ERROR_CODES.UNSUPPORTED,
  `${descriptor.key} needs host state (${capability}), and this runtime has none`,
  `${descriptor.key} is answered from state the host holds, not from an RPC — `
  + `there is no socket call that can produce it. Pass { host } with a ${capability}() `
  + `to the SocketTransport, or call it where the host runs.`,
);

/**
 * Read one capability off the host, or return the ack that says why not.
 * @returns {{fn: Function}|{ack: import('../socket/ValuSocket.js').ValuAck}}
 */
export function hostCapability(host, capability, descriptor) {
  const fn = host?.[capability];
  if (typeof fn !== 'function') return { ack: noHostStateAck(descriptor, capability) };
  return { fn: (...args) => fn.apply(host, args) };
}
