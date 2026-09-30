// ===========================================================================
// Events — 3 functions, channel `roomful`.
//
// The two sides of the calendar disagreed, and Phase 2 had to pick one. The
// app's declared params are a RANGE (`range`, `startDate`, `filter`, `id`);
// the server tool takes an explicit `start`/`end` window. The manifest is the
// SDK's contract, so the range form wins and the window is computed here
// exactly as EventsService.#computeDateRange computes it — which is also why
// `list-events` has no required param: "this month" is the default question.
//
// Colours cross the wire as rgba floats and come back the same way; every
// caller-facing colour in this file is `#RRGGBB`. Getting that backwards
// paints a meeting black, which is a bug nobody reads as one.
// ===========================================================================
import { ok, fail, raw, rpc, str, ids, isAckError, invalid } from './support.js';
import { ERROR_CODES } from '../../Errors.js';

/** Meeting source types, as EventsStore declares them. */
const MEETING_TYPES = ['room', 'group', 'community', 'direct'];

/** Which meeting type each `list-events` filter selects. */
const FILTER_TO_SOURCE = { room: 'room', group: 'group', community: 'community', user: 'direct' };

/** EventsStore.DEFAULT_COLORS_BY_MEETING_TYPE (EventsStore.js:61-66), as hex. */
const DEFAULT_COLORS = {
  direct: '#B6F0A1', group: '#e173f7', room: '#4299f5', community: '#d5ff7a',
};

const HEX = /^#[0-9a-f]{6}$/i;

export const hexToRgba = (hex) => {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
};

export const rgbaToHex = (rgba) => {
  if (!rgba || typeof rgba !== 'object') return null;
  const byte = (v) => Math.max(0, Math.min(255, Math.round((Number(v) || 0) * 255)));
  return `#${[rgba.r, rgba.g, rgba.b].map((v) => byte(v).toString(16).padStart(2, '0')).join('')}`;
};

/**
 * The inclusive window a range name means, anchored on a date.
 * Ported verbatim from EventsService.#computeDateRange — a window that differs
 * by a day silently drops the meetings on its edge.
 */
export function computeDateRange(anchor, range) {
  const start = new Date(anchor);
  const end = new Date(anchor);
  switch (range) {
    case 'day':
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;
    case 'week': {
      start.setDate(start.getDate() - start.getDay());
      start.setHours(0, 0, 0, 0);
      end.setTime(start.getTime());
      end.setDate(start.getDate() + 6);
      end.setHours(23, 59, 59, 999);
      break;
    }
    case 'year':
      start.setMonth(0, 1);
      start.setHours(0, 0, 0, 0);
      end.setMonth(11, 31);
      end.setHours(23, 59, 59, 999);
      break;
    case 'month':
    default:
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      end.setMonth(end.getMonth() + 1, 0);
      end.setHours(23, 59, 59, 999);
      break;
  }
  return { start, end };
}

/**
 * One raw occurrence, as a calendar event.
 *
 * Go serializes untagged struct fields in PascalCase, so the same field
 * arrives under two spellings depending on the backend path — and an
 * occurrence id built from the wrong one does not match the card the user
 * clicked. Both spellings are read, exactly as MeetingsSocketAPI does.
 */
export function parseOccurrence(m) {
  const meetingId = m.meetingId || m.seriesId || m.id;
  const originalStartDate = m.originalStartDate || m.OriginalStartDate || m.startDate;
  return {
    id: m.occurrenceId || `${meetingId}_${originalStartDate}`,
    meetingId,
    title: m.subject ?? m.name ?? '',
    description: m.description || '',
    startDate: m.startDate,
    endDate: m.endDate,
    type: m.sourceType || '',
    color: rgbaToHex(m.color),
    participants: m.participantIds ?? [],
    isCanceled: Boolean(m.isCanceled || m.isCancelled || m.IsCancelled),
  };
}

/**
 * The window to ask the calendar for.
 *
 * Two forms. `startDate` + `endDate` is an EXPLICIT window, used verbatim —
 * that is the param this package adds (scripts/extensions.js), because "the
 * next three weeks" is not a named range and a server agent is asked for it.
 * Otherwise the named `range` is computed around the anchor, exactly the way
 * EventsService.#computeDateRange computes it.
 */
function resolveWindow(params, now) {
  const anchor = params.startDate ? new Date(params.startDate) : now;
  if (Number.isNaN(anchor.getTime())) return null;
  if (params.endDate) {
    const end = new Date(params.endDate);
    if (Number.isNaN(end.getTime())) return null;
    if (end < anchor) return null;
    return { start: anchor, end };
  }
  return computeDateRange(anchor, str(params.range, 'month'));
}

/** Round up to the next quarter hour — the app's default meeting start. */
function nextQuarterHour(now) {
  const start = new Date(now);
  const remainder = start.getMinutes() % 15;
  if (remainder !== 0) start.setMinutes(start.getMinutes() + (15 - remainder));
  start.setSeconds(0, 0);
  return start;
}

export function register(registry) {
  registry
    .define('Events.list-events', (params, ctx) => {
      const window = resolveWindow(params, ctx.now?.() ?? new Date());
      if (!window) {
        return Promise.resolve(invalid('startDate/endDate must be dates, and endDate must not precede startDate'));
      }

      const source = FILTER_TO_SOURCE[str(params.filter, 'all')];
      const payload = {
        startDate: window.start.toISOString(),
        endDate: window.end.toISOString(),
        // 'all' asks for everything; anything else narrows to one source type,
        // and an `id` narrows further to one room/group/community/person.
        ...(source ? { sourceType: source } : {}),
        ...(source && params.id ? { sourceIds: [str(params.id)] } : {}),
      };

      return rpc(ctx, 'meeting:listMeetingOccurrences', payload, (data) => ({
        events: (data.meetings ?? [])
          .map(parseOccurrence)
          .sort((a, b) => new Date(a.startDate) - new Date(b.startDate)),
      }));
    })

    .define('Events.create-meeting', async (params, ctx) => {
      const type = str(params.type);
      if (!MEETING_TYPES.includes(type)) {
        return invalid(`type must be one of: ${MEETING_TYPES.join(', ')}`);
      }
      const participants = ids(params.participants);

      // The source a meeting hangs off. `direct` sources on the invitees, and
      // on the organiser alone when there are none — the backend assumes
      // sourceIds is never empty (EventsStore.createSocialEvent).
      let sourceIds;
      if (type === 'room') {
        if (!params.roomId) return invalid("roomId is required for type 'room'");
        sourceIds = [str(params.roomId)];
      } else if (type === 'group') {
        if (!params.groupId) return invalid("groupId is required for type 'group'");
        sourceIds = [str(params.groupId)];
      } else if (type === 'community') {
        if (!params.communityId) return invalid("communityId is required for type 'community'");
        sourceIds = [str(params.communityId)];
      } else {
        sourceIds = participants.length ? participants : [ctx.socket.selfUserId || ctx.socket.userId].filter(Boolean);
        // The app upgrades a multi-person "direct" meeting into a NEW GROUP
        // (GroupBuilder + GroupsStore.createGroupAux). That is a second write
        // with its own failure modes and no undo, and it is a UI decision the
        // SDK must not take silently.
        if (participants.length > 1) {
          return fail(
            ERROR_CODES.UNSUPPORTED,
            'a direct meeting with more than one participant becomes a group meeting',
            'The app creates a group for these and meets in it. Create the group, then call create-meeting with type "group".',
          );
        }
      }

      const colorHex = HEX.test(str(params.color)) ? str(params.color) : DEFAULT_COLORS[type];
      const startDate = params.startDate ? new Date(params.startDate) : nextQuarterHour(ctx.now?.() ?? new Date());
      if (Number.isNaN(startDate.getTime())) return invalid('startDate is not a date');
      const endDate = params.endDate ? new Date(params.endDate) : new Date(startDate.getTime() + 3_600_000);
      if (Number.isNaN(endDate.getTime())) return invalid('endDate is not a date');

      const base = {
        sourceType: type,
        sourceIds,
        subject: str(params.title),
        title: str(params.title),
        description: str(params.description),
        color: hexToRgba(colorHex),
        invitedUserIds: participants,
      };

      // A weekly series is a different RPC with a different body — an rrule and
      // a duration instead of two dates. Community meetings have no series
      // form, which is why the app excludes them.
      if (params.recurringWeekly && type !== 'community') {
        const ack = await raw(ctx, 'meeting:createMeetingSeries', {
          ...base,
          rrule: 'FREQ=WEEKLY;INTERVAL=1',
          dtstart: startDate.toISOString(),
          duration: Math.floor((endDate.getTime() - startDate.getTime()) / 1000),
        });
        if (isAckError(ack)) return ack;
        const meeting = ack.data?.meeting ?? ack.data?.series ?? null;
        return ok({ meetingId: meeting?.meetingId ?? meeting?.seriesId ?? null, meeting, recurring: true });
      }

      const ack = await raw(ctx, 'meeting:createMeeting', {
        ...base,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      });
      if (isAckError(ack)) return ack;
      const meeting = ack.data?.meeting ?? null;
      return ok({ meetingId: meeting?.meetingId ?? null, meeting, recurring: false });
    })

    // `meeting:updateMeeting` REPLACES the meeting, so the current one is read
    // first and every field the caller did not give is sent back unchanged.
    // Skipping the read would blank the description of every meeting edited
    // for its title alone.
    .define('Events.edit-meeting', async (params, ctx) => {
      const meetingId = str(params.meetingId);
      const current = await raw(ctx, 'meeting:getMeeting', { meetingId });
      if (isAckError(current)) return current;
      const meeting = current.data?.meeting;
      if (!meeting) return invalid(`meeting ${meetingId} not found`);

      let color = meeting.color;
      if (params.color !== undefined) {
        if (!HEX.test(str(params.color))) return invalid('color must be a #RRGGBB hex string');
        color = hexToRgba(str(params.color));
      }
      const pickDate = (given, fallback) => {
        if (given === undefined) return new Date(fallback).toISOString();
        const date = new Date(given);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
      };
      const startDate = pickDate(params.startDate, meeting.startDate);
      if (!startDate) return invalid('startDate is not a date');
      const endDate = pickDate(params.endDate, meeting.endDate);
      if (!endDate) return invalid('endDate is not a date');

      const ack = await raw(ctx, 'meeting:updateMeeting', {
        meetingId,
        sourceType: meeting.sourceType,
        subject: params.title !== undefined ? str(params.title) : meeting.subject,
        description: params.description !== undefined ? str(params.description) : meeting.description,
        color,
        invitedUserIds: params.participants !== undefined ? ids(params.participants) : (meeting.participantIds ?? []),
        startDate,
        endDate,
      });
      if (isAckError(ack)) return ack;
      const updated = ack.data?.meeting ?? null;
      return ok({ meetingId, meeting: updated });
    });

  return registry;
}
