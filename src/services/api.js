// ===========================================================================
// The function surface.
//
// `client.call('Users.current')` is a string and an object; this is
// `valu.Users.current()`. The difference is not sugar — a string is checked
// when it runs and a method is checked when it is written, and the caller that
// matters here is an agent runtime wiring 65 functions into an LLM, where a
// typo in a service name is a tool that silently never works.
//
// What is on this tree: the service functions — everything in the catalogue,
// which is everything this package can run itself over the ONE connection it
// holds, the Roomful socket. An intent the Valu Social application serves
// itself is not declared here at all; an iframe application asks for one by
// name (ValuApi.callService). One rule, no exceptions, so "is there a function
// for it" and "can this run outside a frame" are the same question.
//
//   import { createValuServices, NodeSocketAdapter } from '@arkeytyp/valu-api';
//
//   const valu = createValuServices({ socket: new NodeSocketAdapter(connection) });
//
//   const { data } = await valu.Users.current();               // the ack
//   const me       = await valu.data.Users.current();          // or the data
//   const rooms    = await valu.data.Rooms.searchRooms({ query: 'design' });
//
// Both trees are the same functions over the same client — `valu.X.y()`
// resolves the ack envelope and never rejects; `valu.data.X.y()` returns the
// payload and throws `ValuServiceError`. Which one a codebase wants depends on
// whether it is turning failures into tool results (the ack) or writing
// application code (the data).
// ===========================================================================
import { ServiceClient } from './ServiceClient.js';
import { SERVICE_FUNCTIONS, catalogSummary, listServices } from './descriptors.js';
import { toolDefinitions } from './toolDefs.js';
import { SocketTransport } from '../transport/SocketTransport.js';
import { openValuSocket } from '../socket/open.js';
// Imported for its effect: this is what puts the 65 handlers in the default
// registry. A function on the tree with nothing behind it would be the one
// thing worse than no function at all.
import './impl/index.js';

/** Service functions grouped by service, in catalogue order. */
function groupByService() {
  const grouped = new Map();
  for (const descriptor of SERVICE_FUNCTIONS) {
    if (!grouped.has(descriptor.service)) grouped.set(descriptor.service, []);
    grouped.get(descriptor.service).push(descriptor);
  }
  return grouped;
}

/**
 * One namespace — `valu.Users` — with a method per function.
 *
 * The method carries its own descriptor and tool name, so a runtime that
 * builds tools from these functions never has to look the function up by
 * string to find out what it is.
 */
function buildNamespace(descriptors, run) {
  const namespace = {};
  for (const descriptor of descriptors) {
    const method = (params, options) => run(descriptor, params, options);
    Object.defineProperty(method, 'name', { value: descriptor.method });
    method.descriptor = descriptor;
    method.key = descriptor.key;
    method.toolName = descriptor.toolName;
    namespace[descriptor.method] = method;
  }
  return Object.freeze(namespace);
}

function buildTree(run) {
  const tree = {};
  for (const [service, descriptors] of groupByService()) {
    tree[service] = buildNamespace(descriptors, run);
  }
  return Object.freeze(tree);
}

/**
 * The service functions, as functions.
 *
 * A thin object over one {@link ServiceClient}: every method goes through the
 * same descriptor lookup, validation, scope check, cache and call policy the
 * string path does. Nothing is bypassed by using a method — it is the same
 * call with the name already resolved.
 */
export class ValuServiceApi {
  #client;
  #data;
  #connection;

  /**
   * @param {object} options
   * @param {ServiceClient} options.client
   * @param {{close: Function}} [options.connection] A connection this API
   *   OWNS — set only by `connectValuServices({ sessionId })`, which opened it.
   *   An adopted socket never appears here: closing somebody else's connection
   *   because you were done with your calls is not this object's business.
   */
  constructor({ client, connection } = {}) {
    if (!client) throw new TypeError('ValuServiceApi needs a ServiceClient');
    this.#client = client;
    this.#connection = connection ?? null;
    Object.assign(this, buildTree((d, params, opts) => client.call(d.key, params, opts)));
  }

  get client() { return this.#client; }
  get transport() { return this.#client.transport; }
  get cache() { return this.#client.cache; }

  /**
   * The socket every function here runs over.
   *
   * Exposed so a runtime can SHARE one connection: the Valu Social application
   * opens the socket, builds this, and hands `valu.socket` to anything else
   * that needs the same connection rather than opening a second one.
   */
  get socket() { return this.#client.transport?.socket ?? null; }

  /** The connection this API opened, or null when it adopted somebody else's. */
  get connection() { return this.#connection; }

  /**
   * The same tree, unwrapped: every method resolves the payload and throws
   * {@link ValuServiceError} instead of answering an error envelope.
   */
  get data() {
    if (!this.#data) {
      this.#data = buildTree((d, params, opts) => this.#client.invoke(d.key, params, opts));
    }
    return this.#data;
  }

  /** Call by name, for a caller that has a string — an LLM tool call, say. */
  call(name, params, options) { return this.#client.call(name, params, options); }
  /** Call by name, unwrapped. */
  invoke(name, params, options) { return this.#client.invoke(name, params, options); }
  /** @see ServiceClient#subscribe */
  subscribe(event, handler) { return this.#client.subscribe(event, handler); }
  /** @see ServiceClient#seed */
  seed(name, params, data, options) { this.#client.seed(name, params, data, options); return this; }

  /**
   * Drop the caches and subscriptions — and close the connection, but only if
   * this object opened it.
   */
  async close() {
    await this.#client.close();
    await this.#connection?.close();
  }

  /** Every service function, as descriptors. */
  static functions() { return [...SERVICE_FUNCTIONS]; }
  /** Service ids that have at least one function. */
  static services() { return listServices().filter((s) => SERVICE_FUNCTIONS.some((d) => d.service === s)); }
  static summary = catalogSummary;

  /**
   * LLM tool definitions for these functions — the server's use for this
   * package. Defaults to what an AI caller may reach.
   * @see toolDefinitions
   */
  static toolDefinitions(filter) { return toolDefinitions(filter); }
  toolDefinitions(filter) { return toolDefinitions(filter); }
}

 /**
 * Build the function surface, transport and all.
 *
 * Give it a socket and it builds a {@link SocketTransport}:
 *
 *   createValuServices({ socket })   // Node, a browser, an iframe app
 *
 * @param {object} options
 * @param {import('../transport/SocketTransport.js').SocketTransport} [options.transport]
 *   Use this transport as it is — it must serve service functions, so in
 *   practice a `SocketTransport`. Everything below is ignored when it is given.
 * @param {import('../socket/ValuSocket.js').ValuSocket} [options.socket]
 * @param {import('../app-state/AppState.js').AppState} [options.appState]
 * @param {Function} [options.fetchImpl]
 * @param {object} [options.config]
 * @param {() => Date} [options.now]
 * @param {string} [options.applicationId]
 * @param {import('./registry.js').ServiceRegistry} [options.registry]
 * @param {import('../cache/ServiceCache.js').ServiceCache|null} [options.cache]
 * @param {import('../auth/AuthProvider.js').AuthProvider} [options.auth]
 * @param {object} [options.hooks]
 * @returns {ValuServiceApi}
 */
export function createValuServices(options = {}) {
  const { transport, cache, auth, hooks, ...transportOptions } = options;
  if (!transport && !transportOptions.socket) {
    // The two ways to get here are a typo and a misunderstanding, and the
    // second one is worth a sentence: there is no default transport, and an
    // iframe application is not a special case. Everything passes a socket.
    throw new TypeError(
      'createValuServices needs a socket — pass `{ socket }`, a ValuSocket over '
      + 'your Roomful connection (NodeSocketAdapter in Node, BrowserSocketAdapter '
      + 'in a browser). Service functions run over a connection, never over the '
      + 'postMessage bridge.',
    );
  }
  const client = new ServiceClient({
    transport: transport ?? new SocketTransport(transportOptions),
    ...(cache !== undefined ? { cache } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
  });
  return new ValuServiceApi({ client });
}

/**
 * Keys that belong to GETTING a socket rather than to serving functions over
 * one. Kept out of the transport's options so that `sessionId` in particular
 * travels exactly as far as the handshake and no further.
 */
const SOCKET_DOOR_KEYS = [
  'socket', 'sessionId', 'host', 'io', 'bootstrap', 'socketOptions',
  'userId', 'networkId', 'selfUserId', 'onResourceUpdated',
  'timeoutMs', 'readyTimeoutMs', 'recoveryTimeoutMs', 'onConnectionLost',
];

/**
 * The function surface, socket and all — the one call that covers both doors.
 *
 *   // the package opens the connection and authorizes it
 *   const valu = await connectValuServices({ sessionId, io });
 *
 *   // the runtime already has one, and shares the instance
 *   const valu = await connectValuServices({ socket: webSocketService, userId });
 *
 * `createValuServices({ socket })` is still the whole of it when you already
 * hold a `ValuSocket` and want no asynchrony; this adds three things a caller
 * would otherwise write themselves:
 *
 * 1. **Either door**, resolved by {@link openValuSocket}, so switching from an
 *    adopted socket to one of its own is one key in an options object.
 * 2. **Reconnect is wired.** A connection that drops and re-authorizes tells
 *    the transport, which drops the caches it can no longer trust — the one
 *    thing a consumer most reliably forgets, and the one whose symptom is a
 *    stale answer rather than an error.
 * 3. **Ownership.** A connection this call opened is closed by
 *    `valu.close()`; an adopted one never is.
 *
 * @param {object} [options] Everything {@link openValuSocket} takes, plus
 *   everything {@link createValuServices} takes.
 * @returns {Promise<ValuServiceApi>}
 */
export async function connectValuServices(options = {}) {
  const socket = await openValuSocket(options);
  const owned = options.socket ? null : socket;

  const serviceOptions = { ...options };
  for (const key of SOCKET_DOOR_KEYS) delete serviceOptions[key];

  const { transport, cache, auth, hooks, ...transportOptions } = serviceOptions;
  const socketTransport = transport ?? new SocketTransport({ ...transportOptions, socket });
  const client = new ServiceClient({
    transport: socketTransport,
    ...(cache !== undefined ? { cache } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
  });

  // A socket we opened announces its own recovery; one we adopted is the
  // owner's to re-announce (the application already has a reconnect path, and
  // two handlers racing to clear one cache is worse than none).
  if (owned && typeof owned.onReconnected === 'function'
    && typeof socketTransport.handleReconnect === 'function') {
    owned.onReconnected(() => socketTransport.handleReconnect(owned));
  }

  return new ValuServiceApi({ client, ...(owned ? { connection: owned } : {}) });
}
