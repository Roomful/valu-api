// ===========================================================================
// Addressing a community post.
//
// A post is addressed by (rootChannelId, subChannelId, messageId) — but a
// caller has a `channelId`, and that id may be either a root channel or a
// sub-channel nested arbitrarily deep. Resolving which costs a channel list
// plus a nested sub-channel list per root channel, so it is done once, here,
// and shared by the three CMS functions that need it.
//
// Ported from valusocial-web/src/Applications/CommunityApplication/Stores/
// PostUtility.js.
// ===========================================================================
import { isAckError } from '../../socket/ValuSocket.js';

const findSubChannel = (subChannels, target) => {
  for (const subChannel of subChannels ?? []) {
    if (subChannel.subChannelId === target) return subChannel;
    const found = findSubChannel(subChannel.subChannels, target);
    if (found) return found;
  }
  return null;
};

/**
 * Resolve a channel id to the (root, sub) pair the message RPCs address by.
 * @returns {Promise<{originId: string, subChannelId: string}|null>} null when
 *   the channel is not in the community at all.
 */
export async function findTargetChannel(ctx, { communityId, channelId }) {
  const channels = await ctx.socket.emit('community:searchCommunityChannels', { communityId, limit: 100 }, ctx.timeoutMs);
  if (isAckError(channels)) return null;

  for (const root of channels.data?.channels ?? []) {
    if (root.channelId === channelId) return { originId: root.channelId, subChannelId: '' };

    const subs = await ctx.socket.emit('channel:listSubChannels', {
      channelId: root.channelId, parentSubChannelId: '', fetchNested: true,
    }, ctx.timeoutMs);
    if (isAckError(subs)) continue;

    const found = findSubChannel(subs.data?.subChannels, channelId);
    if (found) return { originId: root.channelId, subChannelId: found.subChannelId };
  }
  return null;
}

/** One post, by an already-resolved address. */
export async function loadPostByAddress(ctx, { rootChannelId, subChannelId = '', postId }) {
  const ack = await ctx.socket.emit('channel:listMessagesWithEngagement', {
    channelId: rootChannelId, subChannelId, messageId: postId, direction: 'single', limit: 1,
  }, ctx.timeoutMs);
  if (isAckError(ack)) return { error: ack.error };
  const post = ack.data?.messages?.[0];
  return post ? { post } : { error: { status: true, message: `post ${postId} not found` } };
}

/**
 * The channel that holds a community channel's uploaded content.
 *
 * A channel's files do not live under the channel id: they live in its
 * `contentDirectoryId`. CMSService resolves it by walking the community's
 * channels, and falls back to the channel id itself when the channel declares
 * no content directory.
 */
export async function resolveContentDirectory(ctx, { communityId, channelId }) {
  if (!communityId || !channelId) return channelId || '';
  const channels = await ctx.socket.emit('community:searchCommunityChannels', { communityId, limit: 100 }, ctx.timeoutMs);
  if (isAckError(channels)) return channelId;

  for (const root of channels.data?.channels ?? []) {
    if (root.channelId === channelId) return root.contentDirectoryId || channelId;
    if ((root.subChannelCount ?? 0) > 0) {
      const subs = await ctx.socket.emit('channel:listSubChannels', {
        channelId: root.channelId, parentSubChannelId: '', fetchNested: true,
      }, ctx.timeoutMs);
      if (isAckError(subs)) continue;
      const found = findSubChannel(subs.data?.subChannels, channelId);
      if (found) return found.contentDirectoryId || channelId;
    }
  }
  return channelId;
}
