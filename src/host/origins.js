// ===========================================================================
// Origin matching for the host: what counts as an origin, whether it is a
// local one, and whether it fits an allow-list pattern.
//
// An origin here is what a browser reports in `event.origin` and in
// `location.ancestorOrigins`: `http(s)://host[:port]`, lower case, no path.
// Anything else (`'null'` from a sandboxed frame, `'*'`, an empty string, a URL
// with a path, an IPv6 literal) is not one, and never matches anything. A
// pattern that is not well formed never matches either, so a typo in
// configuration refuses and does not allow.
//
// Patterns, in the spirit of a CSP host source:
//
//   https://demo.valuguru.app     exactly that origin (scheme, host and port)
//   https://*.valuguru.app        any subdomain, one label or more; not the apex
//   http://localhost:*            any port, or none
//
// No DOM, no I/O.
// ===========================================================================

/** `http(s)://host[:port]`, lower case: what a browser reports as an origin. */
const ORIGIN_RE = /^(https?):\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d{1,5}))?$/;
/** An origin pattern: `*.` stands for one or more labels, `:*` for any port or none. */
const PATTERN_RE = /^(https?):\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d{1,5}|\*))?$/;
/** The origins a development page runs on. */
const LOCAL_ORIGIN_RE = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

/** Is `value` an origin a message can be answered at? */
export const isOrigin = (value) => typeof value === 'string' && ORIGIN_RE.test(value);

/**
 * Is `value` a path a host page can be served at: `/`, `/host/`, `/a/b/`? It
 * starts and ends with `/`, and each segment is plain (letters, digits, `.`
 * `_` `~` `-`) and never `.` or `..`, so appending it to an origin cannot
 * leave that origin or reach a query, a fragment or another path than the one
 * written.
 */
export const isHostPath = (value) => typeof value === 'string'
  && /^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(value)
  && !value.split('/').some((segment) => segment === '.' || segment === '..');

/** Is `value` `http://localhost` or `http://127.0.0.1`, on any port? (Exactly those hosts: no look-alikes.) */
export const isLocalOrigin = (value) => typeof value === 'string' && LOCAL_ORIGIN_RE.test(value);

/**
 * Does `origin` fit `pattern`? Scheme and port must agree (a pattern with no
 * port matches an origin with none), the host exactly or, with `*.`, as a
 * subdomain. A pattern or an origin that is not well formed never matches.
 * @param {string} pattern
 * @param {string} origin
 */
export function matchesOrigin(pattern, origin) {
  const want = PATTERN_RE.exec(String(pattern).toLowerCase());
  const got = ORIGIN_RE.exec(String(origin).toLowerCase());
  if (!want || !got) return false;
  const [, wantScheme, subdomain, wantHost, wantPort] = want;
  const [, scheme, host, port] = got;
  if (wantScheme !== scheme) return false;
  if (wantPort !== '*' && wantPort !== port) return false;
  return subdomain ? host.endsWith(`.${wantHost}`) : host === wantHost;
}
