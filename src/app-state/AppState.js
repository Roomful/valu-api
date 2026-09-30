// ===========================================================================
// Application state — the five functions no RPC can answer.
//
// The manifest declares them like any other service intent, and Phase 1
// counted them as socket-backed because that is what the manifest says. Phase
// 2 went looking for the RPC and there is none: the answer lives in the Valu
// Social application's own memory.
//
//   AiGuru.get-chat-history    the session's in-memory message list
//   AiGuru.get-agent-history   the agent's in-memory message list
//   Developer.list-applications   DeveloperPortalStore's application list
//   Developer.create-application  the same store, plus the app registry
//   VerusWallet.get-balance    the balance AiGuruStore cached off a push
//
// These five are the reason `channel: 'app-state'` is not named after a
// transport the way `postmessage` is: in a frame they arrive over the
// postMessage bridge like everything else, but a headless runtime has no bridge
// and must hold the state itself. The channel names the SOURCE of the answer;
// `binding` still names how you reach it.
//
// The SDK does NOT invent a network call for them. A runtime that holds the
// state implements this interface and passes it to `SocketTransport` as
// `{ appState }`; one that does not gets an ack naming the missing capability,
// which is the one honest answer — it is also exactly the coupling Phase 3.1
// exists to invert, so the shape here is deliberately the smallest thing that
// could work.
// ===========================================================================
import { ERROR_CODES, errorAck } from '../Errors.js';

/**
 * @typedef {object} AppState
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
 *   the browser, so only a runtime running inside the browser can do this;
 *   without it `TextChat.get-channel-history` flags an encrypted body rather
 *   than returning ciphertext that reads like a message.
 */

/**
 * The ack an `app-state` function answers when the runtime holds no such state.
 * @param {import('../services/descriptors.js').ServiceDescriptor} descriptor
 * @param {string} capability The AppState method that was missing.
 */
export const noAppStateAck = (descriptor, capability) => errorAck(
  ERROR_CODES.UNSUPPORTED,
  `${descriptor.key} needs application state (${capability}), and this runtime has none`,
  `${descriptor.key} is answered from state the Valu Social application holds, not `
  + `from an RPC — there is no socket call that can produce it. Pass { appState } with `
  + `a ${capability}() to the SocketTransport, or call it over the postMessage bridge, `
  + `where the application itself answers.`,
);

/**
 * Read one capability off the application state, or return the ack that says
 * why not.
 * @param {AppState|null|undefined} appState
 * @returns {{fn: Function}|{ack: import('../socket/ValuSocket.js').ValuAck}}
 */
export function appStateCapability(appState, capability, descriptor) {
  const fn = appState?.[capability];
  if (typeof fn !== 'function') return { ack: noAppStateAck(descriptor, capability) };
  return { fn: (...args) => fn.apply(appState, args) };
}
