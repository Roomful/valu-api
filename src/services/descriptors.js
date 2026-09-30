// ===========================================================================
// The descriptor index.
//
// One descriptor per function: service, function, params schema, return shape,
// scopes, availability, binding and cache policy. The catalogue is generated
// from the app's SERVICE_MANIFESTS (scripts/generate.mjs); this module is the
// runtime view over it — lookup, listing, and the name forms a caller may use.
// ===========================================================================
import { SERVICE_DESCRIPTORS, SERVER_ONLY_TOOLS } from './catalog.generated.js';

/**
 * @typedef {object} DescriptorParam
 * @property {string} name
 * @property {'string'|'number'|'boolean'|'object'|'array'|'string[]'|'object[]'|'FileList'} type
 * @property {string} description
 * @property {string[]} [options] Allowed values, when the param is an enum.
 */

/**
 * @typedef {object} ServiceDescriptor
 * @property {string} key `Service.action` — the canonical id.
 * @property {string} service
 * @property {string} action Kebab-case, as declared in the manifest.
 * @property {string} fn Snake-case — the server's tool-name form.
 * @property {string} method camelCase — the generated TypeScript method.
 * @property {string} toolName `service__<Service>__<fn>`.
 * @property {string} description
 * @property {string[]} availability `ai` / `developer`.
 * @property {string[]} scopes Scopes a caller must hold.
 * @property {'socket'|'local'|'postmessage'} binding What serves this function.
 * @property {boolean} mutates
 * @property {{mode: 'none'|'read-through'|'seeded', ttlMs?: number, key?: string|null}} cache
 * @property {{type: string, description: string}} returns
 * @property {{required: DescriptorParam[], optional: DescriptorParam[]}} params
 * @property {string|null} implementedBy Existing server tool, when there is one.
 */

const byKey = new Map();
const byAlias = new Map();

for (const descriptor of SERVICE_DESCRIPTORS) {
  Object.freeze(descriptor);
  byKey.set(descriptor.key, descriptor);
  // A caller may name a function any of the four ways the platform already
  // writes it. They resolve to one descriptor.
  byAlias.set(descriptor.key.toLowerCase(), descriptor);
  byAlias.set(`${descriptor.service}.${descriptor.fn}`.toLowerCase(), descriptor);
  byAlias.set(`${descriptor.service}.${descriptor.method}`.toLowerCase(), descriptor);
  byAlias.set(descriptor.toolName.toLowerCase(), descriptor);
}

Object.freeze(SERVICE_DESCRIPTORS);

/**
 * Resolve a function name to its descriptor.
 *
 * Accepts `Users.search-users`, `Users.search_users`, `Users.searchUsers` or
 * `service__Users__search_users`.
 * @param {string} name
 * @returns {ServiceDescriptor|undefined}
 */
export function findDescriptor(name) {
  if (typeof name !== 'string') return undefined;
  return byKey.get(name) ?? byAlias.get(name.toLowerCase());
}

/** Every descriptor, optionally filtered. */
export function listDescriptors({ service, binding, availability, mutates } = {}) {
  return SERVICE_DESCRIPTORS.filter((d) =>
    (service === undefined || d.service === service)
    && (binding === undefined || d.binding === binding)
    && (availability === undefined || d.availability.includes(availability))
    && (mutates === undefined || d.mutates === mutates));
}

/** Declared service ids, in catalogue order. */
export function listServices() {
  return [...new Set(SERVICE_DESCRIPTORS.map((d) => d.service))];
}

/** Descriptor counts by binding — the parity numbers, straight from the source. */
export function catalogSummary() {
  const summary = { total: SERVICE_DESCRIPTORS.length, socket: 0, local: 0, postmessage: 0, implemented: 0 };
  for (const d of SERVICE_DESCRIPTORS) {
    summary[d.binding]++;
    if (d.implementedBy) summary.implemented++;
  }
  summary.sdkable = summary.socket + summary.local;
  summary.remaining = summary.sdkable - summary.implemented;
  summary.serverOnly = SERVER_ONLY_TOOLS.length;
  return summary;
}

export { SERVICE_DESCRIPTORS, SERVER_ONLY_TOOLS };
