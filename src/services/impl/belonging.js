// ===========================================================================
// Where a resource lives.
//
// The CMS addresses everything by a BELONGING string, and which one a call
// means is decided by which ids the caller passed — a room and a prop mean the
// prop's shelf, a directory means that directory, an application means that
// app's per-user storage. CMSService resolves it inline; it is here because
// two services need the same answer and one of them (ApplicationStorage) is
// only allowed one of the forms.
// ===========================================================================

/** The staging belonging a paste's link copies are minted under. */
export const TEMP_SESSION = 'uploadSession';

/**
 * The belonging a CMS call addresses.
 * @param {{roomId?: string, propId?: string, directoryId?: string, communityId?: string}} scope
 * @param {{applicationId?: string, userId?: string}} caller
 */
export function resolveBelonging({ roomId, propId, directoryId, communityId }, { applicationId, userId }) {
  if (roomId && propId) return `room:${roomId}/${propId}`;
  if (roomId) return `roomSortingTable:${roomId}`;
  if (directoryId) return `directory:${directoryId}`;
  if (communityId) return `community:${communityId}`;
  // The default: the calling application's own per-user shelf.
  return applicationStorageBelonging(applicationId, userId);
}

/** An application's per-user storage — the only belonging ApplicationStorage uses. */
export const applicationStorageBelonging = (applicationId, userId) =>
  `app:${applicationId}:userSortingTable:${userId}`;
