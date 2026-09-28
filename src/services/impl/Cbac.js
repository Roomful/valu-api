// ===========================================================================
// Cbac — 5 functions, channel `roomful`. Badge-based access control.
//
// Policy mutations need `manage` on the target; the backend enforces that, and
// the SDK does not second-guess it — a refusal comes back as the platform's
// own error ack with its own message.
//
// A target is (networkId, targetType, targetId) on every call, including the
// delete: the policy id alone does not address a policy.
// ===========================================================================
import { rpc, str, ids, num } from './support.js';

const target = (params) => ({
  networkId: str(params.networkId),
  targetType: str(params.targetType),
  targetId: str(params.targetId),
});

export function register(registry) {
  registry
    .define('Cbac.list-policies', (params, ctx) =>
      rpc(ctx, 'cbac:listPolicies', target(params), (data) => ({ policies: data.policies ?? [] })))

    .define('Cbac.create-policy', (params, ctx) => rpc(ctx, 'cbac:createPolicy', {
      ...target(params),
      badgeIds: ids(params.badgeIds),
      badgeMatchMode: str(params.badgeMatchMode),
      grantedPermission: str(params.grantedPermission),
    }, (data) => ({ policy: data.policy ?? null })))

    .define('Cbac.delete-policy', (params, ctx) => rpc(ctx, 'cbac:deletePolicy', {
      policyId: str(params.policyId),
      ...target(params),
    }, () => ({})))

    // Every badge the caller can see — network-scoped and global. No params:
    // the scope is the caller's own membership.
    .define('Cbac.list-badges', (params, ctx) =>
      rpc(ctx, 'user:listBadges', {}, (data) => ({ badges: data.badges ?? [] })))

    // The reverse lookup of "which badges does this user hold". `total` is the
    // full match count, NOT the size of the page returned.
    .define('Cbac.search-users-by-badge-id', (params, ctx) => rpc(ctx, 'social:searchUsersByBadgeId', {
      badgeId: str(params.badgeId),
      query: str(params.query),
      offset: num(params.offset, 0),
      size: num(params.size, 10),
    }, (data) => ({ users: data.users ?? [], total: data.total ?? 0 })));

  return registry;
}
