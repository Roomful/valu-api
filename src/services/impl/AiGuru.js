// ===========================================================================
// AiGuru — 3 declared functions the SDK can serve; the other 5 are
// postMessage-bound application intents (src/intents/ApplicationIntents.js).
//
// Two channels in one service, which is why the channel field had to exist:
//
//   get-chat-history / get-agent-history   `app-state`. There is no RPC. The
//     app reads an in-memory message list off AiGuruService/AgentsService; a
//     session that was never open in this runtime has no history to read, and
//     the SDK says that instead of returning an empty list that looks like a
//     quiet conversation.
//
//   query-knowledge-base   `valuguru`. A typed catalogue message
//     (`{type: 'rag_search'}`) on the Valu Guru socket, NOT a Roomful RPC —
//     it bypasses the chat loop entirely and answers with the raw tool text.
// ===========================================================================
import { fromAppState, guruSend, str, invalid } from './support.js';

export function register(registry) {
  registry
    .define('AiGuru.get-chat-history', (params, ctx) => fromAppState(ctx, 'getChatHistory', async (read) => {
      // No chatId means the ACTIVE session, which only the application knows.
      const history = await read(params.chatId ? str(params.chatId) : null);
      if (!history) throw new Error(params.chatId ? `session "${params.chatId}" not found` : 'no active session');
      return { session: history.session ?? null, messages: history.messages ?? [] };
    }))

    .define('AiGuru.get-agent-history', (params, ctx) => fromAppState(ctx, 'getAgentHistory', async (read) => {
      const history = await read(str(params.agentId));
      if (!history) throw new Error(`agent "${params.agentId}" not found`);
      return { agent: history.agent ?? null, messages: history.messages ?? [] };
    }))

    .define('AiGuru.query-knowledge-base', (params, ctx) => {
      const query = str(params.query);
      const toolName = str(params.toolName);
      // The backend picks the sole registered RAG tool when none is named; it
      // only insists on a name when there is more than one, and says which.
      if (!query && !toolName) return Promise.resolve(invalid('query is required'));
      return guruSend(ctx, {
        type: 'rag_search',
        query,
        ...(toolName ? { toolName } : {}),
        ...(params.args && typeof params.args === 'object' ? { args: params.args } : {}),
      }, (reply) => {
        if (reply?.ok === false) throw Object.assign(new Error(reply.error || 'RAG query failed'), { code: reply.code });
        return { toolName: reply?.toolName ?? toolName ?? null, result: reply?.result ?? '' };
      });
    });

  return registry;
}
