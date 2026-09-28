// ===========================================================================
// Profile — 2 functions, channel `roomful`.
//
// Read-only public profile artifacts. The backing RPCs enforce visibility
// against the authenticated user, so neither of these can show what the caller
// could not already see in the Profile UI.
// ===========================================================================
import { rpc, str } from './support.js';

export function register(registry) {
  registry
    // Credentials are the attestation claims of type 'credential'. The filter
    // is client-side because the RPC returns the whole claim map keyed by id —
    // and the REVOKED rule matters: a revoked credential stays visible to its
    // owner and to nobody else, which is what the Profile UI does.
    .define('Profile.get-user-credentials', (params, ctx) => {
      const userId = str(params.userId);
      const status = str(params.status);
      const isSelf = userId === (ctx.socket.selfUserId || ctx.socket.userId);
      return rpc(ctx, 'verus:listAttestationBlocksForUser', { targetUser: userId }, (data) => ({
        credentials: Object.values(data.claims ?? {}).filter((claim) => {
          if (claim?.attestationType !== 'credential') return false;
          if (claim?.status === 'Revoked' && !isSelf) return false;
          if (status && claim?.status !== status) return false;
          return true;
        }),
      }));
    })

    .define('Profile.get-user-badges', (params, ctx) => rpc(ctx, 'user:listBadgesAssignedToUser', {
      targetUser: str(params.userId),
      // 'all' spans every network the caller shares with the target — the
      // app's default, and the only sensible one for a profile read.
      networkId: str(params.networkId, 'all'),
    }, (data) => ({ badges: data.badges ?? [] })));

  return registry;
}
