// ===========================================================================
// The per-function conformance suite — Phase 2's exit criterion.
//
// "84 functions, each with a conformance test that runs unchanged against the
// browser adapter and the node adapter." This is that suite: ONE table, run
// twice (test/conformance.test.js), with nothing adapter-specific in it. If a
// function behaves differently on the two adapters, exactly one of the two
// runs fails and the table says which function.
//
// Each case scripts the calls its function is allowed to make and asserts what
// went out and what came back. A case that scripts an RPC the function does
// not make is harmless; a function that makes one the case did not script gets
// a 404 from the Responder, and its assertion fails — which is the point.
//
// The table is checked for COVERAGE at the end: every function in the registry
// must have a case, so a Phase 3 addition cannot land untested.
// ===========================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceClient } from '../../src/services/ServiceClient.js';
import { ServiceRegistry } from '../../src/services/registry.js';
import { registerAll } from '../../src/services/impl/index.js';
import { SocketTransport } from '../../src/transport/SocketTransport.js';
import { findDescriptor, SERVICE_DESCRIPTORS } from '../../src/services/descriptors.js';
import { ERROR_CODES } from '../../src/Errors.js';
import { Responder, FakeGuru, FakeHost, fakeFetch } from '../helpers/fakes.js';
import { computeDateRange } from '../../src/services/impl/Events.js';

const APPLICATION_ID = 'app-1';
const CONFIG = { webBase: 'https://valu.test', apiGate: 'https://api.valu.test' };
/** A fixed instant, so `Time.get-local-time` and the calendar are assertable. */
const NOW = () => new Date('2026-06-15T12:34:56.789Z');

const ok = (data) => ({ data });

// --- shared scripts --------------------------------------------------------
// Several functions read the same room. Scripting it once keeps the cases
// about the function rather than about the room.

const ROOM_PROPS = {
  'room:listProps': ok({
    props: [
      { id: 'p-1', title: '', assetTitle: 'Gold Frame', assetId: 'a-1', tags: ['team', 'floor0'], contentCount: 0, assetAttributes: { contentType: 'image', thumbnailCount: 1, invokeType: '' } },
      { id: 'p-2', title: 'Our Team', assetTitle: 'Sign', assetId: 'a-2', tags: ['team', 'floor0'], contentCount: 0, assetAttributes: {} },
      { id: 'p-3', title: '', assetTitle: 'Logo Frame', assetId: 'a-1', tags: ['logo'], contentCount: 0, assetAttributes: { contentType: 'image', logoCount: 1 } },
    ],
  }),
  'room:getRoom': ok({ settings: { params: {} }, stories: [] }),
  'asset:getPropAsset': (payload) => ok({ asset: { id: payload.assetId, tags: payload.assetId === 'a-2' ? ['Text'] : ['Frame'] } }),
};

const PROP_SAVE = {
  'room:getProp': (payload) => ok({ prop: { id: payload.propId, title: 'old', customParams: {}, styleId: 's', panelId: 'pa' } }),
  'room:updateProp': ok({}),
};

const UPLOAD = {
  'resource:create': ok({ resource: { id: 'res-new' } }),
  'resource:getUploadLink': ok({ url: 'https://bucket.valu.test/upload/1' }),
  'resource:completeUploadLink': ok({}),
};

const FILE = { name: 'poster.png', contentType: 'image/png', bytes: new Uint8Array([1, 2, 3, 4]) };

// ===========================================================================
// The table. One entry per implemented function.
// ===========================================================================
export const CASES = [
  // --- Users ---------------------------------------------------------------
  {
    key: 'Users.current',
    params: {},
    rpc: { 'social:getUsersSimpleInfo': ok({ users: [{ id: 'user-1', name: 'Ada' }] }) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.user.id, 'user-1');
      assert.deepEqual(calls[0].data, { ids: ['user-1'] });
    },
  },
  {
    key: 'Users.get',
    params: { userId: 'u-9' },
    rpc: { 'social:getUsersSimpleInfo': ok({ users: [{ id: 'u-9' }] }) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.user.id, 'u-9');
      assert.deepEqual(calls[0].data, { ids: ['u-9'] });
    },
  },
  {
    key: 'Users.get',
    name: 'answers 400 when the user is not there',
    params: { userId: 'ghost' },
    rpc: { 'social:getUsersSimpleInfo': ok({ users: [] }) },
    expect: ({ ack }) => assert.equal(ack.error.code, ERROR_CODES.INVALID_PARAMS),
  },
  {
    key: 'Users.search-users',
    params: { filter: 'contacts', query: 'ada' },
    rpc: { 'social:searchUserFriends': ok({ users: [{ id: 'u-1' }] }) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.users.length, 1);
      assert.deepEqual(calls[0].data, { offset: 0, size: 10, query: 'ada', forUser: 'user-1' });
    },
  },
  {
    key: 'Users.search-users',
    name: 'the filter picks the RPC',
    params: { filter: 'followers', query: '' },
    rpc: { 'social:searchUserFollowers': ok({ users: [] }) },
    expect: ({ calls }) => assert.equal(calls[0].ns, 'social:searchUserFollowers'),
  },
  {
    key: 'Users.find-user',
    params: { query: 'ada' },
    rpc: { 'social:getSuggestedFriends': ok({ users: [{ id: 'u-2' }] }) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.users[0].id, 'u-2');
      assert.deepEqual(calls[0].data, { query: 'ada', offset: 0, size: 10 });
    },
  },
  {
    key: 'Users.send-connection-request',
    params: { userId: 'u-3' },
    rpc: { 'social:sendRequest': ok({}) },
    expect: ({ ack, calls }) => {
      assert.deepEqual(ack.data, {});
      assert.deepEqual(calls[0].data, { targetUser: 'u-3' });
    },
  },
  {
    key: 'Users.accept-connection-request',
    params: { userId: 'u-3' },
    rpc: { 'social:acceptRequest': ok({}) },
    expect: ({ calls }) => assert.deepEqual(calls[0].data, { targetUser: 'u-3' }),
  },
  {
    key: 'Users.decline-connection-request',
    params: { userId: 'u-3' },
    rpc: { 'social:declineRequest': ok({}) },
    expect: ({ calls }) => assert.equal(calls[0].ns, 'social:declineRequest'),
  },
  {
    key: 'Users.cancel-connection-request',
    params: { userId: 'u-3' },
    rpc: { 'social:deleteRequest': ok({}) },
    expect: ({ calls }) => assert.equal(calls[0].ns, 'social:deleteRequest'),
  },

  // --- Networks ------------------------------------------------------------
  {
    key: 'Networks.get-current-network',
    params: {},
    rpc: { 'network:getNetworkInfoForUser': ok({ fullName: 'Roomful' }) },
    expect: ({ ack }) => assert.deepEqual(ack.data, { networkId: 'roomful', name: 'Roomful' }),
  },
  {
    key: 'Networks.get-current-network',
    name: 'a failed name lookup still answers the id',
    params: {},
    rpc: { 'network:getNetworkInfoForUser': { error: { status: true, code: 500, message: 'nope' } } },
    expect: ({ ack }) => {
      assert.equal(ack.error, undefined, 'the id is known regardless — this is a partial answer, not a failure');
      assert.equal(ack.data.networkId, 'roomful');
      assert.equal(ack.data.name, null);
      assert.match(ack.data.warning, /nope/);
    },
  },

  // --- Groups --------------------------------------------------------------
  {
    key: 'Groups.list-groups',
    params: { query: 'eng' },
    rpc: { 'group:searchUserGroups': ok({ searchResult: [{ groupId: 'g-1', groupName: 'Eng' }], hasMore: true, cursor: 'c1' }) },
    expect: ({ ack, calls }) => {
      assert.deepEqual(ack.data.groups, [{ groupId: 'g-1', groupName: 'Eng', groupType: undefined, membersCount: undefined, networkId: undefined, thumbnailId: undefined }]);
      assert.equal(ack.data.cursor, 'c1');
      assert.deepEqual(calls[0].data, { query: 'eng', limit: 20, cursor: '' });
    },
  },
  {
    key: 'Groups.list-group-participants',
    params: { groupId: 'g-1' },
    rpc: { 'group:searchGroupMembers': ok({ searchResult: [{ id: 'u-1' }], hasMore: false, cursor: '' }) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.participants.length, 1);
      assert.equal(calls[0].data.groupId, 'g-1');
    },
  },
  {
    key: 'Groups.discover-groups',
    params: {},
    rpc: {
      'group:discoverGroups': ok({
        searchResult: [
          { groupId: 'g-1', joined: '0001-01-01T00:00:00Z' },
          { groupId: 'g-2', joined: '2026-01-01T00:00:00Z' },
        ],
      }),
    },
    expect: ({ ack }) => {
      // The backend ships a ZERO date for a non-member, which is truthy as a
      // string — the flag has to be computed, not passed through.
      assert.equal(ack.data.groups[0].joined, false);
      assert.equal(ack.data.groups[1].joined, true);
    },
  },
  {
    key: 'Groups.join-group',
    params: { groupId: 'g-1' },
    rpc: { 'group:joinGroup': ok({}) },
    expect: ({ calls }) => assert.deepEqual(calls[0].data, { groupId: 'g-1' }),
  },

  // --- Profile -------------------------------------------------------------
  {
    key: 'Profile.get-user-credentials',
    params: { userId: 'u-2' },
    rpc: {
      'verus:listAttestationBlocksForUser': ok({
        claims: {
          a: { attestationType: 'credential', status: 'Verified And Persisted' },
          b: { attestationType: 'credential', status: 'Revoked' },
          c: { attestationType: 'other' },
        },
      }),
    },
    expect: ({ ack, calls }) => {
      assert.deepEqual(calls[0].data, { targetUser: 'u-2' });
      // A revoked credential is visible to its owner only, and u-2 is not us.
      assert.equal(ack.data.credentials.length, 1);
    },
  },
  {
    key: 'Profile.get-user-badges',
    params: { userId: 'u-2' },
    rpc: { 'user:listBadgesAssignedToUser': ok({ badges: [{ badgeId: 'b-1' }] }) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.badges.length, 1);
      assert.deepEqual(calls[0].data, { targetUser: 'u-2', networkId: 'all' });
    },
  },

  // --- Cbac ----------------------------------------------------------------
  {
    key: 'Cbac.list-policies',
    params: { networkId: 'roomful', targetType: 'room', targetId: 'r-1' },
    rpc: { 'cbac:listPolicies': ok({ policies: [{ policyId: 'pol-1' }] }) },
    expect: ({ ack }) => assert.equal(ack.data.policies[0].policyId, 'pol-1'),
  },
  {
    key: 'Cbac.create-policy',
    params: { networkId: 'roomful', targetType: 'room', targetId: 'r-1', badgeIds: ['b-1'], badgeMatchMode: 'any', grantedPermission: 'view' },
    rpc: { 'cbac:createPolicy': ok({ policy: { policyId: 'pol-2' } }) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.policy.policyId, 'pol-2');
      assert.deepEqual(calls[0].data.badgeIds, ['b-1']);
    },
  },
  {
    key: 'Cbac.delete-policy',
    params: { policyId: 'pol-1', networkId: 'roomful', targetType: 'room', targetId: 'r-1' },
    rpc: { 'cbac:deletePolicy': ok({}) },
    expect: ({ calls }) => assert.equal(calls[0].data.policyId, 'pol-1'),
  },
  {
    key: 'Cbac.list-badges',
    params: {},
    rpc: { 'user:listBadges': ok({ badges: [{ badgeId: 'b-1' }] }) },
    expect: ({ ack }) => assert.equal(ack.data.badges.length, 1),
  },
  {
    key: 'Cbac.search-users-by-badge-id',
    params: { badgeId: 'b-1' },
    rpc: { 'social:searchUsersByBadgeId': ok({ users: [{ id: 'u-1' }], total: 42 }) },
    expect: ({ ack }) => {
      // `total` is the full match count, not the page size.
      assert.equal(ack.data.total, 42);
      assert.equal(ack.data.users.length, 1);
    },
  },

  // --- Community -----------------------------------------------------------
  {
    key: 'Community.search-communities',
    params: { query: 'art' },
    rpc: { 'community:searchOpenCommunities': ok({ communities: [{ communityId: 'c-1' }] }) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.communities.length, 1);
      assert.deepEqual(calls[0].data, { query: 'art', limit: 10, afterCommunityId: '' });
    },
  },
  {
    key: 'Community.get-community-info',
    params: { communityId: 'c-1' },
    rpc: { 'community:getInfoAndSubscribe': ok({ community: { communityId: 'c-1' } }) },
    expect: ({ ack }) => assert.equal(ack.data.community.communityId, 'c-1'),
  },
  {
    key: 'Community.get-channels',
    params: { communityId: 'c-1' },
    rpc: { 'community:searchCommunityChannels': ok({ channels: [{ channelId: 'ch-1' }] }) },
    expect: ({ ack }) => {
      // Sub-channels are addressed as (root, sub); a caller that kept only
      // `channelId` could not reconstruct the root.
      assert.equal(ack.data.channels[0].rootChannelId, 'ch-1');
    },
  },
  {
    key: 'Community.get-posts',
    params: { channelId: 'ch-1', communityId: 'c-1' },
    rpc: { 'channel:listMessagesWithEngagement': ok({ messages: [{ messageId: 'm-1' }] }) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.rootChannelId, 'ch-1');
      assert.equal(ack.data.communityId, 'c-1');
      assert.equal(calls[0].data.limit, 10);
    },
  },

  // --- Events --------------------------------------------------------------
  {
    key: 'Events.list-events',
    params: { range: 'month', startDate: '2026-06-15T00:00:00.000Z' },
    rpc: {
      'meeting:listMeetingOccurrences': ok({
        meetings: [
          { meetingId: 'm-2', startDate: '2026-06-20T10:00:00Z', subject: 'Later', color: { r: 1, g: 0, b: 0, a: 1 } },
          { meetingId: 'm-1', startDate: '2026-06-02T10:00:00Z', subject: 'Earlier' },
        ],
      }),
    },
    expect: ({ ack, calls }) => {
      assert.deepEqual(ack.data.events.map((e) => e.title), ['Earlier', 'Later'], 'earliest first');
      assert.equal(ack.data.events[1].color, '#ff0000', 'rgba floats in, hex out');
      assert.equal(ack.data.events[0].id, 'm-1_2026-06-02T10:00:00Z');
      // The window is the anchor's whole LOCAL month, not its day — computed
      // in the caller's timezone exactly as the calendar app computes it, so
      // the ISO instants depend on where the caller is.
      const expected = computeDateRange(new Date('2026-06-15T00:00:00.000Z'), 'month');
      assert.equal(calls[0].data.startDate, expected.start.toISOString());
      assert.equal(calls[0].data.endDate, expected.end.toISOString());
      assert.equal(expected.start.getDate(), 1);
      assert.equal(expected.start.getMonth(), 5, 'June, locally');
    },
  },
  {
    key: 'Events.create-meeting',
    params: { title: 'Standup', type: 'room', roomId: 'r-1', startDate: '2026-07-01T09:00:00.000Z' },
    rpc: { 'meeting:createMeeting': ok({ meeting: { meetingId: 'm-9' } }) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.meetingId, 'm-9');
      assert.equal(ack.data.recurring, false);
      assert.deepEqual(calls[0].data.sourceIds, ['r-1']);
      assert.deepEqual(calls[0].data.color, { r: 0x42 / 255, g: 0x99 / 255, b: 0xf5 / 255, a: 1 });
      assert.equal(calls[0].data.endDate, '2026-07-01T10:00:00.000Z', 'an hour, when no end was given');
    },
  },
  {
    key: 'Events.create-meeting',
    name: 'a weekly meeting is a SERIES, a different RPC',
    params: { title: 'Weekly', type: 'group', groupId: 'g-1', recurringWeekly: true, startDate: '2026-07-01T09:00:00.000Z', endDate: '2026-07-01T10:00:00.000Z' },
    rpc: { 'meeting:createMeetingSeries': ok({ meeting: { meetingId: 's-1' } }) },
    expect: ({ ack, calls }) => {
      assert.equal(calls[0].ns, 'meeting:createMeetingSeries');
      assert.equal(calls[0].data.rrule, 'FREQ=WEEKLY;INTERVAL=1');
      assert.equal(calls[0].data.duration, 3600);
      assert.equal(ack.data.recurring, true);
    },
  },
  {
    key: 'Events.create-meeting',
    name: 'a multi-person direct meeting is refused, not silently turned into a group',
    params: { title: 'Chat', type: 'direct', participants: ['u-1', 'u-2'] },
    rpc: {},
    expect: ({ ack, calls }) => {
      assert.equal(ack.error.code, ERROR_CODES.UNSUPPORTED);
      assert.equal(calls.length, 0, 'nothing was created');
    },
  },
  {
    key: 'Events.edit-meeting',
    params: { meetingId: 'm-1', title: 'Renamed' },
    rpc: {
      'meeting:getMeeting': ok({ meeting: { meetingId: 'm-1', subject: 'Old', description: 'keep me', sourceType: 'room', color: { r: 0, g: 0, b: 0, a: 1 }, startDate: '2026-07-01T09:00:00Z', endDate: '2026-07-01T10:00:00Z', participantIds: ['u-1'] } }),
      'meeting:updateMeeting': ok({ meeting: { meetingId: 'm-1', subject: 'Renamed' } }),
    },
    expect: ({ ack, calls }) => {
      const update = calls.find((c) => c.ns === 'meeting:updateMeeting');
      // updateMeeting REPLACES: every field not given must be sent back as it
      // was, or the edit blanks it.
      assert.equal(update.data.subject, 'Renamed');
      assert.equal(update.data.description, 'keep me');
      assert.deepEqual(update.data.invitedUserIds, ['u-1']);
      assert.equal(ack.data.meeting.subject, 'Renamed');
    },
  },

  // --- TextChat ------------------------------------------------------------
  {
    key: 'TextChat.get-channel-history',
    params: { channelId: 'ch-1' },
    rpc: {
      'channel:listMessages': ok({
        messages: [
          { messageId: 'm-1', channelId: 'ch-1', authorId: 'user-1', messageBody: 'hi', created: 't' },
          { messageId: 'm-2', channelId: 'ch-1', authorId: 'u-2', messageBody: 'CIPHER', encryptionEpoch: 3 },
          { messageId: 'm-3', channelId: 'ch-1', authorId: 'u-2', isDeleted: true },
        ],
        hasPrevious: true,
      }),
    },
    expect: ({ ack }) => {
      assert.equal(ack.data.messages[0].role, 'assistant', 'our own message');
      assert.equal(ack.data.messages[1].encrypted, true, 'said, not handed back as noise');
      assert.equal(ack.data.messages[2].body, '[deleted]');
      assert.equal(ack.data.hasPrevious, true);
    },
  },
  {
    key: 'TextChat.send-message',
    params: { text: 'hello', userId: 'u-2' },
    rpc: {
      'channel:getDirectChannel': ok({ channel: { channelId: 'ch-9' } }),
      'channel:createMessage': ok({ message: { messageId: 'm-1', created: 't' } }),
    },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.channelId, 'ch-9');
      const sent = calls.find((c) => c.ns === 'channel:createMessage');
      assert.equal(sent.data.messageBody, 'hello', 'plain text when there is nothing else to carry');
      assert.equal(sent.data.messageType, 0);
    },
  },
  {
    key: 'TextChat.send-message',
    name: 'a flat button is promoted and warned about; customParams are filtered',
    params: {
      text: 'pick one',
      channelId: 'ch-1',
      buttons: [{ text: 'Open', applicationId: 'rooms', action: 'open' }],
      customParams: { 'open-thread': true, runId: 'forged' },
    },
    rpc: { 'channel:createMessage': ok({ message: { messageId: 'm-1' } }) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.buttonWarnings.length, 1);
      const sent = calls[0];
      assert.deepEqual(sent.data.customParams, { 'open-thread': true }, 'runId is server-injected and never a caller\'s');
      const body = JSON.parse(sent.data.messageBody);
      assert.deepEqual(body.buttons[0].intent, { applicationId: 'rooms', action: 'open', params: {} });
    },
  },
  {
    key: 'TextChat.message-owner',
    params: { userId: 'u-1', agentId: 'agent-7', text: 'done' },
    rpc: {
      'channel:getChannelBySource': ok({ channel: { channelId: 'ch-agent' } }),
      'channel:createMessage': ok({ message: { messageId: 'm-1' } }),
    },
    expect: ({ calls }) => {
      assert.deepEqual(calls[0].data, { channelSource: 'userAIAgent:u-1:agent-7' });
      const body = JSON.parse(calls[1].data.messageBody);
      // Both sides ride the owner's socket, so authorId cannot tell an
      // agent message from its owner's — this is what can.
      assert.deepEqual(body.meta.sender, { agentId: 'agent-7' });
    },
  },

  // --- Resources -----------------------------------------------------------
  {
    key: 'Resources.generate-public-url',
    params: { resourceId: 'res-1' },
    rpc: {},
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.url, 'https://valu.test/preview/res-1');
      assert.equal(calls.length, 0, 'a local function makes no call');
    },
  },
  {
    key: 'Resources.generate-best-view-url',
    params: { resourceId: 'res-1' },
    rpc: {},
    expect: ({ ack }) => assert.equal(ack.data.url, 'https://valu.test/resource/res-1'),
  },
  {
    key: 'Resources.generate-direct-public-url',
    params: { resourceId: 'res/1' },
    rpc: {},
    expect: ({ ack }) => assert.equal(ack.data.url, 'https://api.valu.test/api/v0/resource/res%2F1', 'the id is escaped'),
  },
  {
    key: 'Resources.get-thumbnail-url',
    params: { resourceId: 'res-1', thumbnailSize: 512 },
    rpc: {},
    expect: ({ ack }) => assert.equal(ack.data.url, 'https://api.valu.test/api/v0/resource/thumbnail/512/res-1'),
  },
  {
    key: 'Resources.list-bot-avatars',
    params: { limit: 5 },
    rpc: { 'resource:searchBelonging': ok({ resources: [{ id: 'av-1', title: 'Robot', tags: ['friendly'] }] }) },
    expect: ({ ack, calls }) => {
      assert.deepEqual(ack.data.avatars, [{ id: 'av-1', name: 'Robot', tags: ['friendly'] }]);
      assert.match(calls[0].data.belonging, /^directory:/);
      assert.equal(calls[0].data.limit, 5);
    },
  },

  // --- Http / Time (local) -------------------------------------------------
  {
    key: 'Http.ping',
    params: { url: 'https://example.test' },
    rpc: {},
    expect: ({ ack, fetch }) => {
      assert.equal(ack.data.up, true);
      assert.equal(fetch.puts[0].method, 'HEAD');
    },
  },
  {
    key: 'Http.get',
    params: { url: 'https://example.test/x' },
    rpc: {},
    expect: ({ ack, fetch }) => {
      assert.equal(ack.data.status, 200);
      assert.equal(fetch.puts[0].method, 'GET');
    },
  },
  {
    key: 'Http.post',
    params: { url: 'https://example.test/x', body: { a: 1 } },
    rpc: {},
    expect: ({ fetch }) => {
      const sent = fetch.puts[0];
      assert.equal(sent.method, 'POST');
      assert.equal(sent.body, '{"a":1}');
      assert.equal(sent.headers['Content-Type'], 'application/json');
    },
  },
  {
    key: 'Time.get-local-time',
    params: {},
    rpc: {},
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.utcIso, '2026-06-15T12:34:56.789Z');
      assert.equal(typeof ack.data.offsetMinutes, 'number');
      assert.equal(calls.length, 0);
    },
  },

  // --- Rooms ---------------------------------------------------------------
  {
    key: 'Rooms.search-rooms',
    params: { query: 'expo' },
    rpc: { 'explorer:searchRooms': ok({ rooms: [{ id: 'r-1' }] }) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.rooms.length, 1);
      assert.deepEqual(calls[0].data, { networkId: 'roomful', offset: 0, size: 10, query: 'expo' });
    },
  },
  {
    key: 'Rooms.search-my-rooms',
    params: { filter: 'all' },
    rpc: { 'room:searchRoomsOfUser': ok({ rooms: [{ id: 'r-1' }] }) },
    expect: ({ calls }) => assert.equal(calls[0].data.filter, 'all'),
  },
  {
    key: 'Rooms.search-my-rooms',
    name: 'invites is a different RPC answering a different shape',
    params: { filter: 'invites' },
    rpc: { 'social:getUserInvitations': ok({ invitations: [{ room: { id: 'r-2' }, invitation: { id: 'i-1' } }] }) },
    expect: ({ ack, calls }) => {
      assert.equal(calls[0].ns, 'social:getUserInvitations');
      assert.equal(ack.data.rooms[0].id, 'r-2');
      assert.equal(ack.data.rooms[0].invitation.id, 'i-1');
    },
  },
  {
    key: 'Rooms.get-room',
    params: { roomId: 'r-1' },
    rpc: { 'room:getRoomBasicModel': ok({ room: { id: 'r-1' } }) },
    expect: ({ ack }) => assert.equal(ack.data.room.id, 'r-1'),
  },
  {
    key: 'Rooms.get-permissions',
    params: { roomId: 'r-1' },
    rpc: { 'room:permissions': ok({ permissions: { manage: true } }) },
    expect: ({ ack }) => assert.equal(ack.data.permissions.manage, true),
  },
  {
    key: 'Rooms.get-room-props',
    params: { roomId: 'r-1' },
    rpc: ROOM_PROPS,
    expect: ({ ack }) => {
      assert.equal(ack.data.propOrder.source, 'props-group');
      assert.deepEqual(ack.data.props.map((p) => p.navIndex), [0, 1, 2]);
      // An untitled content prop is named by what it SHOWS, falling back to
      // the asset's catalog name — never to its own id when there is one.
      assert.equal(ack.data.props[0].name, 'Gold Frame');
      assert.equal(ack.data.props[1].isTextProp, true, 'a Text prop is a section sign');
    },
  },
  {
    key: 'Rooms.get-room-props',
    name: 'a storyline override IS the room order',
    params: { roomId: 'r-1' },
    rpc: {
      ...ROOM_PROPS,
      'room:getRoom': ok({
        settings: { params: { 'storyline.overridenextpreviousstoryid': 'st-1' } },
        stories: [{ id: 'st-1', title: 'Tour', data: JSON.stringify({ frames: [{ propId: 'p-3' }, {}, { propId: 'p-1' }] }) }],
      }),
    },
    expect: ({ ack }) => {
      assert.equal(ack.data.propOrder.source, 'storyline');
      assert.deepEqual(ack.data.props.map((p) => p.id), ['p-3', 'p-1', 'p-2']);
      assert.equal(ack.data.props[2].navIndex, null, 'off the walk, and said so');
    },
  },
  {
    key: 'Rooms.get-prop',
    params: { roomId: 'r-1', propId: 'p-2' },
    rpc: ROOM_PROPS,
    expect: ({ ack }) => {
      assert.equal(ack.data.prop.id, 'p-2');
      assert.equal(ack.data.prop.navIndex, 1, 'the same index get-room-props gives it');
    },
  },
  {
    key: 'Rooms.get-room-prop-groups',
    params: { roomId: 'r-1' },
    rpc: ROOM_PROPS,
    expect: ({ ack }) => {
      assert.deepEqual(ack.data.groupIds, ['floor0+team', 'logo']);
      const team = ack.data.groups[0];
      assert.equal(team.propCount, 2);
      assert.equal(team.decorativePropCount, 1, 'the sign is counted, not listed');
      assert.deepEqual(team.labels, [{ propId: 'p-2', text: 'Our Team' }]);
      assert.equal(ack.data.groups[1].isLogoGroup, true);
    },
  },
  {
    key: 'Rooms.list-prop-team-members',
    params: { roomId: 'r-1', propId: 'p-1' },
    rpc: { 'social:getPropInvitations': ok({ invitations: [{ invitedUser: 'u-2' }] }) },
    expect: ({ ack }) => assert.equal(ack.data.invitations.length, 1),
  },
  {
    key: 'Rooms.invite-to-prop',
    params: { roomId: 'r-1', propId: 'p-1', invitedUser: 'u-2', permissions: { edit: true } },
    rpc: { 'social:inviteToProp': ok({ invitation: { id: 'i-1' } }) },
    expect: ({ calls }) => {
      // All five flags, always: a partial set reads as the rest being false.
      assert.deepEqual(calls[0].data.permissions, { view: true, comment: false, contribute: false, edit: true, manage: false });
      assert.equal(calls[0].data.customParams, null);
    },
  },
  {
    key: 'Rooms.delete-prop-invitation',
    params: { roomId: 'r-1', propId: 'p-1', invitedUser: 'u-2' },
    rpc: { 'social:deletePropInvitation': ok({}) },
    expect: ({ calls }) => assert.deepEqual(calls[0].data, { roomId: 'r-1', propId: 'p-1', invitedUser: 'u-2' }),
  },
  {
    key: 'Rooms.list-room-templates',
    params: {},
    rpc: {
      'room:listTemplateRooms': ok({
        templates: [
          { id: 't-1', name: 'Expo', tags: ['community', 'ai-friendly', 'prop-groups_5'], price: 0 },
          { id: 't-2', name: 'Private', tags: ['community'], price: 10 },
        ],
      }),
    },
    expect: ({ ack, calls }) => {
      // A server that ORed the tag filter would widen the build surface; the
      // check is repeated here, so it cannot.
      assert.deepEqual(ack.data.templates.map((t) => t.id), ['t-1']);
      assert.equal(ack.data.templates[0].groupCount, 5);
      assert.equal(ack.data.filteredOutCount, 1);
      assert.deepEqual(calls[0].data.tags, ['community', 'ai-friendly']);
    },
  },
  {
    key: 'Rooms.create-room-from-template',
    params: { templateId: 't-1', roomName: 'My Expo' },
    rpc: {
      'room:listTemplateRooms': ok({ templates: [{ id: 't-1', name: 'Expo', tags: ['community', 'ai-friendly'], price: 25 }] }),
      'room:createRoomFromTemplate': ok({ roomId: 'r-new' }),
    },
    expect: ({ ack, calls }) => {
      const create = calls.find((c) => c.ns === 'room:createRoomFromTemplate');
      // The price comes from the LISTING, not from the caller — a worker that
      // never saw the listing must not get a paid template refused.
      assert.equal(create.data.subscriptionPlan, 'one_time_payment');
      assert.equal(ack.data.paymentRequired, true);
      assert.equal(ack.data.price, 25);
      assert.match(ack.data.paymentInstructions, /Pay for Room/);
    },
  },
  {
    key: 'Rooms.paste-resources-into-prop',
    params: { roomId: 'r-1', propId: 'p-1', resourceIds: ['res-a', 'res-b'] },
    rpc: {
      ...ROOM_PROPS,
      ...PROP_SAVE,
      'room:getPropContent': ok({ content: [{ id: 'stub-1', fromTemplate: true }] }),
      'resource:createAndSubscribeToUploadSession': ok({ uploadSessionId: 'sess-1' }),
      'resource:createLinkResource': (payload) => ok({ resource: { id: `link-${payload.resource}` } }),
      'room:changePropContent': ok({}),
    },
    expect: ({ ack, calls }) => {
      assert.deepEqual(ack.data.addedResourceIds, ['link-res-a', 'link-res-b'], 'in the caller\'s display order');
      assert.deepEqual(ack.data.removedTemplateStubs, ['stub-1']);
      // A link copy is staged in an upload session and MOVED: linking straight
      // under the prop's belonging is refused as "Invalid prop resources".
      const link = calls.find((c) => c.ns === 'resource:createLinkResource');
      assert.equal(link.data.belonging, 'uploadSession:user-1/sess-1');
      const move = calls.filter((c) => c.ns === 'room:changePropContent').pop();
      assert.deepEqual(move.data.moveToProp, ['link-res-a', 'link-res-b']);
      assert.equal(ack.data.sliderEnabled, true, 'two items is a slideshow');
    },
  },
  {
    key: 'Rooms.paste-resources-into-prop',
    name: 'a repeated paste is a no-op, not a second copy',
    params: { roomId: 'r-1', propId: 'p-1', resourceIds: ['res-a'] },
    rpc: {
      ...ROOM_PROPS,
      ...PROP_SAVE,
      'room:getPropContent': ok({ content: [{ id: 'link-1', linkId: 'res-a' }] }),
    },
    expect: ({ ack, calls }) => {
      assert.deepEqual(ack.data.skippedAlreadyPresent, ['res-a']);
      assert.equal(ack.data.alreadyPresent, true);
      assert.equal(calls.filter((c) => c.ns === 'resource:createLinkResource').length, 0,
        'a timed-out paste that actually landed must not paste twice');
    },
  },
  {
    key: 'Rooms.paste-resources-into-prop',
    name: 'a presentation board is refused before anything is copied',
    params: { roomId: 'r-1', propId: 'p-1', resourceIds: ['res-a'] },
    rpc: {
      ...ROOM_PROPS,
      'asset:getPropAsset': () => ok({ asset: { tags: ['PresentationBoard'] } }),
    },
    expect: ({ ack, calls }) => {
      assert.equal(ack.error.code, ERROR_CODES.UNSUPPORTED);
      assert.match(ack.error.message, /screen-share/);
      assert.equal(calls.filter((c) => c.ns === 'resource:createLinkResource').length, 0);
    },
  },
  {
    key: 'Rooms.paste-resources-into-prop-group',
    params: { roomId: 'r-1', groupIds: ['floor0+team'], resourceIds: ['res-a'] },
    rpc: {
      ...ROOM_PROPS,
      ...PROP_SAVE,
      'room:getPropContent': ok({ content: [] }),
      'resource:createAndSubscribeToUploadSession': ok({ uploadSessionId: 'sess-1' }),
      'resource:createLinkResource': (payload) => ok({ resource: { id: `link-${payload.resource}` } }),
      'room:changePropContent': ok({}),
    },
    expect: ({ ack }) => {
      assert.equal(ack.data.distribution, 'spread');
      assert.equal(ack.data.eligiblePropCount, 1, 'the sign cannot hold content');
      assert.equal(ack.data.placements.length, 1);
      assert.equal(ack.data.placements[0].propId, 'p-1');
      assert.deepEqual(ack.data.unplacedResourceIds, []);
    },
  },
  {
    key: 'Rooms.paste-resources-into-prop-group',
    name: 'a logo group replicates by default',
    params: { roomId: 'r-1', groupIds: ['logo'], resourceIds: ['res-a', 'res-b'] },
    rpc: {
      ...ROOM_PROPS,
      ...PROP_SAVE,
      'room:getPropContent': ok({ content: [] }),
      'resource:createAndSubscribeToUploadSession': ok({ uploadSessionId: 'sess-1' }),
      'resource:createLinkResource': (payload) => ok({ resource: { id: `link-${payload.resource}` } }),
      'room:changePropContent': ok({}),
    },
    expect: ({ ack }) => {
      assert.equal(ack.data.distribution, 'replicate', 'every logo on every frame');
      assert.deepEqual(ack.data.placements[0].resourceIds, ['res-a', 'res-b']);
    },
  },
  {
    key: 'Rooms.paste-resources-into-prop-group',
    name: 'an unknown group id names the ones that exist',
    params: { roomId: 'r-1', groupIds: ['nope'], resourceIds: ['res-a'] },
    rpc: ROOM_PROPS,
    expect: ({ ack }) => {
      assert.equal(ack.error.code, ERROR_CODES.INVALID_PARAMS);
      assert.match(ack.error.message, /floor0\+team/);
    },
  },
  {
    key: 'Rooms.paste-resources-into-prop',
    name: 'a platform refusal keeps its own code, not a flattened 501',
    params: { roomId: 'r-1', propId: 'p-1', resourceIds: ['res-a'] },
    rpc: {
      ...ROOM_PROPS,
      'room:getPropContent': ok({ content: [] }),
      'resource:createAndSubscribeToUploadSession': ok({ uploadSessionId: 'sess-1' }),
      'resource:createLinkResource': (payload) => ok({ resource: { id: `link-${payload.resource}` } }),
      'room:changePropContent': { error: { status: true, code: 403, message: 'Invalid prop resources' } },
    },
    expect: ({ ack }) => {
      assert.equal(ack.error.code, 403, '"you may not" and "it is gone" must not arrive as the same error');
      assert.match(ack.error.message, /Invalid prop resources/);
    },
  },
  {
    key: 'Rooms.rename-prop-group',
    params: { roomId: 'r-1', groupId: 'floor0+team', name: 'The Crew' },
    rpc: { ...ROOM_PROPS, ...PROP_SAVE },
    expect: ({ ack, calls }) => {
      // The SIGN is retitled, never the frames: a paste clears a frame's title
      // anyway, and a titled frame captions itself with the section's name.
      assert.deepEqual(ack.data.renamedLabelPropIds, ['p-2']);
      assert.equal(ack.data.hasLabels, true);
      const saved = calls.filter((c) => c.ns === 'room:updateProp');
      assert.equal(saved.length, 1);
      assert.equal(saved[0].data.prop.title, 'The Crew');
    },
  },

  // --- CMS -----------------------------------------------------------------
  {
    key: 'CMS.resource-upload',
    params: { files: [FILE] },
    rpc: UPLOAD,
    expect: ({ ack, calls, fetch }) => {
      assert.deepEqual(ack.data.resolved, [{ id: 'res-new', fileName: 'poster.png' }]);
      assert.deepEqual(ack.data.failed, []);
      assert.equal(ack.data.placed, 'app:app-1:userSortingTable:user-1');
      // The four steps, in order — three RPCs and the bucket PUT.
      assert.deepEqual(calls.map((c) => c.ns),
        ['resource:create', 'resource:getUploadLink', 'resource:completeUploadLink']);
      assert.equal(fetch.puts[0].method, 'PUT');
      assert.equal(fetch.puts[0].headers['Content-Range'], 'bytes 0-3/4');
    },
  },
  {
    key: 'CMS.resource-upload',
    name: 'a prop scope stages then moves',
    params: { files: [FILE], roomId: 'r-1', propId: 'p-1' },
    rpc: { ...UPLOAD, 'room:changePropContent': ok({}) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.placed, 'room:r-1/p-1');
      const create = calls.find((c) => c.ns === 'resource:create');
      assert.equal(create.data.belonging, 'uploadSession:user-1');
      assert.deepEqual(calls.at(-1).data.moveToProp, ['res-new']);
    },
  },
  {
    key: 'CMS.resource-search',
    params: { roomId: 'r-1' },
    rpc: { 'resource:searchBelonging': ok({ resources: [{ id: 'res-1' }], hasMore: false }) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.resources.length, 1);
      assert.equal(calls[0].data.belonging, 'roomSortingTable:r-1');
    },
  },
  {
    key: 'CMS.resource-delete',
    params: { resourceId: 'res-1', roomId: 'r-1', propId: 'p-1' },
    rpc: { 'room:changePropContent': ok({}) },
    expect: ({ ack, calls }) => {
      // DETACH, not delete: the resource may be on three other props.
      assert.equal(calls[0].ns, 'room:changePropContent');
      assert.deepEqual(calls[0].data.removeFromProp, ['res-1']);
      assert.equal(ack.data.detachedFrom, 'room:r-1/p-1');
    },
  },
  {
    key: 'CMS.resource-delete',
    name: 'with no scope the resource itself goes',
    params: { resourceId: 'res-1' },
    rpc: { 'resource:delete': ok({}) },
    expect: ({ calls }) => assert.equal(calls[0].ns, 'resource:delete'),
  },

  // --- ApplicationStorage --------------------------------------------------
  {
    key: 'ApplicationStorage.resource-upload',
    params: { files: [FILE] },
    rpc: UPLOAD,
    expect: ({ ack, calls }) => {
      assert.deepEqual(ack.data.resolved, [{ id: 'res-new', fileName: 'poster.png' }]);
      assert.equal(calls[0].data.belonging, 'app:app-1:userSortingTable:user-1');
    },
  },
  {
    key: 'ApplicationStorage.resource-upload',
    name: 'without an application id the shelf has no name — 403, no upload',
    params: { files: [FILE] },
    applicationId: null,
    rpc: UPLOAD,
    expect: ({ ack, calls }) => {
      assert.equal(ack.error.code, ERROR_CODES.FORBIDDEN);
      assert.equal(calls.length, 0);
    },
  },
  {
    key: 'ApplicationStorage.resource-search',
    params: {},
    rpc: { 'resource:searchBelonging': ok({ resources: [], hasMore: false }) },
    expect: ({ calls }) => assert.equal(calls[0].data.belonging, 'app:app-1:userSortingTable:user-1'),
  },
  {
    key: 'ApplicationStorage.resource-delete',
    params: { resourceId: 'res-1' },
    rpc: { 'resource:delete': ok({}) },
    expect: ({ calls }) => assert.deepEqual(calls[0].data, { resourceId: 'res-1' }),
  },

  // --- Commerce (channel: valuguru) ----------------------------------------
  {
    key: 'Commerce.list-products',
    params: { query: 'poster' },
    guru: { 'valuguru.commerce.catalog.search': { products: [{ id: 'prd-1' }], nextOffset: 10 } },
    expect: ({ ack, guru, calls }) => {
      assert.equal(ack.data.products.length, 1);
      assert.equal(guru.calls[0].params.appId, APPLICATION_ID, 'the HOST names the caller, never the params');
      assert.equal(calls.length, 0, 'not a Roomful call');
    },
  },
  {
    key: 'Commerce.list-products',
    name: 'an unidentified caller is 403, not a guess',
    params: {},
    applicationId: null,
    guru: { 'valuguru.commerce.catalog.search': { products: [] } },
    expect: ({ ack, guru }) => {
      assert.equal(ack.error.code, ERROR_CODES.FORBIDDEN);
      assert.equal(guru.calls.length, 0);
    },
  },
  {
    key: 'Commerce.get-product',
    params: { productId: 'prd-1' },
    guru: { 'valuguru.commerce.catalog.get': { product: { id: 'prd-1' } } },
    expect: ({ ack }) => assert.equal(ack.data.product.id, 'prd-1'),
  },
  {
    key: 'Commerce.list-categories',
    params: {},
    guru: { 'valuguru.commerce.catalog.categories': { categories: [{ id: 'art', label: 'Art' }] } },
    expect: ({ ack }) => assert.equal(ack.data.categories[0].id, 'art'),
  },
  {
    key: 'Commerce.add-to-cart',
    params: { productId: 'prd-1', qty: 2 },
    guru: { 'valuguru.commerce.cart.add': { items: [{ id: 'ci-1' }] } },
    expect: ({ ack, guru }) => {
      assert.equal(ack.data.items.length, 1);
      assert.equal(guru.calls[0].params.qty, 2);
    },
  },
  {
    key: 'Commerce.check-entitlements',
    params: { productIds: ['prd-1'] },
    guru: { 'valuguru.commerce.entitlements.check': { 'prd-1': true } },
    expect: ({ ack }) => assert.deepEqual(ack.data.entitlements, { 'prd-1': true }),
  },
  {
    key: 'Commerce.get-cart',
    params: {},
    guru: { 'valuguru.commerce.cart.get': { items: [{ id: 'a' }, { id: 'b', savedForLater: true }] } },
    expect: ({ ack }) => {
      assert.equal(ack.data.items.length, 2);
      assert.equal(ack.data.count, 1, 'saved-for-later is in the cart but not in the count');
    },
  },
  {
    key: 'Commerce.create-product',
    params: { title: 'Poster', priceAmount: 5, items: ['res-1'] },
    guru: {
      'valuguru.commerce.products.create': { product: { id: 'prd-9', title: 'Poster', status: 'draft', price_amount: 5 } },
      'valuguru.commerce.products.items.set': {},
    },
    expect: ({ ack, guru }) => {
      assert.equal(ack.data.product.id, 'prd-9');
      assert.equal(ack.data.product.editable, true, 'a draft, and never more');
      const set = guru.callsTo('valuguru.commerce.products.items.set')[0];
      assert.deepEqual(set.params.items, [{ ref: 'i1', type: 'resource', parentRef: null, resourceId: 'res-1', resourceKind: 'file' }]);
    },
  },
  {
    key: 'Commerce.create-product',
    name: 'a bundle price becomes the curator fee the server actually charges',
    params: { title: 'Bundle', priceAmount: 3, items: [{ productId: 'prd-1' }] },
    guru: {
      'valuguru.commerce.products.create': (params) => ({ product: { id: 'prd-10', status: 'draft', ...params } }),
      'valuguru.commerce.products.items.set': {},
    },
    expect: ({ guru }) => {
      const create = guru.callsTo('valuguru.commerce.products.create')[0];
      assert.equal(create.params.priceAmount, 0, 'a bundle\'s own price is never charged');
      assert.equal(create.params.curatorFeeType, 'fixed');
      assert.equal(create.params.curatorFeeValue, 3);
    },
  },
  {
    key: 'Commerce.create-product',
    name: 'no title means the platform FORM, which is a host surface',
    params: {},
    guru: {},
    expect: ({ ack, guru }) => {
      assert.equal(ack.error.code, ERROR_CODES.UNSUPPORTED);
      assert.equal(guru.calls.length, 0);
    },
  },
  {
    key: 'Commerce.list-my-products',
    params: {},
    guru: { 'valuguru.commerce.products.list': { store: { id: 'st-1' }, products: [{ id: 'prd-1', status: 'draft', price_amount: '4', content_count: 2 }] } },
    expect: ({ ack }) => {
      assert.equal(ack.data.hasStore, true);
      // Raw snake_case rows in, the vocabulary update-product takes out.
      assert.equal(ack.data.products[0].priceAmount, 4);
      assert.equal(ack.data.products[0].contentCount, 2);
    },
  },
  {
    key: 'Commerce.get-my-product',
    params: { productId: 'prd-1' },
    guru: {
      'valuguru.commerce.products.get': { product: { id: 'prd-1', status: 'draft' } },
      'valuguru.commerce.products.items.get': {
        items: [
          { id: 'f1', item_type: 'folder', parent_item_id: null, title: 'Unit 1', sort_order: 0 },
          { id: 'r1', item_type: 'resource', parent_item_id: 'f1', resource_id: 'res-1', sort_order: 0 },
        ],
      },
    },
    expect: ({ ack }) => {
      // A read → edit → write round trip has to keep the tree it started with.
      assert.deepEqual(ack.data.items, [{ folder: 'Unit 1', items: [{ resourceId: 'res-1' }] }]);
    },
  },
  {
    key: 'Commerce.update-product',
    params: { productId: 'prd-1', title: 'New name' },
    guru: {
      'valuguru.commerce.products.get': { product: { id: 'prd-1', status: 'draft' } },
      'valuguru.commerce.products.update': { product: { id: 'prd-1', status: 'draft', title: 'New name' } },
    },
    expect: ({ ack, guru }) => {
      assert.equal(ack.data.product.title, 'New name');
      assert.deepEqual(guru.callsTo('valuguru.commerce.products.update')[0].params, { productId: 'prd-1', title: 'New name' });
    },
  },
  {
    key: 'Commerce.update-product',
    name: 'a live product is frozen for its buyers, and the status is read FIRST',
    params: { productId: 'prd-1', title: 'New name' },
    guru: { 'valuguru.commerce.products.get': { product: { id: 'prd-1', status: 'active' } } },
    expect: ({ ack, guru }) => {
      assert.equal(ack.error.code, ERROR_CODES.FORBIDDEN);
      assert.equal(guru.callsTo('valuguru.commerce.products.update').length, 0);
    },
  },
  {
    key: 'Commerce.update-product',
    name: 'an empty items list is refused rather than obeyed',
    params: { productId: 'prd-1', items: [] },
    guru: {},
    expect: ({ ack, guru }) => {
      assert.equal(ack.error.code, ERROR_CODES.INVALID_PARAMS);
      assert.equal(guru.calls.length, 0, 'a caller that meant to add one file and sent none must not empty the product');
    },
  },

  // --- AiGuru --------------------------------------------------------------
  {
    key: 'AiGuru.get-chat-history',
    params: { chatId: 'chat-1' },
    host: { getChatHistory: async (id) => ({ session: { id }, messages: [{ body: 'hi' }] }) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.session.id, 'chat-1');
      assert.equal(calls.length, 0, 'there is no RPC for this — it is host state');
    },
  },
  {
    key: 'AiGuru.get-chat-history',
    name: 'a runtime without the state says which capability is missing',
    params: {},
    host: null,
    expect: ({ ack }) => {
      assert.equal(ack.error.code, ERROR_CODES.UNSUPPORTED);
      assert.match(ack.error.message, /getChatHistory/);
    },
  },
  {
    key: 'AiGuru.get-agent-history',
    params: { agentId: 'agent-1' },
    host: { getAgentHistory: async (id) => ({ agent: { id }, messages: [] }) },
    expect: ({ ack }) => assert.equal(ack.data.agent.id, 'agent-1'),
  },
  {
    key: 'AiGuru.query-knowledge-base',
    params: { query: 'what is verus' },
    guruMessages: { rag_search: { ok: true, toolName: 'kb', result: 'an answer' } },
    expect: ({ ack, guru }) => {
      assert.deepEqual(ack.data, { toolName: 'kb', result: 'an answer' });
      assert.equal(guru.sent[0].message.type, 'rag_search');
    },
  },
  {
    key: 'AiGuru.query-knowledge-base',
    name: 'a refusal from the RAG backend is an error ack',
    params: { query: 'x' },
    guruMessages: { rag_search: { ok: false, error: 'two tools registered, name one' } },
    expect: ({ ack }) => assert.match(ack.error.message, /name one/),
  },

  // --- Developer -----------------------------------------------------------
  {
    key: 'Developer.list-applications',
    params: {},
    host: { listDeveloperApplications: async () => [{ appId: 'a-1' }] },
    expect: ({ ack }) => assert.equal(ack.data.applications.length, 1),
  },
  {
    key: 'Developer.create-application',
    params: { name: 'My App', icon: 'fa-rocket' },
    host: { createDeveloperApplication: async (manifest) => ({ appId: 'my-app', ...manifest }) },
    expect: ({ ack }) => {
      assert.equal(ack.data.appId, 'my-app');
      assert.equal(ack.data.icon, 'fa-light fa-rocket', 'a bare name gets the app-wide default weight');
    },
  },
  {
    key: 'Developer.create-application',
    name: 'a non-URL url is a caller mistake, not a silent fallback',
    params: { name: 'My App', url: 'example.com' },
    host: { createDeveloperApplication: async () => ({}) },
    expect: ({ ack }) => assert.equal(ack.error.code, ERROR_CODES.INVALID_PARAMS),
  },

  // --- VerusWallet ---------------------------------------------------------
  {
    key: 'VerusWallet.get-balance',
    params: { agentId: 'agent-1' },
    host: { getAgentWallet: async () => ({ identityName: 'alice@', iAddress: 'i-1', balance: 12.5, status: 'created' }) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.balance, 12.5);
      assert.equal(calls.length, 0, 'the app reads the store cache and does not hit the network — nor do we');
    },
  },
  {
    key: 'VerusWallet.transfer',
    params: { agentId: 'agent-1', destination: 'bob@', amount: 3 },
    host: { getAgentWallet: async () => ({ identityName: 'alice@', iAddress: 'i-1', status: 'created' }) },
    rpc: { 'verus:sendCurrency': ok({ txid: 'tx-1' }) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.data.txid, 'tx-1');
      assert.deepEqual(calls[0].data, {
        fromIdentity: 'alice@', fromIAddress: 'i-1', destination: 'bob@', amount: 3, currency: null, memo: null,
      });
    },
  },
  {
    key: 'VerusWallet.transfer',
    name: 'a wallet still being created is refused before the spend',
    params: { agentId: 'agent-1', destination: 'bob@', amount: 3 },
    host: { getAgentWallet: async () => ({ identityName: 'alice@', status: 'pending' }) },
    rpc: { 'verus:sendCurrency': ok({ txid: 'tx-1' }) },
    expect: ({ ack, calls }) => {
      assert.equal(ack.error.code, ERROR_CODES.INVALID_PARAMS);
      assert.equal(calls.length, 0);
    },
  },
];

// ===========================================================================
// The harness.
// ===========================================================================

/**
 * @param {object} options
 * @param {string} options.name Adapter name, for the test titles.
 * @param {(responder: Responder) => {socket: object}} options.makeSocket
 */
export function runFunctionSuite({ name, makeSocket }) {
  for (const testCase of CASES) {
    const descriptor = findDescriptor(testCase.key);
    const title = `${name}: ${testCase.key}${testCase.name ? ` — ${testCase.name}` : ''}`;

    test(title, async () => {
      assert.ok(descriptor, `${testCase.key} is not a declared function`);

      const responder = new Responder(testCase.rpc ?? {});
      const { socket } = makeSocket(responder);
      const guru = new FakeGuru(testCase.guru ?? {}, testCase.guruMessages ?? {});
      const host = testCase.host === null ? null : new FakeHost(testCase.host ?? {});
      const fetch = fakeFetch();

      const transport = new SocketTransport({
        socket,
        guru,
        host,
        fetchImpl: fetch,
        config: CONFIG,
        now: NOW,
        applicationId: testCase.applicationId === null ? null : (testCase.applicationId ?? APPLICATION_ID),
        registry: registerAll(new ServiceRegistry()),
      });
      // No cache and no retries: a per-function case asserts what the function
      // sends and answers, and both of those would blur it.
      const client = new ServiceClient({ transport, cache: null });

      const ack = await client.call(testCase.key, testCase.params, { retries: 0 });
      testCase.expect({ ack, calls: responder.calls, responder, guru, host, fetch });
    });
  }

  test(`${name}: every implemented function has a case`, () => {
    const covered = new Set(CASES.map((c) => c.key));
    const missing = SERVICE_DESCRIPTORS
      .filter((d) => d.binding !== 'host')
      .map((d) => d.key)
      .filter((key) => !covered.has(key));
    assert.deepEqual(missing, [], 'a function without a conformance case is a function nobody ran');
  });
}
