// ===========================================================================
// Resources — 5 functions: 4 `local`, 1 `roomful`.
//
// The four URL builders take no network at all: a resource's public links are
// an origin plus its id, which is why the plan classes them local and why the
// server can build them with no socket (valu-tools/resources.ts).
//
// PARITY NOTE on `get-thumbnail-url`. The app does NOT build this one — it
// emits `resource:getThumbnailUrl`, which answers a URL *plus decryption
// metadata* for an encrypted resource. The server builds the public
// `/api/v0/resource/thumbnail/{size}/{id}` URL instead, unauthenticated, and
// Phase 1 classed the function `local` on that basis. The SDK builds it, so a
// caller holding an ENCRYPTED resource gets a URL it cannot decrypt with.
// Recorded in docs/parity.md as the one place where this phase's behaviour is
// knowingly the server's and not the app's.
// ===========================================================================
import { ok, rpc, str, limit } from './support.js';
import { RESOURCE_PREVIEW, RESOURCE_LINK } from '../../Config.js';

const id = (value) => encodeURIComponent(String(value).trim());

export function register(registry) {
  registry
    .define('Resources.generate-public-url', (params, ctx) =>
      ok({ url: `${ctx.config.webBase}/${RESOURCE_PREVIEW}/${id(params.resourceId)}` }))

    .define('Resources.generate-best-view-url', (params, ctx) =>
      ok({ url: `${ctx.config.webBase}/${RESOURCE_LINK}/${id(params.resourceId)}` }))

    .define('Resources.generate-direct-public-url', (params, ctx) =>
      ok({ url: `${ctx.config.apiGate}/api/v0/resource/${id(params.resourceId)}` }))

    .define('Resources.get-thumbnail-url', (params, ctx) => {
      const size = Math.trunc(Number(params.thumbnailSize) || 256);
      return ok({ url: `${ctx.config.apiGate}/api/v0/resource/thumbnail/${size}/${id(params.resourceId)}` });
    })

    // The one that does go to the socket: the shared bot-avatar directory,
    // searched like any other belonging. The network's deny tags are an APPLICATION
    // policy (networkAvatars.js) — without them the SDK returns the directory
    // as the platform stored it, and the application filters.
    .define('Resources.list-bot-avatars', (params, ctx) => rpc(ctx, 'resource:searchBelonging', {
      belonging: BOT_AVATARS_BELONGING,
      limit: limit(params.limit, 50),
      query: '',
      cursor: '',
    }, (data) => ({
      avatars: (data.resources ?? []).map((r) => ({
        id: r.id,
        name: str(r.title) || str(r.metadata?.fileName),
        tags: Array.isArray(r.tags) ? r.tags : [],
      })),
    })));

  return registry;
}

/**
 * The shared directory bot avatars live in — a fixed platform directory, not a
 * per-network one (valusocial-web src/Configs/networkAvatars.js:23).
 */
export const BOT_AVATARS_BELONGING = 'directory:18ba332a-4e5b-89fb-a188-83cf7c6272fb';
