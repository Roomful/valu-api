// ===========================================================================
// Reading a room's props, in the order the room is actually walked.
//
// Three of the Rooms functions and both pastes start from the same question —
// what is in this room, in what order — so it is answered once, here.
//
// THE ORDER IS NOT THE LIST'S ORDER. `room:listProps` answers in props-group
// order, but Room Settings → Navigation can override Next/Previous with a
// STORYLINE, and when it does, that storyline's frame order IS the room's prop
// order. The override is a room custom param, lowercased by the Unity client
// on write, so it arrives as `storyline.overridenextpreviousstoryid`.
// ===========================================================================
import { isAckError, ackErrorMessage } from '../../../socket/ValuSocket.js';
import { propDisplayName, propGroupId, groupProps } from '../propGroups.js';

/** The custom param that names the Next/Previous storyline. */
const NEXT_PREV_STORYLINE_PARAM = 'storyline.overridenextpreviousstoryid';

/** An asset tag marks a presentation (screen-share) board — never a paste target. */
const isPresentationBoardAsset = (asset) =>
  (asset?.tags ?? []).some((tag) => String(tag).toLowerCase() === 'presentationboard');

/** An asset tag containing "text" marks a Text prop — a section SIGN. */
const isTextPropAsset = (asset) =>
  (asset?.tags ?? []).some((tag) => String(tag).toLowerCase().includes('text'));

/**
 * The ordered prop ids a room's Next/Previous storyline walks.
 *
 * Each story's `data` is a JSON string whose frames carry `propId` (absent on
 * room-section frames, which the walk skips); a prop in several frames keeps
 * its first position. Returns null to fall back to props-group order — no
 * override, the story is gone, or its data will not parse.
 */
export function storylinePropRoute(room) {
  const params = room?.settings?.params;
  if (!params || typeof params !== 'object') return null;

  const key = Object.keys(params).find((k) => k.toLowerCase() === NEXT_PREV_STORYLINE_PARAM);
  const storyId = key ? String(params[key] ?? '') : '';
  if (!storyId) return null;

  const story = (Array.isArray(room?.stories) ? room.stories : []).find((s) => s?.id === storyId);
  if (!story) return null;

  let frames = [];
  try {
    const data = typeof story.data === 'string' ? JSON.parse(story.data) : story.data;
    frames = Array.isArray(data?.frames) ? data.frames : [];
  } catch {
    return null;
  }

  const propIds = [];
  for (const frame of frames) {
    const propId = typeof frame?.propId === 'string' ? frame.propId : '';
    if (propId && !propIds.includes(propId)) propIds.push(propId);
  }
  return propIds.length ? { storylineId: storyId, storylineTitle: String(story.title ?? ''), propIds } : null;
}

/**
 * Prop asset definitions, cached per call.
 *
 * The board/text markers only exist on the full asset, so a room of 50 props
 * over 6 asset types is 6 lookups rather than 50. Asset definitions do not
 * change at runtime; a FAILED lookup is not cached, so the next call retries.
 */
function assetLoader(ctx) {
  const cache = new Map();
  return (assetId) => {
    if (!assetId) return Promise.resolve(null);
    if (cache.has(assetId)) return cache.get(assetId);
    const request = ctx.socket.emit('asset:getPropAsset', { assetId }, ctx.timeoutMs).then((ack) => {
      const asset = isAckError(ack) ? null : (ack.data?.asset ?? null);
      if (!asset) cache.delete(assetId);
      return asset;
    });
    cache.set(assetId, request);
    return request;
  };
}

/**
 * A room's props, enriched and in navigation order, plus where that order came
 * from.
 *
 * `room:getRoom` rides along for the storyline override. A FAILED room fetch
 * degrades to props-group order rather than failing the call — the props are
 * still the answer to the question that was asked.
 *
 * @returns {Promise<{props: object[], propOrder: object}|{error: object}>}
 */
export async function loadOrderedProps(ctx, { roomId, networkId = '' }) {
  const [listAck, roomAck] = await Promise.all([
    ctx.socket.emit('room:listProps', { roomId, networkId }, ctx.timeoutMs),
    ctx.socket.emit('room:getRoom', { roomId, networkId }, ctx.timeoutMs),
  ]);
  if (isAckError(listAck)) return { error: listAck.error };

  const net = networkId || ctx.socket.networkId || '';
  const getAsset = assetLoader(ctx);

  const enriched = await Promise.all((listAck.data?.props ?? []).map(async (p) => {
    const asset = await getAsset(p.assetId);
    const tags = p.tags ?? [];
    return {
      id: p.id,
      // What the prop SHOWS. A content prop carries no title of its own, so
      // `title || assetTitle || id` names a filled frame with its propId.
      name: propDisplayName(p),
      assetTitle: p.assetTitle || '',
      title: p.title || '',
      type: p.assetAttributes?.contentType || '',
      tags,
      groupId: propGroupId(tags),
      contentCount: p.contentCount || 0,
      assetId: p.assetId || '',
      thumbnailCount: p.assetAttributes?.thumbnailCount || 0,
      logoCount: p.assetAttributes?.logoCount || 0,
      invokeType: p.assetAttributes?.invokeType || '',
      // true/false when the asset resolved; null = the lookup failed, which
      // fails OPEN — the backend still owns the final word.
      isPresentationBoard: asset ? isPresentationBoardAsset(asset) : null,
      isTextProp: asset ? isTextPropAsset(asset) : null,
      roomId,
      networkId: net,
    };
  }));

  const route = isAckError(roomAck) ? null : storylinePropRoute(roomAck.data);
  if (!route) {
    return {
      props: enriched.map((p, i) => ({ ...p, navIndex: i })),
      propOrder: { source: 'props-group' },
    };
  }

  const position = new Map(route.propIds.map((id, i) => [id, i]));
  const onRoute = enriched.filter((p) => position.has(p.id))
    .sort((a, b) => position.get(a.id) - position.get(b.id));
  const offRoute = enriched.filter((p) => !position.has(p.id));
  return {
    // Props the storyline does not visit keep navIndex null: they exist, but
    // they are not on the walk, and a distribution must not pretend they are.
    props: [...onRoute.map((p, i) => ({ ...p, navIndex: i })), ...offRoute.map((p) => ({ ...p, navIndex: null }))],
    propOrder: { source: 'storyline', storylineId: route.storylineId, storylineTitle: route.storylineTitle },
  };
}

/** The same props, grouped by their whole tag set. */
export async function loadPropGroups(ctx, scope) {
  const loaded = await loadOrderedProps(ctx, scope);
  if (loaded.error) return loaded;
  return { ...loaded, groups: groupProps(loaded.props) };
}

/** A prop's current content list. Throws so the caller decides if that is fatal. */
export async function getPropContent(ctx, { roomId, propId, size = 50 }) {
  const ack = await ctx.socket.emit('room:getPropContent', { roomId, propId, offset: 0, size }, ctx.timeoutMs);
  // The platform's own ack rides on the error: a caller that catches this
  // decides with the real code, not with a flattened sentence.
  if (isAckError(ack)) throw Object.assign(new Error(ackErrorMessage(ack, 'failed to load the prop content')), { ack });
  return ack.data?.content ?? [];
}

/** Fresh display names per propId, straight from `room:listProps`. */
export async function freshPropNames(ctx, { roomId, networkId = '' }) {
  const names = new Map();
  const ack = await ctx.socket.emit('room:listProps', { roomId, networkId }, ctx.timeoutMs);
  // Fail-soft: an empty index leaves the caller's pre-paste labels alone. A
  // silent empty index would otherwise look exactly like a room of empty props.
  if (isAckError(ack)) return names;
  for (const prop of ack.data?.props ?? []) names.set(prop.id, propDisplayName(prop));
  return names;
}

/**
 * The full-object prop save.
 *
 * `room:updateProp` REPLACES the prop, so it is re-read and sent back WHOLE
 * with only `patch(prop)` merged in. Dropping a field here silently clears it
 * on the prop; the field list mirrors the CMS editor's own save.
 *
 * @param {(prop: object) => object|null} patch null to skip the save entirely.
 * @returns {Promise<{prop: object, saved: boolean}>}
 */
export async function saveProp(ctx, { roomId, propId, patch, what = 'update' }) {
  const read = await ctx.socket.emit('room:getProp', { roomId, propId }, ctx.timeoutMs);
  const prop = read.data?.prop;
  if (!prop) throw Object.assign(new Error(ackErrorMessage(read, `failed to load prop ${propId} for the ${what}`)), { ack: read });

  const changes = patch(prop);
  if (!changes) return { prop, saved: false };

  const update = await ctx.socket.emit('room:updateProp', {
    roomId,
    styleId: prop.styleId,
    panelId: prop.panelId,
    prop: {
      id: prop.id,
      mobileGeometry: prop.mobileGeometry,
      title: prop.title,
      description: prop.description,
      tags: prop.tags,
      propTypes: prop.propTypes,
      parentId: prop.parentId,
      actionType: prop.actionType,
      webLink: prop.webLink,
      webTitle: prop.webTitle,
      isInteractive: prop.isInteractive,
      showType: prop.showType,
      contentSorting: prop.contentSorting,
      contentAppend: prop.contentAppend,
      isAllowTextchat: prop.isAllowTextchat,
      allowUserParams: prop.allowUserParams,
      actions: prop.actions,
      dataBound: prop.dataBound,
      assetId: prop.assetId,
      customParams: prop.customParams || {},
      ...changes,
    },
  }, ctx.timeoutMs);
  if (isAckError(update)) throw Object.assign(new Error(ackErrorMessage(update, `failed to save prop ${propId} (${what})`)), { ack: update });
  return { prop, saved: true };
}
