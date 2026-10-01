// ===========================================================================
// The descriptor index.
//
// One descriptor per function: service, function, params schema, return shape,
// scopes, availability, channel and cache policy. The catalogue is generated
// from the app's SERVICE_MANIFESTS (scripts/generate.mjs); this module is the
// runtime view over it — lookup, listing, and the name forms a caller may use.
//
// EVERY descriptor is a function this package can run itself, given the one
// connection it holds — the Roomful socket — or with no connection at all.
// Declared intents the Valu Social application serves itself are not in the
// catalogue: either no RPC exists (window management, pickers) or the Valu
// Guru server answers them on a socket this package does not hold (Commerce,
// the knowledge-base search). Both kinds are asked for by name over the
// postMessage bridge instead, and `APPLICATION_INTENT_REASON` says which is
// which (scripts/bindings.js APPLICATION_ONLY, docs/api-pointers.md).
// ===========================================================================
import {
  SERVICE_DESCRIPTORS, SERVER_ONLY_TOOLS, APPLICATION_ONLY_INTENTS,
  APPLICATION_INTENT_REASON,
} from './catalog.generated.js';

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
 * @property {'roomful'|'app-state'|'local'} channel WHAT answers it: the
 *   Roomful socket, state the runtime holds, or the SDK itself.
 * @property {'manifest'|'sdk'} declaredBy Who says this function exists: the
 *   app's SERVICE_MANIFESTS, or this package (scripts/extensions.js).
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

/**
 * The catalogue, under the name the rest of the package calls it by. Every
 * descriptor is a service function; the alias exists because "the service
 * functions" is what this list IS, and reading `SERVICE_DESCRIPTORS` at a call
 * site invites the question of what else might be in there.
 */
export const SERVICE_FUNCTIONS = SERVICE_DESCRIPTORS;

/** Is this name a function this package can run? */
export function isServiceFunction(name) {
  return Boolean(findDescriptor(name));
}

/** Service functions, optionally filtered — the same filters `listDescriptors` takes. */
export function listServiceFunctions(filter = {}) {
  return listDescriptors(filter);
}

/** Every descriptor, optionally filtered. */
export function listDescriptors({ service, channel, declaredBy, availability, mutates } = {}) {
  return SERVICE_DESCRIPTORS.filter((d) =>
    (service === undefined || d.service === service)
    && (channel === undefined || d.channel === channel)
    && (declaredBy === undefined || d.declaredBy === declaredBy)
    && (availability === undefined || d.availability.includes(availability))
    && (mutates === undefined || d.mutates === mutates));
}

/** Declared service ids, in catalogue order. */
export function listServices() {
  return [...new Set(SERVICE_DESCRIPTORS.map((d) => d.service))];
}

/** Descriptor counts by channel — the parity numbers, straight from the source. */
export function catalogSummary() {
  const summary = {
    total: SERVICE_DESCRIPTORS.length,
    roomful: 0, 'app-state': 0, local: 0,
    implemented: 0,
    // WHO declared them. `declared` is a fact about valusocial-web and does not
    // move when this package adds a function; `sdkDeclared` is a fact about
    // this package. Reporting one number for both is how a parity table starts
    // lying (scripts/extensions.js).
    declared: 0, sdkDeclared: 0,
  };
  for (const d of SERVICE_DESCRIPTORS) {
    summary[d.channel]++;
    if (d.implementedBy) summary.implemented++;
    if (d.declaredBy === 'sdk') summary.sdkDeclared++; else summary.declared++;
  }
  summary.socket = summary.roomful;
  summary.serviceFunctions = summary.total;
  summary.applicationOnly = APPLICATION_ONLY_INTENTS.length;
  summary.remaining = summary.total - summary.implemented;
  summary.serverOnly = SERVER_ONLY_TOOLS.length;
  return summary;
}

export {
  SERVICE_DESCRIPTORS, SERVER_ONLY_TOOLS, APPLICATION_ONLY_INTENTS,
  APPLICATION_INTENT_REASON,
};
