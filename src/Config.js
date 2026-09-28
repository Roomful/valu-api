// ===========================================================================
// The two origins the local functions need.
//
// `Resources.*` builds share links out of a resource id and an origin. In the
// browser the app reads `window.location` (the deployment serving it) and
// `MetaverseApi.gate`; headless there is no window, and the server reads both
// from the environment. Neither of those is available to a library, so the
// SDK takes them as configuration, defaults them the way each runtime would,
// and says so — a share link pointing at the wrong deployment is a link that
// resolves to a stranger's app, not an error anybody notices.
// ===========================================================================

/** What the app serves from: the origin of the running web app. */
const defaultWebBase = () => {
  const origin = globalThis.location?.origin;
  if (typeof origin === 'string' && origin) return origin;
  return globalThis.process?.env?.ROOMFUL_WEB_BASE || 'https://app.roomful.net';
};

/** The API gate — `https://{apiHost}`, mirroring MetaverseApi.gate. */
const defaultApiGate = () => {
  const host = globalThis.process?.env?.ROOMFUL_API_HOST || 'api.roomful.net';
  return `https://${host}`;
};

/** Path segments the web app routes resource links on (ApplicationEnums). */
export const RESOURCE_PREVIEW = 'preview';
export const RESOURCE_LINK = 'resource';

/**
 * @typedef {object} ValuConfig
 * @property {string} webBase Origin of the web app that renders share links.
 * @property {string} apiGate Origin of the Roomful API.
 */

/**
 * @param {Partial<ValuConfig>} [overrides]
 * @returns {ValuConfig}
 */
export function resolveConfig(overrides = {}) {
  const trim = (value) => String(value).replace(/\/+$/, '');
  return {
    webBase: trim(overrides.webBase || defaultWebBase()),
    apiGate: trim(overrides.apiGate || defaultApiGate()),
  };
}
