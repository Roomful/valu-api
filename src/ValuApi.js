import {EventEmitter} from "./EventEmitter.js";
import {APIPointer} from "./APIPointer.js";
import {guid4} from "./Utils.js";
import {Intent} from "./Intent.js";
import {PostMessageTransport} from "./transport/PostMessageTransport.js";
import {Transport} from "./transport/Transport.js";
import {ServiceClient} from "./services/ServiceClient.js";

export { ValuApplication } from "./ValuApplication.js";
export { Intent } from "./Intent.js";
export { APIPointer } from "./APIPointer.js";

// The SDK surface added in Phase 1. Re-exported from the package entry point
// so `import { ... } from '@arkeytyp/valu-api'` reaches all of it.
export { Transport } from "./transport/Transport.js";
export { PostMessageTransport } from "./transport/PostMessageTransport.js";
export { SocketTransport } from "./transport/SocketTransport.js";
export { BrowserSocketAdapter } from "./socket/BrowserSocketAdapter.js";
export { NodeSocketAdapter } from "./socket/NodeSocketAdapter.js";
export {
  isAckError, ackErrorMessage, unwrapAck, dataAck, normalizeAck,
} from "./socket/ValuSocket.js";
export { ValuServiceError, ERROR_CODES, errorAck } from "./Errors.js";
export { ServiceClient } from "./services/ServiceClient.js";
export {
  SERVICE_DESCRIPTORS, SERVER_ONLY_TOOLS, findDescriptor, listDescriptors,
  listServices, catalogSummary,
} from "./services/descriptors.js";
export { validateParams, validationAck } from "./services/validate.js";
export { toolDefinition, toolDefinitions } from "./services/toolDefs.js";
export { ServiceRegistry, serviceRegistry } from "./services/registry.js";
export { ServiceCache } from "./cache/ServiceCache.js";
export { AuthProvider, TokenStore, assertNoCredentialLeak } from "./auth/AuthProvider.js";
export {
  DEFAULT_TIMEOUT_MS, DEFAULT_POLICY, forDescriptor, runWithPolicy, isRetriable, backoffFor,
} from "./CallPolicy.js";


/**
 * Allows to invoke functions of a registered Valu application and subscribe to its events.
 *
 * More info:
 * https://github.com/Roomful/valu-api
 */
export class ValuApi {

  static API_READY = 'api:ready'
  static ON_ROUTE = `on_route`;

  #eventEmitter;
  #transport;
  #lastIntent;
  #services;

  /** @type ValuApplication */
  #applicationInstance = null;


  get connected() {
    return this.#transport.connected;
  }

  /**
   * The transport this instance speaks over.
   *
   * `ValuApi` used to be its own transport — it bound the window's `message`
   * listener and called `postMessage` itself. Both now live behind
   * {@link Transport}; the default is still the host bridge, byte for byte.
   * @returns {Transport}
   */
  get transport() {
    return this.#transport;
  }

  /**
   * The declared-service surface: descriptor lookup, param validation, scopes,
   * cache and the callbacks policy, over this instance's transport.
   * @returns {ServiceClient}
   */
  get services() {
    if (!this.#services) this.#services = new ServiceClient({ transport: this.#transport });
    return this.#services;
  }

  /**
   * @param {{transport?: Transport}} [options] Defaults to the host bridge.
   *   A socket-backed client is built with {@link ServiceClient} over a
   *   {@link SocketTransport} instead.
   */
  constructor(options = {}) {
    this.#eventEmitter = new EventEmitter();
    this.#transport = options.transport ?? new PostMessageTransport();

    this.#transport.addEventListener(Transport.READY, (message) => {
      this.#eventEmitter.emit(ValuApi.API_READY);

      const intent = new Intent(message.applicationId, message.action, message.params);
      this.#applicationInstance?.onCreate(intent);
      this.#lastIntent = intent;
    });

    this.#transport.addEventListener(Transport.TRIGGER, (message) => {
      if (message.action === ValuApi.ON_ROUTE) {
        this.#eventEmitter.emit(ValuApi.ON_ROUTE, message.data);
        this.#applicationInstance?.onUpdateRouterContext(message.data);
      }
    });

    this.#transport.addEventListener(Transport.NEW_INTENT, (message) => {
      const intent = new Intent(message.applicationId, message.action, message.params);
      this.#applicationInstance?.onNewIntent(intent);
    });
  }

  addEventListener = (...parameters) => this.#eventEmitter.addEventListener(...parameters);
  removeEventListener = (...parameters) => this.#eventEmitter.removeEventListener(...parameters);

  /**
   * Retrieves an APIPointer object for a specific API module.
   * @param {string} apiName The name of the API module to retrieve.
   * @param {number} [version] The optional version of the API module. If not provided, the APIPointer will be bound to the latest available version.
   * @returns {APIPointer} An APIPointer object bound to the specified API version (or the latest version if no version is specified).
   *
   * The APIPointer object provides the ability to:
   * - Run functions within the specified API module.
   * - Subscribe to events associated with the module.
   *
   * This method enables interaction with a specific version of an API module, allowing users to access its functionality and listen to events.
   */
  async getApi(apiName, version) {
    const guid = guid4();
    const result = await this.#transport.request('api:create-pointer', {
      guid: guid,
      api: apiName,
      version: version,
    });

    if(result.error) {
      throw new Error(result.error);
    }

    return new APIPointer(apiName, result.version, guid, (functionName, params, requestId, apiPointer) => {
      this.#onApiRunRequest(functionName, params, requestId, apiPointer);
    });
  }

  /**
   * Registers an application instance to handle lifecycle events.
   *
   * Developers should create a class that extends {@link ValuApplication} and implement
   * its lifecycle methods.
   * This instance will receive all lifecycle callbacks sent from the Valu Social host application.
   */
  setApplication(appInstance) {
    this.#applicationInstance = appInstance;

    if(this.#lastIntent) {
      this.#applicationInstance.onCreate(this.#lastIntent).catch(console.error);
    }
  }

  async #onApiRunRequest(functionName, params, requestId, apiPointer) {
    try {
      const result = await this.#transport.request('api:run', {
        apiPointerId: apiPointer.guid,
        functionName: functionName,
        params: params,
      }, requestId);
      apiPointer.postRunResult(requestId, result);
    } catch (error) {
      apiPointer.postRunResult(requestId, { error: error?.message ?? String(error) });
    }
  }

  /**
   * Sends an intent to the Valu application.
   *
   * This method posts the intent data to the Valu application and returns a promise
   * that resolves or rejects when the corresponding response is received.
   *
   * Internally, it creates a deferred promise and assigns a unique `requestId` to track
   * the response for this specific intent execution.
   *
   * @param {Intent} intent - The intent object containing the target application ID, action, and parameters.
   * @returns {Promise<unknown>} A promise that resolves with the response from the Valu application.
   *
   * @example
   * const intent = new Intent('chatApp', Intent.ACTION_OPEN, { roomId: '1234' });
   * const result = await api.sendIntent(intent);
   * console.log(result);
   */
  async sendIntent(intent) {
    return this.#transport.request('api:run-intent', {
      applicationId: intent.applicationId,
      action: intent.action,
      params: intent.params,
    });
  }

  /**
   * Runs a service intent and resolves with the host's raw result.
   *
   * Unchanged. The typed, validated, cached path is {@link ValuApi#services}.
   */
  async callService(intent) {
    return this.#transport.request('api:service-intent', {
      applicationId: intent.applicationId,
      action: intent.action,
      params: intent.params,
    });
  }

  /**
   * Executes a given console command and returns the result of an API function.
   *
   * This method accepts a string command, executes it in the console environment,
   * and processes the output. If the execution is successful, it returns the result
   * of the associated API function as a resolved promise. If the promise fails
   * or an exception occurs during execution, it will return an error message string.
   *
   * @param {string} command - The console command to execute.
   *                          Example: `/chat -h`.
   * @returns {Promise<any|string>} A promise resolving to the API function result. If the promise
   *                                fails or throws an exception, it resolves to an error message string.
   */
  async runConsoleCommand(command) {
    return this.#transport.request('api:run-console', {
      command: command,
    });
  }


  #runCommand(name, data) {
    this.#transport.notify('api:run-command', {
      command: name,
      data: data,
    });
  }

  /**
   * Pushes a new route onto the navigation stack.
   *
   * Use this when:
   *   navigating forward
   *   opening a new view
   *   preserving back-navigation history
   * @param path
   */
  pushRoute = (path) => {
    this.#runCommand('pushRoute', path);
  }

  /**
   * Replaces the current route without adding a new history entry.
   * Use this when:
   *    redirecting
   *    normalizing URLs
   *    preventing back-navigation to the previous route
   * @param {string }path
   */
  replaceRoute = (path) => {
    this.#runCommand('replaceRoute', path);
  }
}
