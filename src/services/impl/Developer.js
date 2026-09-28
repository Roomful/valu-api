// ===========================================================================
// Developer — 2 functions, channel `host-state`.
//
// Registering an application is not an RPC: DeveloperService builds a manifest
// (slug, icon, dock composition, iframe url), hands it to DeveloperPortalStore
// and then syncs it into the platform's application registry and router. Every
// one of those is host state, and half the work is deciding a slug that does
// not collide with an application the SDK cannot see.
//
// So the SDK does the part that is portable — validating and normalizing what
// the caller gave — and hands the host a clean request. A runtime with no
// Developer Portal gets a 501 naming the capability, not a half-created app.
// ===========================================================================
import { fromHost, str, invalid } from './support.js';

/**
 * Normalize a caller's Font Awesome icon to the manifest's "fa-<weight>
 * fa-<name>" shape. Anything else — a URL, prose, a lone weight — becomes ''
 * so the caller keeps the default icon rather than stamping a broken one.
 * Ported from DeveloperService.#normalizeIcon.
 */
export function normalizeIcon(input) {
  const text = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  const styles = new Set([
    'fa-light', 'fa-solid', 'fa-regular', 'fa-thin', 'fa-duotone', 'fa-brands', 'fa-sharp',
    'fas', 'far', 'fal', 'fat', 'fad', 'fab',
  ]);
  const tokens = text.split(' ').filter(Boolean);
  const isStyle = (t) => styles.has(t.toLowerCase());
  const isName = (t) => /^fa-[a-z0-9-]+$/i.test(t) && !isStyle(t);
  if (!tokens.every((t) => isStyle(t) || isName(t))) return '';
  if (!tokens.some(isName)) return '';
  // `fa-light` is the app-wide default weight, and what every ICON_OPTIONS
  // entry uses — a name with no weight renders as nothing without it.
  return tokens.some(isStyle) ? tokens.join(' ') : `fa-light ${tokens.join(' ')}`;
}

export function register(registry) {
  registry
    .define('Developer.create-application', (params, ctx) => {
      const name = str(params.name).trim();
      if (!name) return Promise.resolve(invalid('name is required'));
      const url = str(params.url).trim();
      // A non-empty value that is not a URL is a caller mistake, not a reason
      // to silently fall back to the (empty until deployed) hosted page.
      if (url && !/^https?:\/\//i.test(url)) {
        return Promise.resolve(invalid('url must be an http(s) URL, e.g. https://example.com'));
      }
      return fromHost(ctx, 'createDeveloperApplication', async (create) => {
        const application = await create({
          name,
          description: str(params.description).trim(),
          ...(url ? { url } : {}),
          icon: normalizeIcon(params.icon),
        });
        if (!application) throw new Error('the Developer Portal created nothing');
        return application;
      });
    })

    .define('Developer.list-applications', (params, ctx) =>
      fromHost(ctx, 'listDeveloperApplications', async (read) => ({ applications: (await read()) ?? [] })));

  return registry;
}
