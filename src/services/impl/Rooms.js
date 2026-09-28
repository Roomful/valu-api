// ===========================================================================
// Rooms — 15 functions, channel `roomful`. The biggest service, and the one
// the plan warned about twice: it has the most intents, and in the app it is
// the one coupled to UI (`stores[Rooms].openRoomCardByRoomId`).
//
// None of that coupling comes here. What does come is the orchestration that
// is genuinely part of a function's meaning — a prop read is a listProps plus
// a storyline lookup, a paste is a staging session plus a move plus a save —
// and that lives in ./rooms/props.js and ./rooms/paste.js so the functions
// below read as what they are.
//
// Two decisions worth stating out loud:
//
//   The app decorates its answers with `@[room:…]` ENTITY TAGS for the AI to
//   paste. Those are a presentation concern of the caller that talks to a
//   model — the server binding — not of the function, so the SDK answers with
//   ids and names and leaves the tag to the layer that needs one.
//
//   `create-room-from-template` does NOT pay. The result says whether payment
//   is due and what the user must do; a service that could spend money on a
//   user's behalf from a tool call is a different product.
// ===========================================================================
import { ok, rpc, raw, str, num, ids, list, isAckError, ackErrorMessage, invalid, fail } from './support.js';
import { ERROR_CODES } from '../../Errors.js';
import { groupForToolOutput, templateGroupCount, normalizePropTag, planDistribution } from './propGroups.js';
import { loadOrderedProps, loadPropGroups, getPropContent, freshPropNames, saveProp } from './rooms/props.js';
import { pasteIntoProp } from './rooms/paste.js';

/** Prop-invitation permission flags, as the exhibitors modal sends them. */
const DEFAULT_PROP_PERMISSIONS = { view: true, comment: false, contribute: false, edit: false, manage: false };

/** How a group paste hands resources to a group's props. */
const DISTRIBUTIONS = ['spread', 'stack', 'replicate'];

/**
 * A room a template may be built from must carry BOTH tags. Everything else is
 * skipped by design — the Rooms app gallery is unaffected, it lists templates
 * through its own store, not this function.
 */
const REQUIRED_TEMPLATE_TAGS = ['community', 'ai-friendly'];

/** Backend policy: a room from a PAID template is kept only if paid for in time. */
const PAID_ROOM_PAYMENT_WINDOW_MINUTES = 15;

const normalizeTemplateTag = (tag) => normalizePropTag(String(tag ?? '').replace(/^#/, ''));
const isApprovedTemplate = (template) => {
  const tags = new Set((template?.tags ?? []).map(normalizeTemplateTag));
  return REQUIRED_TEMPLATE_TAGS.every((required) => tags.has(required));
};

/** Caller-supplied permissions, flattened to the five flags the server expects. */
function coercePermissions(input) {
  if (!input || typeof input !== 'object') return { ...DEFAULT_PROP_PERMISSIONS };
  return {
    view: input.view != null ? Boolean(input.view) : DEFAULT_PROP_PERMISSIONS.view,
    comment: Boolean(input.comment),
    contribute: Boolean(input.contribute),
    edit: Boolean(input.edit),
    manage: Boolean(input.manage),
  };
}

/** The room's walk first, then the caller's group order, then position in group. */
const navRank = (navIndex) => (Number.isInteger(navIndex) ? navIndex : Number.POSITIVE_INFINITY);
const byNavigation = (a, b) => {
  const ra = navRank(a.prop.navIndex);
  const rb = navRank(b.prop.navIndex);
  if (ra !== rb) return ra < rb ? -1 : 1;
  return (a.groupIndex - b.groupIndex) || (a.propIndex - b.propIndex);
};

export function register(registry) {
  registry
    // --- discovery -------------------------------------------------------
    .define('Rooms.search-rooms', (params, ctx) => rpc(ctx, 'explorer:searchRooms', {
      networkId: ctx.socket.networkId ?? '',
      offset: num(params.offset, 0),
      size: num(params.size, 10),
      query: str(params.query),
    }, (data) => ({ rooms: data.rooms ?? [] })))

    // `invites` is a DIFFERENT RPC answering a different shape — the app's own
    // branch, kept because "rooms I was invited to" is what the filter means.
    .define('Rooms.search-my-rooms', (params, ctx) => {
      const payload = {
        networkId: ctx.socket.networkId ?? '',
        offset: num(params.offset, 0),
        size: num(params.size, 10),
        query: str(params.query),
      };
      if (params.filter === 'invites') {
        return rpc(ctx, 'social:getUserInvitations', payload, (data) => ({
          rooms: (data.invitations ?? []).map((invitation) => ({
            ...(invitation.room ?? {}),
            invitation: invitation.invitation,
          })),
        }));
      }
      return rpc(ctx, 'room:searchRoomsOfUser', { ...payload, filter: str(params.filter, 'all') },
        (data) => ({ rooms: data.rooms ?? [] }));
    })

    .define('Rooms.get-room', (params, ctx) => rpc(ctx, 'room:getRoomBasicModel', {
      roomId: str(params.roomId),
      networkId: str(params.networkId),
    }, (data) => ({ room: data.room ?? data ?? null })))

    .define('Rooms.get-permissions', (params, ctx) =>
      rpc(ctx, 'room:permissions', { roomId: str(params.roomId) },
        (data) => ({ permissions: data.permissions ?? null })))

    // --- props -----------------------------------------------------------
    .define('Rooms.get-room-props', async (params, ctx) => {
      const loaded = await loadOrderedProps(ctx, { roomId: str(params.roomId), networkId: str(params.networkId) });
      if (loaded.error) return { error: loaded.error };
      return ok({ props: loaded.props, propOrder: loaded.propOrder });
    })

    // One prop, read from the same ordered list — so its `navIndex` means the
    // same thing it does in get-room-props.
    .define('Rooms.get-prop', async (params, ctx) => {
      const loaded = await loadOrderedProps(ctx, { roomId: str(params.roomId), networkId: str(params.networkId) });
      if (loaded.error) return { error: loaded.error };
      const propId = str(params.propId);
      return ok({ prop: loaded.props.find((p) => p.id === propId) ?? null, propOrder: loaded.propOrder });
    })

    // The COMPACT view: a template room carries dozens of decorative props
    // (walls, plants, signs) and listing them buries the frames that matter.
    // They are counted, not listed; `groupIds` repeats the ordered ids up
    // front so no group can be overlooked.
    .define('Rooms.get-room-prop-groups', async (params, ctx) => {
      const roomId = str(params.roomId);
      const networkId = str(params.networkId);
      const loaded = await loadPropGroups(ctx, { roomId, networkId });
      if (loaded.error) return { error: loaded.error };
      return ok({
        roomId,
        networkId: networkId || ctx.socket.networkId || '',
        propOrder: loaded.propOrder,
        groupIds: loaded.groups.map((g) => g.id),
        groups: loaded.groups.map(groupForToolOutput),
      });
    })

    // --- prop collaboration ----------------------------------------------
    .define('Rooms.list-prop-team-members', (params, ctx) => rpc(ctx, 'social:getPropInvitations', {
      roomId: str(params.roomId), propId: str(params.propId),
    }, (data) => ({ invitations: data.invitations ?? [] })))

    // The declared param is `invitedUser`; so is the RPC field. The five
    // permission flags are always sent whole — a partial set is read as the
    // absent ones being false.
    .define('Rooms.invite-to-prop', (params, ctx) => rpc(ctx, 'social:inviteToProp', {
      roomId: str(params.roomId),
      propId: str(params.propId),
      invitedUser: str(params.invitedUser),
      permissions: coercePermissions(params.permissions),
      customParams: params.customParams ?? null,
    }, (data) => ({ invitation: data.invitation ?? null })))

    .define('Rooms.delete-prop-invitation', (params, ctx) => rpc(ctx, 'social:deletePropInvitation', {
      roomId: str(params.roomId), propId: str(params.propId), invitedUser: str(params.invitedUser),
    }, () => ({})))

    // --- templates --------------------------------------------------------
    .define('Rooms.list-room-templates', (params, ctx) => {
      const requested = list(params.tags).filter(Boolean).map(String);
      const size = num(params.size, 20);
      // The required tags go to the server too, so paging stays cheap whatever
      // the server's tag semantics — and are re-checked here, because a server
      // that ORs them would otherwise widen the AI's build surface silently.
      const serverTags = [...new Set([...requested, ...REQUIRED_TEMPLATE_TAGS])];
      return rpc(ctx, 'room:listTemplateRooms', {
        offset: num(params.offset, 0), size, query: str(params.query), tags: serverTags, style: '',
      }, (data) => {
        const page = data.templates ?? [];
        const approved = page.filter(isApprovedTemplate);
        return {
          templates: approved.map((t) => ({
            id: t.id,
            name: t.name,
            tags: t.tags ?? [],
            // How many prop groups the template's room has, declared as a
            // "prop-groups_N" tag — so a caller can pick by the number of
            // content sections it needs to fill.
            groupCount: templateGroupCount(t.tags),
            price: t.price || 0,
            isFree: !t.price,
            subscriptionStatus: t.subscriptionStatus || '',
          })),
          hasMore: page.length >= size,
          filteredOutCount: page.length - approved.length,
        };
      });
    })

    .define('Rooms.create-room-from-template', async (params, ctx) => {
      const templateId = str(params.templateId);
      const roomName = str(params.roomName);
      // The price is resolved from the approved LISTING, not from the caller:
      // a create step that never saw the listing (a fresh worker, a resumed
      // run) must not get a paid template refused for a missing plan.
      const listed = await findApprovedTemplate(ctx, templateId);
      const price = Number(listed ? listed.price : num(params.price, 0)) || 0;
      const isPaid = price > 0;

      const ack = await raw(ctx, 'room:createRoomFromTemplate', {
        room: templateId,
        roomName,
        updated: Date.now(),
        // The same field the Rooms UI sends for a priced template: it STARTS
        // the one-time purchase instead of having the server refuse outright.
        ...(isPaid ? { subscriptionPlan: 'one_time_payment' } : {}),
      });
      if (isAckError(ack)) return ack;
      const roomId = ack.data?.roomId;
      if (!roomId) return fail(ERROR_CODES.UNSUPPORTED, 'the template created no room', ackErrorMessage(ack, ''));

      return ok({
        roomId,
        name: roomName,
        // The room was created in the CURRENT network — a fact of this call,
        // more reliable than re-deriving it from the id.
        networkId: ctx.socket.networkId ?? '',
        price,
        isFree: !isPaid,
        paymentRequired: isPaid,
        ...(isPaid ? {
          paymentWindowMinutes: PAID_ROOM_PAYMENT_WINDOW_MINUTES,
          paymentInstructions:
            `This room was created from a paid template ($${price}) and nothing has been paid yet. `
            + `It is kept only if the purchase completes within ${PAID_ROOM_PAYMENT_WINDOW_MINUTES} minutes: `
            + 'in the Valu web app open the Rooms app, open this room and use "Pay for Room".',
        } : {}),
      });
    })

    // --- pastes -----------------------------------------------------------
    .define('Rooms.paste-resources-into-prop', async (params, ctx) => {
      const roomId = str(params.roomId);
      const propId = str(params.propId);
      const resourceIds = ids(params.resourceIds);
      if (!resourceIds.length) return invalid('resourceIds must be a non-empty array of resource ids');

      const loaded = await loadOrderedProps(ctx, { roomId, networkId: str(params.networkId) });
      if (loaded.error) return { error: loaded.error };
      const prop = loaded.props.find((p) => p.id === propId);
      if (!prop) return invalid(`prop ${propId} not found in room ${roomId}`);

      let pasted;
      try {
        pasted = await pasteIntoProp(ctx, prop, {
          roomId,
          resourceIds,
          appendToListEnd: params.appendToListEnd ?? true,
          removeTemplateStubs: params.removeTemplateStubs ?? true,
          networkId: str(params.networkId),
        });
      } catch (error) {
        // A step that failed at the platform kept its ack; a guard that
        // refused the prop (a board, no content type) did not, and 501 is
        // what that is.
        return error?.ack ?? fail(ERROR_CODES.UNSUPPORTED, `${ctx.descriptor.key}: ${error?.message ?? error}`);
      }

      // The prop's name is what it SHOWS, and the paste just changed that —
      // an empty frame was named with its own propId. Re-read it, and keep the
      // pre-paste name when the re-read fails.
      const fresh = await freshPropNames(ctx, { roomId, networkId: str(params.networkId) });
      return ok({ ...pasted, name: fresh.get(propId) ?? prop.name });
    })

    .define('Rooms.paste-resources-into-prop-group', async (params, ctx) => {
      const roomId = str(params.roomId);
      const networkId = str(params.networkId);
      const groupIds = [...new Set(ids(params.groupIds))];
      const resourceIds = ids(params.resourceIds);
      if (!groupIds.length) return invalid('groupIds must be a non-empty array of prop group ids (from get-room-prop-groups)');
      if (!resourceIds.length) return invalid('resourceIds must be a non-empty array of resource ids');
      if (params.distribution !== undefined && !DISTRIBUTIONS.includes(params.distribution)) {
        return invalid(`distribution must be one of: ${DISTRIBUTIONS.join(', ')}`);
      }

      const loaded = await loadPropGroups(ctx, { roomId, networkId });
      if (loaded.error) return { error: loaded.error };

      const byId = new Map(loaded.groups.map((g) => [g.id, g]));
      const unknown = groupIds.filter((id) => !byId.has(id));
      if (unknown.length) {
        return invalid(`unknown prop group id(s) ${unknown.join(', ')} in room ${roomId}. `
          + `Available groups: ${loaded.groups.map((g) => g.id).join(', ') || 'none'}`);
      }
      const selected = groupIds.map((id) => byId.get(id));

      // A LOGO group shows every logo on every frame, so replication is its
      // default; anything else spreads. An explicit value always wins.
      const distribution = params.distribution ?? (selected.every((g) => g.isLogoGroup) ? 'replicate' : 'spread');

      // Content-capable props are the candidates; the ones turned away are
      // reported. Decorative members are never candidates and not worth a line.
      const skippedProps = selected.flatMap((group) => group.props
        .filter((p) => Boolean(p.type?.length) && !p.acceptsContent)
        .map((p) => ({
          propId: p.id, name: p.name, groupId: group.id,
          reason: p.isPresentationBoard ? 'presentation board' : 'cannot hold content',
        })));

      const pool = selected
        .flatMap((group, groupIndex) => group.props.filter((p) => p.acceptsContent)
          .map((prop, propIndex) => ({ prop, groupIndex, propIndex })))
        .sort(byNavigation)
        .map((entry) => entry.prop);

      if (!pool.length) {
        const why = skippedProps.map((s) => `${s.name || s.propId} (${s.reason})`).join('; ');
        return invalid(`no prop in group(s) ${groupIds.join(', ')} can take content${why ? `: ${why}` : ''}`);
      }

      // A top-up must fill the slots still showing template placeholders
      // before it joins slideshows the user already built. Each prop's content
      // is read once here and handed down to its paste.
      const origin = new Map();
      await Promise.all(pool.map(async (prop) => {
        try {
          const content = await getPropContent(ctx, { roomId, propId: prop.id, size: Math.max(prop.contentCount || 0, 50) });
          origin.set(prop.id, { content, hadUserContent: content.some((r) => r && !r.fromTemplate) });
        } catch {
          origin.set(prop.id, { content: undefined, hadUserContent: null });
        }
      }));
      const ordered = [
        ...pool.filter((p) => origin.get(p.id).hadUserContent === false),
        ...pool.filter((p) => origin.get(p.id).hadUserContent !== false),
      ];

      // Sequential: each paste is its own staging session and move, and the
      // order of the pastes is the order the content reads in the room.
      const placements = [];
      const landed = new Set();
      for (const { prop, resourceIds: share } of planDistribution(ordered, resourceIds, distribution)) {
        const { content: preloadedContent, hadUserContent } = origin.get(prop.id);
        const placement = {
          groupId: prop.groupId, propId: prop.id, name: prop.name, navIndex: prop.navIndex,
          hadUserContent, resourceIds: share,
        };
        try {
          const pasted = await pasteIntoProp(ctx, prop, {
            roomId,
            resourceIds: share,
            appendToListEnd: params.appendToListEnd ?? true,
            removeTemplateStubs: params.removeTemplateStubs ?? true,
            networkId,
            preloadedContent,
          });
          const failedIds = new Set(pasted.failed.map((f) => f.resourceId));
          for (const id of share) if (!failedIds.has(id)) landed.add(id);
          placements.push({ ...placement, ...pasted });
        } catch (error) {
          // One prop's failure is not the batch's: the rest are still pasted,
          // and this prop's share is reported unplaced.
          placements.push({
            ...placement, addedResourceIds: [], failed: [], skippedAlreadyPresent: [],
            removedTemplateStubs: [], sliderEnabled: false, titleCleared: false,
            error: error?.message ?? String(error),
          });
        }
      }

      // A content prop never carries a title — the section's name lives on its
      // sign. The pasted props were cleared by their own post-paste save;
      // every other content prop of the selected groups is cleared here.
      const pastedIds = new Set(placements.map((p) => p.propId));
      const clearedTitlePropIds = placements.filter((p) => p.titleCleared).map((p) => p.propId);
      const titleClearErrors = placements.filter((p) => p.titleClearError)
        .map((p) => ({ propId: p.propId, error: p.titleClearError }));
      for (const prop of pool.filter((p) => !pastedIds.has(p.id))) {
        try {
          const { saved } = await saveProp(ctx, {
            roomId,
            propId: prop.id,
            what: 'title cleanup',
            patch: (row) => (String(row.title ?? '').trim() ? { title: '' } : null),
          });
          if (saved) clearedTitlePropIds.push(prop.id);
        } catch (error) {
          titleClearErrors.push({ propId: prop.id, error: error?.message ?? String(error) });
        }
      }

      const fresh = await freshPropNames(ctx, { roomId, networkId });
      return ok({
        roomId,
        groupIds,
        distribution,
        placements: placements.map((p) => ({ ...p, name: fresh.get(p.propId) ?? p.name })),
        clearedTitlePropIds,
        ...(titleClearErrors.length ? { titleClearErrors } : {}),
        unplacedResourceIds: [...new Set(resourceIds)].filter((id) => !landed.has(id)),
        // Already on their target prop — a repeat after a timeout, a resumed
        // run. Counted as placed, not pasted twice.
        skippedAlreadyPresent: [...new Set(placements.flatMap((p) => p.skippedAlreadyPresent ?? []))],
        eligiblePropCount: pool.length,
        skippedProps,
      });
    })

    // Names a group by retitling its section SIGNS. Content props are never
    // touched: they carry no title (a paste clears any they had), so writing
    // one here would be undone by the next paste and would meanwhile caption
    // every frame with the section's name.
    .define('Rooms.rename-prop-group', async (params, ctx) => {
      const roomId = str(params.roomId);
      const groupId = str(params.groupId);
      const name = str(params.name).trim();
      if (!name) return invalid('name must be a non-empty string');

      const loaded = await loadPropGroups(ctx, { roomId, networkId: str(params.networkId) });
      if (loaded.error) return { error: loaded.error };
      const group = loaded.groups.find((g) => g.id === groupId);
      if (!group) {
        return invalid(`unknown prop group id ${groupId} in room ${roomId}. `
          + `Available groups: ${loaded.groups.map((g) => g.id).join(', ') || 'none'}`);
      }

      const renamedLabelPropIds = [];
      const failed = [];
      for (const { propId } of group.labels) {
        try {
          await saveProp(ctx, { roomId, propId, patch: () => ({ title: name }), what: 'rename' });
          renamedLabelPropIds.push(propId);
        } catch (error) {
          failed.push({ propId, error: error?.message ?? String(error) });
        }
      }
      // A group with no sign has nothing to rename, and saying so beats
      // reporting a success that changed nothing.
      return ok({ roomId, groupId: group.id, name, hasLabels: group.labels.length > 0, renamedLabelPropIds, failed });
    });

  return registry;
}

/**
 * Find a template in the AI-approved listing, paging a few pages, so the
 * create step never depends on the caller remembering a price. Best-effort:
 * null when it is not there or the listing fails, and the caller's own `price`
 * is the fallback.
 */
async function findApprovedTemplate(ctx, templateId) {
  const size = 50;
  for (let offset = 0; offset < size * 4; offset += size) {
    const ack = await ctx.socket.emit('room:listTemplateRooms', {
      offset, size, query: '', tags: REQUIRED_TEMPLATE_TAGS, style: '',
    }, ctx.timeoutMs);
    if (isAckError(ack)) return null;
    const page = (ack.data?.templates ?? []).filter(isApprovedTemplate);
    const hit = page.find((t) => t.id === templateId);
    if (hit) return hit;
    if ((ack.data?.templates ?? []).length < size) return null;
  }
  return null;
}
