// ===========================================================================
// Where an app may send things and still count as "inside Valu".
//
// The privacy audit (docs/privacy-audit.md) fails an app whose code reaches any
// other address. This list is the one place that says which addresses are Valu:
// the valu-api host, the Valu Social sites a person signs in on, and the
// Roomful API that serves resource images. The app's own site is Valu too
// (Valu hosts every audited app), but ANOTHER app's site on the same parent
// domain is not — it is somebody else's app — so `*.valuguru.app` is never a
// wildcard here; the caller passes the app's own origin as `siteOrigin`.
//
// An entry with a `path` matches only under that path, for hosts that serve
// other people's content too.
// ===========================================================================

/** @typedef {{origin: string, path?: string, why: string}} ValuOrigin */

/** @type {readonly ValuOrigin[]} */
export const VALU_ORIGINS = Object.freeze([
  { origin: 'https://api.valuguru.app', why: 'The valu-api host page an app outside Valu Social talks to.' },
  { origin: 'https://valuguru.texpo.io', why: "valu-api's default host origin, and the Valu Guru server." },
  { origin: 'https://texpo.io', why: 'Valu Social (texpo brand): sign-in and the framing app.' },
  { origin: 'https://live.valuverse.io', why: 'Valu Social (Valuverse brand): sign-in and the framing app.' },
  { origin: 'https://valu-social.com', why: 'Valu Social: sign-in and the framing app.' },
  { origin: 'https://chabaduniverse.com', why: 'Valu Social (Chabad Universe brand): sign-in and the framing app.' },
  { origin: 'https://app.roomful.net', why: 'The Roomful web app that resource share links point at.' },
  { origin: 'https://api.roomful.net', why: 'The Roomful API: resource thumbnails and files.' },
].map((entry) => Object.freeze(entry)));

/**
 * Whether a URL an app's code names stays inside Valu.
 *
 * A URL with no scheme is relative, so it is the app's own site. `data:` and
 * `blob:` never leave the page. Anything that does not parse is not Valu.
 *
 * @param {string} url
 * @param {{siteOrigin?: string}} [opts] the audited app's own origin
 * @returns {boolean}
 */
export function isValuUrl(url, opts = {}) {
  const text = String(url ?? '').trim();
  if (!text) return false;
  if (/^(data|blob):/i.test(text)) return true;
  // No scheme and not protocol-relative: a path on the app's own site.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text) && !text.startsWith('//')) return true;

  let parsed;
  try {
    parsed = new URL(text.startsWith('//') ? `https:${text}` : text);
  } catch {
    return false;
  }
  if (opts.siteOrigin && parsed.origin === safeOrigin(opts.siteOrigin)) return true;
  return VALU_ORIGINS.some(
    (entry) => parsed.origin === entry.origin && (!entry.path || parsed.pathname.startsWith(entry.path)),
  );
}

/**
 * The host a URL names, for a finding's `host` field; `null` for a relative URL
 * or one that does not parse.
 * @param {string} url
 * @returns {string|null}
 */
export function hostOf(url) {
  const text = String(url ?? '').trim();
  try {
    return new URL(text.startsWith('//') ? `https:${text}` : text).host || null;
  } catch {
    return null;
  }
}

function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
