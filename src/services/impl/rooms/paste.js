// ===========================================================================
// Placing existing CMS resources into a prop.
//
// This mirrors the CMS content explorer's copy-paste flow EXACTLY, and every
// step of it exists because the shorter version does not work:
//
//   · Link copies are STAGED in a temp upload session and then moved. Linking
//     straight under the prop's own belonging and moving from there is refused
//     by the backend with "Invalid prop resources" — a move must come FROM
//     staging.
//   · Template stubs (`fromTemplate` on the resource) are removed first, so a
//     room copied from a template does not mix placeholder art into the
//     result.
//   · The paste is IDEMPOTENT. Pasting is additive and a paste that timed out
//     on the caller's side may well have landed here (2026-09-15: two logos
//     replicated onto four groups, then a retry pasted them all again). A
//     resource already on the prop — the original, or a link copy of it,
//     which carries `linkId` — is skipped and reported, not copied twice.
//   · A presentation (screen-share) board is refused up front: it holds
//     content technically, and is reserved for live sharing.
//   · One post-paste save turns the content slider on for a slideshow and
//     CLEARS the prop's title, because a content prop carries no caption —
//     the section's name lives on its sign (see rename-prop-group).
//
// Everything after the move is fail-SOFT and reported: the content is placed,
// and a failed cosmetic save must not read as a failed paste.
// ===========================================================================
import { isAckError, ackErrorMessage } from '../../../socket/ValuSocket.js';
import { createUploadSession } from '../../../upload/ResourceUpload.js';
import { getPropContent, saveProp } from './props.js';

/**
 * Throw, but keep the platform's own ack on the error.
 *
 * A paste is several RPCs and only the caller can decide whether a failure is
 * fatal, so the steps throw. Flattening the ack to a message on the way out
 * would lose the code the caller switches on — "the room is gone" and "you may
 * not edit this prop" would arrive as the same 501.
 */
const throwAck = (ack, fallback) => {
  throw Object.assign(new Error(ackErrorMessage(ack, fallback)), { ack });
};

/**
 * Paste into a prop that has already been read through `loadOrderedProps`.
 *
 * Throws only when NOTHING landed — a caller of the group paste catches that
 * per prop and carries on with the rest.
 *
 * @param {object} prop An enriched prop.
 * @param {object} options
 * @param {object[]} [options.preloadedContent] The group paste reads every
 *   prop's content up front to order the pool; handing it down saves a call.
 */
export async function pasteIntoProp(ctx, prop, {
  roomId, resourceIds, appendToListEnd = true, removeTemplateStubs = true, networkId = '', preloadedContent,
}) {
  const propId = prop.id;
  if (!prop.type?.length) throw new Error(`prop ${propId} ("${prop.name}") cannot hold content`);
  if (prop.isPresentationBoard) {
    throw new Error(
      `prop ${propId} ("${prop.name}") is a presentation (screen-share) board — it is reserved for live `
      + 'screen sharing, not pasted content. Pick a prop with thumbnailCount > 0 that is not a board.',
    );
  }

  // What the prop already holds, read ONCE and used for both the stub cleanup
  // and the duplicate skip. Fail-soft: an unreadable list disables both.
  let content = null;
  let contentReadError = null;
  let existingCount = prop.contentCount || 0;
  try {
    content = preloadedContent ?? await getPropContent(ctx, { roomId, propId, size: Math.max(existingCount, 50) });
    existingCount = content.length;
  } catch (error) {
    contentReadError = error?.message ?? String(error);
  }

  // A link resource carries `linkId` = the original it points at, so a repeat
  // is recognised whichever form is already there. Template stubs never count.
  const present = new Set(
    (content ?? []).filter((r) => r && !r.fromTemplate).map((r) => r.linkId || r.id).filter(Boolean),
  );
  const requested = [...new Set(resourceIds.map(String))];
  const skippedAlreadyPresent = requested.filter((id) => present.has(id));
  const toPaste = requested.filter((id) => !present.has(id));

  let removedTemplateStubs = [];
  let stubCleanupError = contentReadError;
  if (removeTemplateStubs && content) {
    try {
      const stubIds = content.filter((r) => r?.fromTemplate).map((r) => r.id);
      if (stubIds.length) {
        const removal = await ctx.socket.emit('room:changePropContent', { roomId, propId, removeFromProp: stubIds }, ctx.timeoutMs);
        if (isAckError(removal)) throwAck(removal, 'failed to remove the template stub content');
        removedTemplateStubs = stubIds;
        existingCount -= stubIds.length;
      }
    } catch (error) {
      stubCleanupError = error?.message ?? String(error);
    }
  }

  if (!toPaste.length) {
    // Everything asked for is already there: no copies, no move, no save. A
    // repeated paste is a no-op by design.
    return {
      roomId, propId, addedResourceIds: [], failed: [], removedTemplateStubs, skippedAlreadyPresent,
      alreadyPresent: true, sliderEnabled: false, titleCleared: false,
      ...(stubCleanupError ? { stubCleanupError } : {}),
    };
  }

  const userId = ctx.socket.selfUserId || ctx.socket.userId;
  if (!userId) throw new Error('no authenticated user for the upload session');
  const belonging = await createUploadSession(ctx.socket, userId);
  const network = networkId || ctx.socket.networkId || '';

  // Sequential, so the link ids keep the caller's display order — which is the
  // order the content reads in the room.
  const addedResourceIds = [];
  const failed = [];
  for (const resourceId of toPaste) {
    const ack = await ctx.socket.emit('resource:createLinkResource', { resource: resourceId, belonging, networkId: network }, ctx.timeoutMs);
    const linkId = ack.data?.resource?.id ?? ack.data?.resources?.[0]?.id;
    if (isAckError(ack) || !linkId) failed.push({ resourceId, error: ackErrorMessage(ack, 'failed to copy the resource') });
    else addedResourceIds.push(linkId);
  }

  if (!addedResourceIds.length) {
    throw new Error(`none of the resources could be copied: ${failed.map((f) => `${f.resourceId} (${f.error})`).join('; ')}`);
  }

  const change = await ctx.socket.emit('room:changePropContent', { roomId, propId, moveToProp: addedResourceIds, appendToListEnd }, ctx.timeoutMs);
  if (isAckError(change)) throwAck(change, 'failed to place the resources into the prop');

  // Unity's PropThumbnail only cycles when ContentSlider is set, and never for
  // a container — the same condition Unity itself auto-slides on.
  const total = existingCount + addedResourceIds.length;
  const finish = await finishPastedProp(ctx, {
    roomId, propId, enableSlider: total > 1 && prop.invokeType !== 'Container',
  });

  return {
    roomId, propId, addedResourceIds, failed, removedTemplateStubs, skippedAlreadyPresent,
    sliderEnabled: finish.sliderEnabled,
    titleCleared: finish.titleCleared,
    ...(finish.sliderError ? { sliderError: finish.sliderError } : {}),
    ...(finish.titleClearError ? { titleClearError: finish.titleClearError } : {}),
    ...(stubCleanupError ? { stubCleanupError } : {}),
  };
}

/**
 * The one save that follows a paste: slider on when it is now a slideshow, and
 * the title cleared. Nothing to change → no save at all. Never throws — the
 * paste already succeeded, and these are cosmetics.
 */
export async function finishPastedProp(ctx, { roomId, propId, enableSlider }) {
  try {
    const { prop, saved } = await saveProp(ctx, {
      roomId,
      propId,
      what: 'post-paste cleanup',
      patch: (raw) => {
        const changes = {};
        if (enableSlider && !raw.customParams?.ContentSlider) {
          changes.customParams = { ...(raw.customParams || {}), ContentSlider: true };
        }
        if (String(raw.title ?? '').trim()) changes.title = '';
        return Object.keys(changes).length ? changes : null;
      },
    });
    return {
      sliderEnabled: enableSlider && (saved || Boolean(prop.customParams?.ContentSlider)),
      titleCleared: saved && Boolean(String(prop.title ?? '').trim()),
    };
  } catch (error) {
    const message = error?.message ?? String(error);
    return {
      sliderEnabled: false,
      titleCleared: false,
      ...(enableSlider ? { sliderError: message } : {}),
      titleClearError: message,
    };
  }
}
