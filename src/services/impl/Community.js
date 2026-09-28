// ===========================================================================
// Community — 4 functions, channel `roomful`.
//
// All four were already server tools. Two notes carried over from them:
//
//   get-community-info uses `community:getInfoAndSubscribe`, which SUBSCRIBES
//   the caller as a side effect. That is what the app does and what the name
//   says; it is a read with a subscription, not a pure read.
//
//   get-channels stamps `rootChannelId` onto every channel. Sub-channels are
//   addressed as (rootChannelId, subChannelId), and a caller that only kept
//   `channelId` cannot reconstruct which root it came from.
// ===========================================================================
import { rpc, str, limit } from './support.js';

export function register(registry) {
  registry
    .define('Community.search-communities', (params, ctx) => rpc(ctx, 'community:searchOpenCommunities', {
      query: str(params.query),
      limit: limit(params.limit, 10),
      afterCommunityId: str(params.afterCommunityId),
    }, (data) => ({ communities: data.communities ?? [] })))

    .define('Community.get-community-info', (params, ctx) =>
      rpc(ctx, 'community:getInfoAndSubscribe', { communityId: str(params.communityId) },
        (data) => ({ community: data.community ?? null })))

    .define('Community.get-channels', (params, ctx) => {
      const communityId = str(params.communityId);
      return rpc(ctx, 'community:searchCommunityChannels', {
        communityId,
        limit: limit(params.limit, 100),
      }, (data) => ({
        communityId,
        channels: (data.channels ?? []).map((ch) => ({ ...ch, rootChannelId: ch.channelId })),
      }));
    })

    .define('Community.get-posts', (params, ctx) => {
      const channelId = str(params.channelId);
      const subChannelId = str(params.subChannelId);
      const communityId = str(params.communityId);
      return rpc(ctx, 'channel:listMessagesWithEngagement', {
        channelId,
        subChannelId,
        limit: limit(params.limit, 10),
        afterMessageId: str(params.afterMessageId),
      }, (data) => ({
        rootChannelId: channelId,
        messages: data.messages ?? [],
        // Echoed back so a caller can address the next page — and build an
        // entity link — without having kept the request.
        ...(communityId ? { communityId } : {}),
        ...(subChannelId ? { subChannelId } : {}),
      }));
    });

  return registry;
}
