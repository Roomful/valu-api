// ===========================================================================
// CMS — 3 functions, channel `roomful`. Each one is THREE functions wearing a
// trench coat, and the ids decide which.
//
//   (roomId, propId)                → the prop's content list
//   (communityId, channelId, postId) → the post's attachments
//   anything else                    → a plain belonging (directory, room,
//                                      community, or the app's own shelf)
//
// That is the app's design, not an invention here: CMSService branches on
// exactly these. What this file adds is saying so out loud, and refusing to
// pretend the branches behave alike — `resource-delete` on a prop DETACHES,
// on a post DETACHES, and everywhere else DELETES the resource itself.
// ===========================================================================
import { ok, rpc, raw, str, limit, isAckError, ackErrorMessage, invalid } from './support.js';
import { resolveBelonging, TEMP_SESSION } from './belonging.js';
import { uploadResources, toFileArray } from '../../upload/ResourceUpload.js';
import { findTargetChannel, loadPostByAddress, resolveContentDirectory } from './posts.js';

const isPropScope = (p) => Boolean(p.roomId && p.propId);
const isPostScope = (p) => Boolean(p.communityId && p.channelId && p.postId);

/** `directoryId`, or the content directory the channel points at. */
async function scopeDirectory(ctx, params) {
  if (params.directoryId) return str(params.directoryId);
  if (!params.channelId || isPostScope(params)) return '';
  return resolveContentDirectory(ctx, { communityId: str(params.communityId), channelId: str(params.channelId) });
}

export function register(registry) {
  registry
    .define('CMS.resource-upload', async (params, ctx) => {
      const files = toFileArray(params.files);
      if (!files.length) return invalid('files is required and must not be empty');

      const userId = ctx.socket.selfUserId || ctx.socket.userId || '';
      if (!userId) return invalid('no authenticated user on this socket');

      const prop = isPropScope(params);
      const post = isPostScope(params);
      // A prop or a post takes the files through a TEMP session first: the
      // platform only accepts a move into a prop FROM staging, and a post's
      // attachments are added after the fact. Everything else lands where it
      // belongs on the first try.
      const belonging = prop || post
        ? `${TEMP_SESSION}:${userId}`
        : resolveBelonging({
          roomId: str(params.roomId),
          propId: str(params.propId),
          directoryId: await scopeDirectory(ctx, params),
          communityId: str(params.communityId),
        }, { applicationId: ctx.applicationId, userId });

      const { resolved, failed } = await uploadResources({
        socket: ctx.socket,
        files,
        belonging,
        networkId: ctx.socket.networkId,
        fetchImpl: ctx.fetchImpl,
      });
      if (!resolved.length) return ok({ resolved, failed });

      const resourceIds = resolved.map((r) => r.id);

      if (prop) {
        const moved = await raw(ctx, 'room:changePropContent', {
          roomId: str(params.roomId), propId: str(params.propId), moveToProp: resourceIds,
        });
        // The files ARE uploaded; only the placement failed. Saying which is
        // the difference between "retry the upload" and "retry the move".
        if (isAckError(moved)) {
          return ok({ resolved, failed, placed: null, placementError: ackErrorMessage(moved, 'failed to place the resources into the prop') });
        }
        return ok({ resolved, failed, placed: `room:${params.roomId}/${params.propId}` });
      }

      if (post) {
        const target = await findTargetChannel(ctx, { communityId: str(params.communityId), channelId: str(params.channelId) });
        if (!target) return ok({ resolved, failed, placed: null, placementError: `channel ${params.channelId} is not in community ${params.communityId}` });
        const attached = await raw(ctx, 'channel:addMessageAttachments', {
          channelId: target.originId,
          subChannelId: target.subChannelId,
          messageId: str(params.postId),
          attachmentIds: resourceIds,
        });
        if (isAckError(attached)) {
          return ok({ resolved, failed, placed: null, placementError: ackErrorMessage(attached, 'failed to attach the resources to the post') });
        }
        return ok({ resolved, failed, placed: `post:${params.postId}` });
      }

      return ok({ resolved, failed, placed: belonging });
    })

    .define('CMS.resource-search', async (params, ctx) => {
      // A post is not a belonging: its "resources" are its attachments, which
      // means loading the post and then each attached resource.
      if (isPostScope(params)) {
        const target = await findTargetChannel(ctx, { communityId: str(params.communityId), channelId: str(params.channelId) });
        if (!target) return invalid(`channel ${params.channelId} is not in community ${params.communityId}`);
        const loaded = await loadPostByAddress(ctx, {
          rootChannelId: target.originId, subChannelId: target.subChannelId, postId: str(params.postId),
        });
        if (loaded.error) return { error: loaded.error };

        const resources = [];
        for (const attachment of loaded.post.attachments ?? []) {
          if (!attachment?.resourceId) continue;
          const got = await raw(ctx, 'resource:get', { resource: attachment.resourceId });
          // One unreadable attachment is not the post's whole answer.
          if (!isAckError(got) && got.data?.resource) resources.push(got.data.resource);
        }
        return ok({ resources, hasMore: false, cursor: '' });
      }

      const userId = ctx.socket.selfUserId || ctx.socket.userId || '';
      const belonging = resolveBelonging({
        roomId: str(params.roomId),
        propId: str(params.propId),
        directoryId: await scopeDirectory(ctx, params),
        communityId: str(params.communityId),
      }, { applicationId: ctx.applicationId, userId });

      return rpc(ctx, 'resource:searchBelonging', {
        belonging,
        limit: limit(params.limit, 10),
        query: str(params.query),
        cursor: str(params.cursor),
      }, (data) => ({
        resources: data.resources ?? [],
        hasMore: data.hasMore ?? false,
        cursor: data.nextCursor ?? data.cursor ?? '',
      }));
    })

    .define('CMS.resource-delete', async (params, ctx) => {
      const resourceId = str(params.resourceId);

      // Detach, do not delete: the resource may be in three other props.
      if (isPropScope(params)) {
        return rpc(ctx, 'room:changePropContent', {
          roomId: str(params.roomId), propId: str(params.propId), removeFromProp: [resourceId],
        }, () => ({ detachedFrom: `room:${params.roomId}/${params.propId}` }));
      }

      if (isPostScope(params)) {
        const target = await findTargetChannel(ctx, { communityId: str(params.communityId), channelId: str(params.channelId) });
        if (!target) return invalid(`channel ${params.channelId} is not in community ${params.communityId}`);
        return rpc(ctx, 'channel:deleteMessageAttachments', {
          channelId: target.originId,
          subChannelId: target.subChannelId,
          messageId: str(params.postId),
          attachmentIds: [resourceId],
        }, () => ({ detachedFrom: `post:${params.postId}` }));
      }

      // No scope: the resource itself goes.
      return rpc(ctx, 'resource:delete', { resourceId }, () => ({}));
    });

  return registry;
}
