// ===========================================================================
// Users — 8 functions, channel `roomful`.
//
// Ported from valu-guru-server/src/valu-tools/users.ts, which itself mirrors
// valusocial-web/src/Services/Users/UsersService.js. Both sides already agreed
// on the names and the RPCs, so this is the move the plan called mechanical.
//
// The one thing that is NOT mechanical: `Users.current` has no RPC of its own.
// The app reads `parentStore.baseUser`; headless there is no baseUser, so the
// server resolves the socket's own id through the same `getUsersSimpleInfo`
// that `Users.get` uses. That is what the SDK does, and it works in both
// runtimes — which is why it is here and not behind an app-state capability.
// ===========================================================================
import { rpc, str, num, selfId, invalid } from './support.js';

/** The user the caller asked for, out of a `getUsersSimpleInfo` answer. */
const pickUser = (id) => (data) => {
  const users = Array.isArray(data.users) ? data.users : [];
  return { user: users.find((u) => u?.id === id) ?? users[0] ?? null };
};

export function register(registry) {
  registry
    .define('Users.current', async (params, ctx) => {
      const id = selfId(ctx);
      if (!id) return invalid('no authenticated user on this socket');
      const ack = await rpc(ctx, 'social:getUsersSimpleInfo', { ids: [id] }, pickUser(id));
      return ack.data && !ack.data.user ? invalid('current user not found') : ack;
    })

    .define('Users.get', async (params, ctx) => {
      const userId = str(params.userId);
      const ack = await rpc(ctx, 'social:getUsersSimpleInfo', { ids: [userId] }, pickUser(userId));
      return ack.data && !ack.data.user ? invalid(`user ${userId} not found`) : ack;
    })

    // Searches WITHIN the caller's own connections. Three RPCs behind one
    // function — the filter picks which, exactly as UsersService does.
    .define('Users.search-users', (params, ctx) => {
      const payload = {
        offset: num(params.offset, 0),
        size: num(params.size, 10),
        query: str(params.query),
      };
      const pick = (data) => ({ users: data.users ?? [] });
      switch (params.filter) {
        case 'followers':
          return rpc(ctx, 'social:searchUserFollowers', payload, pick);
        case 'following':
          return rpc(ctx, 'social:searchUserFollowings', payload, pick);
        default: // 'contacts' — friends, which the RPC scopes by forUser.
          return rpc(ctx, 'social:searchUserFriends', { ...payload, forUser: selfId(ctx) }, pick);
      }
    })

    // Discovery across the network — NOT limited to existing connections.
    .define('Users.find-user', (params, ctx) => rpc(ctx, 'social:getSuggestedFriends', {
      query: str(params.query),
      offset: num(params.offset, 0),
      size: num(params.size, 10),
    }, (data) => ({ users: data.users ?? [] })))

    // The four connection writes. The RPC field is `targetUser`, the declared
    // param is `userId`; the mapping is the whole body of each one.
    .define('Users.send-connection-request', (params, ctx) =>
      rpc(ctx, 'social:sendRequest', { targetUser: str(params.userId) }, () => ({})))

    .define('Users.accept-connection-request', (params, ctx) =>
      rpc(ctx, 'social:acceptRequest', { targetUser: str(params.userId) }, () => ({})))

    .define('Users.decline-connection-request', (params, ctx) =>
      rpc(ctx, 'social:declineRequest', { targetUser: str(params.userId) }, () => ({})))

    .define('Users.cancel-connection-request', (params, ctx) =>
      rpc(ctx, 'social:deleteRequest', { targetUser: str(params.userId) }, () => ({})));

  return registry;
}
