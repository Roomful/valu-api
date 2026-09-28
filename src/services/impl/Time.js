// ===========================================================================
// Time — 1 function, `local`.
//
// Ported from valusocial-web/src/Services/Time/TimeService.js. Every field
// describes the SAME instant: `iso` is local wall-clock with its offset,
// `utcIso` the same moment in UTC. A model that has to guess "now" from its
// training data guesses wrong, which is the whole reason this exists.
//
// Phase 2b reconciled the server's `system__get_user_timezone` against this
// one: same question, different clock. This intent declares NO params, so it
// answers about the caller and only the caller; asking about another user is
// not declared anywhere, and widening the intent is the app's manifest to
// change rather than this package's. See docs/parity.md.
// ===========================================================================
import { ok } from './support.js';

const pad2 = (n) => String(n).padStart(2, '0');
const pad3 = (n) => String(n).padStart(3, '0');

const formatOffset = (offsetMinutes) => {
  if (offsetMinutes === 0) return '+00:00';
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
};

/**
 * Snapshot the local clock.
 * @param {{now?: Date}} [options] `now` is injectable so a caller can render a
 *   fixed instant — which is also how this is tested.
 */
export function getLocalTime({ now = new Date() } = {}) {
  // getTimezoneOffset is local-to-UTC and POSITIVE when local is behind. Flip
  // it so `offsetMinutes` follows ISO 8601 (+120 for CEST), which is what the
  // string form already says.
  const offsetMinutes = -now.getTimezoneOffset();
  const localDate = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const localTime = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const iso = `${localDate}T${localTime}:${pad2(now.getSeconds())}.${pad3(now.getMilliseconds())}${formatOffset(offsetMinutes)}`;

  let timezone = '';
  let locale = '';
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    timezone = resolved.timeZone || '';
    locale = resolved.locale || '';
  } catch {
    // No Intl: iso / utcIso / offsetMinutes do not depend on it and still hold.
  }

  let dayOfWeek = '';
  try { dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' }); } catch { /* as above */ }

  return { iso, utcIso: now.toISOString(), timezone, offsetMinutes, dayOfWeek, localDate, localTime, locale };
}

export function register(registry) {
  registry.define('Time.get-local-time', (params, ctx) => ok(getLocalTime({ now: ctx.now?.() })));
  return registry;
}
