// ===========================================================================
// `user_info` — the platform's "you are authenticated" push.
//
// It is the signal both existing clients wait on: the Valu Social application
// (WebSocket.js listenUserInfo) and the Valu Guru server's connection manager
// both treat its arrival as the end of the handshake, and its contents as
// authoritative over anything they resolved beforehand. Parsed in one place
// because two things here need it — the socket this package opens, and an
// adapter over one it was handed — and because the payload comes in two shapes.
// ===========================================================================

/**
 * @typedef {object} ValuUserInfo
 * @property {string|null} selfUserId
 * @property {string|null} networkId
 * @property {Record<string, unknown>|null} user The signed-in user's profile.
 * @property {Record<string, unknown>|null} network The active network.
 */

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Read a `user_info` push.
 *
 * The payload arrives either wrapped (`{data: {user, network}}`) or bare
 * (`{user, network}`) depending on the event wrapper, so both are accepted —
 * exactly as `roomful-connection.ts` does. Anything missing comes back `null`
 * rather than guessed.
 * @param {any} payload
 * @returns {ValuUserInfo}
 */
export function readUserInfo(payload) {
  const body = isPlainObject(payload?.data) ? payload.data : payload;
  const user = isPlainObject(body?.user) ? body.user : null;
  const network = isPlainObject(body?.network) ? body.network : null;
  const id = user?.id ?? null;
  const networkId = network?.id ?? network?.networkId ?? null;
  return {
    selfUserId: id === null || id === undefined ? null : String(id),
    networkId: networkId === null || networkId === undefined ? null : String(networkId),
    user,
    network,
  };
}

/**
 * A display name out of a user object, however the platform spelled it.
 * Best-effort: `null` when there is nothing to show.
 * @param {Record<string, any>|null} user
 */
export function displayNameOf(user) {
  if (!isPlainObject(user)) return null;
  const name = user.name || user.fullName
    || [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name ? String(name) : null;
}
