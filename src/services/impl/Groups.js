// ===========================================================================
// Groups — 4 functions, channel `roomful`.
//
// Two were already server tools, two (`discover-groups`, `join-group`) are new
// here; all four are one RPC each, from GroupsService.
//
// Cursor pagination, not offsets: `hasMore` means there are groups the caller
// did NOT receive, and the cursor is how to ask for them.
// ===========================================================================
import { rpc, str, limit } from './support.js';

/** The searchResult/hasMore/cursor triple every group RPC answers with. */
const page = (key) => (data) => ({
  [key]: data.searchResult ?? [],
  hasMore: data.hasMore ?? false,
  cursor: data.cursor ?? '',
});

/** The fields the app keeps off a raw group record. */
const groupFields = (g) => ({
  groupId: g.groupId,
  groupName: g.groupName,
  groupType: g.groupType,
  membersCount: g.membersCount,
  networkId: g.networkId,
  thumbnailId: g.thumbnailId,
});

export function register(registry) {
  registry
    .define('Groups.list-groups', (params, ctx) => rpc(ctx, 'group:searchUserGroups', {
      query: str(params.query),
      limit: limit(params.limit, 20),
      cursor: str(params.cursor),
    }, (data) => ({
      groups: (data.searchResult ?? []).map(groupFields),
      hasMore: data.hasMore ?? false,
      cursor: data.cursor ?? '',
    })))

    .define('Groups.list-group-participants', (params, ctx) => rpc(ctx, 'group:searchGroupMembers', {
      groupId: str(params.groupId),
      query: str(params.query),
      limit: limit(params.limit, 20),
      cursor: str(params.cursor),
    }, page('participants')))

    // CBAC discovery: groups whose badge policy the caller's badges satisfy.
    // Already-joined groups come back too, flagged — the backend ships a zero
    // date (0001-01-01…) for non-members, which is truthy as a string, so the
    // flag has to be computed rather than passed through.
    .define('Groups.discover-groups', (params, ctx) => rpc(ctx, 'group:discoverGroups', {
      query: str(params.query),
      limit: limit(params.limit, 20),
      cursor: str(params.cursor),
    }, (data) => ({
      groups: (data.searchResult ?? []).map((g) => ({
        ...groupFields(g),
        cbacPolicies: g.cbacPolicies,
        joined: Boolean(g.joined) && new Date(g.joined).getTime() > 0,
      })),
      hasMore: data.hasMore ?? false,
      cursor: data.cursor ?? '',
    })))

    .define('Groups.join-group', (params, ctx) =>
      rpc(ctx, 'group:joinGroup', { groupId: str(params.groupId) }, () => ({})));

  return registry;
}
