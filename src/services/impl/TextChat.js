// ===========================================================================
// TextChat — 3 functions, channel `roomful`.
//
// The asymmetric service the plan flagged: the app declares `get-channel-
// history` and `send-message`, the server has `message_user` and `send_card`,
// and only `message-owner` is on both. Phase 2b keeps the server's two
// server-only (they are AGENT-authored, and an agent identity is not part of
// the SDK context); the three declared ones are here.
//
// ENCRYPTION is the honest limit of this layer. The app encrypts an outgoing
// body and decrypts an incoming one through the user's key material, which
// lives in the browser — the server's tools do neither. So the SDK sends
// plaintext and returns bodies as the platform stored them, and offers the
// runtime one hook (`appState.decryptMessage`) to do better where it can. A body that came
// back encrypted says so in `encrypted: true` rather than arriving as noise
// that reads like a message.
// ===========================================================================
import { ok, raw, str, limit, isAckError, ackErrorMessage, invalid, fail } from './support.js';
import { ERROR_CODES } from '../../Errors.js';

/** MessageType.MY — a message authored by the caller (TextChatStore). */
const MESSAGE_TYPE_MY = 0;
/** CardMimeType.RICH — the envelope a message with meta/buttons travels in. */
const CARD_MIME_RICH = 99;

/** Only these customParams keys may come from a caller; the rest are the runtime's. */
const ALLOWED_CUSTOM_PARAMS = new Set(['open-thread']);

/**
 * Keep the whitelisted customParams and drop the rest.
 *
 * Run ids and other trusted keys are server-injected (2026-07-03 security
 * audit); a tool call that could set them could forge the provenance of a
 * message. Dropping is deliberate — refusing would break a caller that passes
 * a harmless extra, and keeping would be the bug.
 */
export function sanitizeCustomParams(raw_) {
  if (!raw_ || typeof raw_ !== 'object' || Array.isArray(raw_)) return null;
  const clean = {};
  for (const key of Object.keys(raw_)) {
    if (ALLOWED_CUSTOM_PARAMS.has(key)) clean[key] = raw_[key];
  }
  return Object.keys(clean).length ? clean : null;
}

/**
 * Validate the caller's buttons, forgiving the two mistakes an LLM actually
 * makes — a JSON-stringified array, and the flat `{text, applicationId,
 * action}` shape — and WARNING about each, so the next call is right. Ported
 * from TextChatService.#sanitizeButtons.
 *
 * @returns {{buttons: object[], warnings: string[]}}
 */
export function sanitizeButtons(input) {
  if (input == null) return { buttons: [], warnings: [] };

  const warnings = [];
  let array = input;
  if (typeof array === 'string') {
    try {
      array = JSON.parse(array);
      warnings.push('buttons arrived as a JSON string — parsed it for you, but pass a real array next time');
    } catch {
      return { buttons: [], warnings: ['buttons must be an array, got a malformed JSON string — dropped all'] };
    }
  }
  if (!Array.isArray(array)) {
    return { buttons: [], warnings: [`buttons must be an array, got ${typeof array} — dropped all`] };
  }

  const buttons = [];
  array.forEach((button, i) => {
    if (!button || typeof button !== 'object' || Array.isArray(button)) {
      warnings.push(`buttons[${i}]: not an object — dropped`);
      return;
    }
    if (typeof button.text !== 'string' || !button.text.length) {
      warnings.push(`buttons[${i}]: missing or empty "text" — dropped`);
      return;
    }
    let intent = button.intent;
    if (!intent && typeof button.applicationId === 'string' && typeof button.action === 'string') {
      intent = { applicationId: button.applicationId, action: button.action, params: button.params ?? button.context ?? {} };
      warnings.push(`buttons[${i}] ("${button.text}"): flat shape detected — auto-promoted to {text, intent:{applicationId, action, params}}. Use the nested shape next time.`);
    }
    if (!intent || typeof intent !== 'object'
      || typeof intent.applicationId !== 'string' || !intent.applicationId.length
      || typeof intent.action !== 'string' || !intent.action.length) {
      warnings.push(`buttons[${i}] ("${button.text}"): invalid "intent" — need {applicationId, action[, params]} — dropped`);
      return;
    }
    const params = intent.params ?? intent.context;
    buttons.push({
      text: button.text,
      intent: {
        applicationId: intent.applicationId,
        action: intent.action,
        params: (params && typeof params === 'object' && !Array.isArray(params)) ? params : {},
      },
    });
  });
  return { buttons, warnings };
}

/** The wire message: plain text, or the RICH envelope when there is more. */
function buildMessage(text, { buttons = [], meta = null } = {}) {
  const hasButtons = buttons.length > 0;
  const hasMeta = meta && Object.keys(meta).length > 0;
  if (!hasButtons && !hasMeta) return { messageType: MESSAGE_TYPE_MY, messageBody: String(text) };
  return {
    messageType: MESSAGE_TYPE_MY,
    messageBody: JSON.stringify({ mimeType: CARD_MIME_RICH, text: String(text), buttons, ...(hasMeta ? { meta } : {}) }),
  };
}

/** Post a built message and answer in the SDK's shape. */
async function post(ctx, channelId, message, customParams, warnings) {
  const ack = await raw(ctx, 'channel:createMessage', {
    channelId,
    ...message,
    ...(customParams ? { customParams } : {}),
  });
  if (isAckError(ack)) return ack;
  const sent = ack.data?.message ?? {};
  return ok({
    channelId,
    messageId: sent.messageId ?? null,
    createdAt: sent.created ?? null,
    ...(warnings?.length ? { buttonWarnings: warnings } : {}),
  });
}

export function register(registry) {
  registry
    .define('TextChat.get-channel-history', async (params, ctx) => {
      const channelId = str(params.channelId);
      const before = str(params.beforeMessageId);
      const after = str(params.afterMessageId);
      const ack = await raw(ctx, 'channel:listMessages', {
        channelId,
        limit: limit(params.limit, 20),
        // One `messageId` field, one `direction` — the RPC takes a cursor and
        // a direction, not two cursors (TextChatStore.listMessagesForChannelRaw).
        ...(before || after ? { messageId: before || after, direction: 'bilateral' } : {}),
      });
      if (isAckError(ack)) return ack;

      const self = ctx.socket.selfUserId || ctx.socket.userId || null;
      const decrypt = typeof ctx.appState?.decryptMessage === 'function'
        ? (body, message) => ctx.appState.decryptMessage(body, message)
        : null;

      const messages = [];
      for (const message of ack.data?.messages ?? []) {
        let body = message.messageBody;
        let encrypted = false;
        if (message.isDeleted) body = '[deleted]';
        else if (message.isBlocked) body = '[blocked by moderator]';
        else if (message.encryptionEpoch) {
          if (decrypt) {
            try { body = await decrypt(body, message); }
            catch (error) { body = `[decryption failed: ${error?.message ?? error}]`; }
          } else {
            // Saying so beats handing back ciphertext that reads like a message.
            encrypted = true;
          }
        }
        messages.push({
          messageId: message.messageId,
          channelId: message.channelId,
          authorId: message.authorId,
          role: self && message.authorId === self ? 'assistant' : 'user',
          body,
          timestamp: message.created,
          messageType: message.messageType,
          isDeleted: Boolean(message.isDeleted),
          isBlocked: Boolean(message.isBlocked),
          ...(encrypted ? { encrypted: true } : {}),
        });
      }

      return ok({
        channelId,
        messages,
        hasPrevious: Boolean(ack.data?.hasPrevious),
        hasNext: Boolean(ack.data?.hasNext),
      });
    })

    // Authored by the CURRENT USER. `userId` is a convenience: it resolves to
    // that person's direct channel first.
    .define('TextChat.send-message', async (params, ctx) => {
      const text = params.text;
      if (text == null || String(text).length === 0) return invalid('text is required');
      let channelId = str(params.channelId);
      const userId = str(params.userId);
      if (!channelId && !userId) return invalid('either channelId or userId is required');

      if (!channelId) {
        const direct = await raw(ctx, 'channel:getDirectChannel', { targetUser: userId, returnLastMessage: false });
        if (isAckError(direct)) return direct;
        channelId = direct.data?.channel?.channelId ?? '';
        if (!channelId) return invalid(`no direct channel for user ${userId}`);
      }

      const { buttons, warnings } = sanitizeButtons(params.buttons);
      return post(ctx, channelId, buildMessage(text, { buttons }), sanitizeCustomParams(params.customParams), warnings);
    })

    // Authored by the AGENT, into the owner's private agent channel. The
    // channel source IS the addressing — `userAIAgent:{owner}:{agent}` — and
    // `meta.sender.agentId` is what lets the recipient tell an agent message
    // from its owner's: both ride the owner's socket, so the platform's
    // authorId is the same for either.
    .define('TextChat.message-owner', async (params, ctx) => {
      const userId = str(params.userId);
      const agentId = str(params.agentId);
      const text = params.text;
      if (text == null || String(text).length === 0) return invalid('text is required');

      const resolved = await raw(ctx, 'channel:getChannelBySource', { channelSource: `userAIAgent:${userId}:${agentId}` });
      if (isAckError(resolved)) return resolved;
      const channelId = resolved.data?.channel?.channelId;
      if (!channelId) {
        return fail(ERROR_CODES.UNKNOWN_FUNCTION, `no agent channel for ${userId}/${agentId}`,
          ackErrorMessage(resolved, 'the channel source resolved to nothing'));
      }

      const { buttons, warnings } = sanitizeButtons(params.buttons);
      const message = buildMessage(text, { buttons, meta: { sender: { agentId } } });
      return post(ctx, channelId, message, sanitizeCustomParams(params.customParams), warnings);
    });

  return registry;
}
