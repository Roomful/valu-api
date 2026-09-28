// ===========================================================================
// ApplicationStorage — 3 functions, channel `roomful`.
//
// Per-application, per-user file storage. One belonging, always
// (`app:{applicationId}:userSortingTable:{userId}`) — which is the whole
// security model: an app addresses its own shelf and cannot name another's, so
// the application id comes from the HOST (ctx.applicationId), never from
// params.
//
// The upload is the four-step CMS pipeline (src/upload/ResourceUpload.js), not
// a browser-only uploader: register, get a bucket link, PUT, complete.
// ===========================================================================
import { ok, rpc, str, limit, fail, invalid } from './support.js';
import { ERROR_CODES } from '../../Errors.js';
import { applicationStorageBelonging } from './belonging.js';
import { uploadResources, toFileArray } from '../../upload/ResourceUpload.js';

/** The shelf this call may touch, or the 403 that says it has no name. */
function shelf(ctx) {
  const applicationId = ctx.applicationId;
  if (!applicationId) {
    return {
      ack: fail(
        ERROR_CODES.FORBIDDEN,
        'the calling application could not be identified, so its storage was not opened',
        'Application storage is addressed as app:{applicationId}:userSortingTable:{userId}. '
        + 'Pass { applicationId } to the SocketTransport; it is never taken from params.',
      ),
    };
  }
  const userId = ctx.socket.selfUserId || ctx.socket.userId || '';
  if (!userId) return { ack: invalid('no authenticated user on this socket') };
  return { belonging: applicationStorageBelonging(applicationId, userId) };
}

export function register(registry) {
  registry
    .define('ApplicationStorage.resource-upload', async (params, ctx) => {
      const { belonging, ack } = shelf(ctx);
      if (ack) return ack;
      const files = toFileArray(params.files);
      if (!files.length) return invalid('files is required and must not be empty');

      const { resolved, failed } = await uploadResources({
        socket: ctx.socket,
        files,
        belonging,
        networkId: ctx.socket.networkId,
        fetchImpl: ctx.fetchImpl,
      });
      // Partial success is the truth here: five files, one bad, four are up.
      // Both lists are always present so a caller reads one branch.
      return ok({ resolved, failed });
    })

    .define('ApplicationStorage.resource-search', (params, ctx) => {
      const { belonging, ack } = shelf(ctx);
      if (ack) return ack;
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

    // Deletes the RESOURCE. The platform enforces that the caller may — an app
    // cannot delete another app's file by guessing its id.
    .define('ApplicationStorage.resource-delete', (params, ctx) =>
      rpc(ctx, 'resource:delete', { resourceId: str(params.resourceId) }, () => ({})));

  return registry;
}
