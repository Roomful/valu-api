// ===========================================================================
// VerusWallet — 2 functions. `get-balance` is `host-state`, `transfer` is
// `roomful`. This is the case the implementation plan named in advance:
// "parity is not identical behaviour".
//
// get-balance NEVER goes to the network. The app reads the balance
// AiGuruStore cached off the `verus:agentBalancesEvent` push
// (VerusWalletService.getBalance — "Does not hit the network"). There IS no
// ack-returning balance RPC: `verus:getAgentsBalance` is fire-and-forget and
// its answer arrives on a listener, which a request/response socket cannot
// catch. So the SDK reads the host's wallet state, and the descriptor's cache
// mode is `seeded` so a host that has the number can seed it and the SDK will
// serve it without asking anyone.
//
// transfer DOES go to the socket — but it cannot start there. The declared
// param is an AGENT id and the RPC wants the wallet's identity + i-address, so
// the wallet has to be resolved first, and only the host knows which wallet is
// attached to which agent. A host without that state gets a 501 that says so;
// it does not get a transfer to an address the SDK guessed.
// ===========================================================================
import { ok, raw, str, host, isAckError, invalid, fail } from './support.js';
import { ERROR_CODES } from '../../Errors.js';

/** The wallet attached to an agent, or the ack explaining why not. */
async function resolveWallet(ctx, agentId) {
  const capability = host(ctx, 'getAgentWallet');
  if (capability.ack) return { ack: capability.ack };

  let wallet;
  try {
    wallet = await capability.fn(agentId);
  } catch (error) {
    return { ack: fail(ERROR_CODES.UNSUPPORTED, `${ctx.descriptor.key}: ${error?.message ?? error}`) };
  }
  if (!wallet) {
    return { ack: invalid(`agent ${agentId} has no wallet attached — attach one in the agent settings first`) };
  }
  // A wallet exists on the row before it exists on-chain. Spending from one
  // that is still being created fails at the backend with a worse message.
  if (wallet.status !== undefined && (wallet.status !== 'created' || !wallet.iAddress)) {
    const reason = wallet.status === 'pending'
      ? 'the wallet is still being created on-chain'
      : (wallet.error || 'the wallet is not ready');
    return { ack: invalid(`wallet "${wallet.identityName ?? agentId}" is not usable: ${reason}`) };
  }
  return { wallet };
}

export function register(registry) {
  registry
    .define('VerusWallet.get-balance', async (params, ctx) => {
      const { wallet, ack } = await resolveWallet(ctx, str(params.agentId));
      if (ack) return ack;
      return ok({
        identityName: wallet.identityName ?? null,
        iAddress: wallet.iAddress ?? null,
        balance: wallet.balance ?? null,
      });
    })

    .define('VerusWallet.transfer', async (params, ctx) => {
      const destination = str(params.destination).trim();
      if (!destination) return invalid('destination is required');
      const amount = Number(params.amount);
      if (!Number.isFinite(amount) || amount <= 0) return invalid('amount must be a positive number');

      const { wallet, ack } = await resolveWallet(ctx, str(params.agentId));
      if (ack) return ack;

      const sent = await raw(ctx, 'verus:sendCurrency', {
        fromIdentity: wallet.identityName,
        fromIAddress: wallet.iAddress,
        destination,
        amount,
        // The platform reads null as "the chain's native currency"; an empty
        // string is a currency named "".
        currency: str(params.currency).trim() || null,
        memo: str(params.memo).trim() || null,
      });
      if (isAckError(sent)) return sent;
      return ok({ txid: sent.data?.txid ?? null, ...(sent.data ?? {}) });
    });

  return registry;
}
