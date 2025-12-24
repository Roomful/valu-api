import {EventEmitter} from "./EventEmitter.js";
import {APIPointer} from "./APIPointer.js";
import {guid4, nextId} from "./Utils.js";
import {Intent} from "./Intent";

export { ValuApplication } from "./ValuApplication.js";
export { Intent } from "./Intent.js";
export { APIPointer } from "./APIPointer.js";


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
  #valuApplication = {};
  #requests = new Map();
  #lastIntent;

  /** @type ValuApplication */
  #applicationInstance = null;


  get connected() {
    return this.#valuApplication.origin !== undefined;
  }

  constructor() {
    globalThis.addEventListener('message', (event) => {
      this.#handleParentMessage(event);
    });
    this.#eventEmitter = new EventEmitter();
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
    const result = await this.#registerApiPointer(apiName, version, guid);

    if(result.error) {
      throw new Error(result.error);
    }

    const apiPointer = new APIPointer(apiName, result.version, guid,(functionName, params, requestId, apiPointer) => {
      this.#onApiRunRequest(functionName, params, requestId, apiPointer);
    });

    return apiPointer;
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

  async #registerApiPointer(apiName, version, guid) {
    let deferredPromise = this.#createDeferred();

    this.#postToValuApp('api:create-pointer', {
      guid: guid,
      api: apiName,
      version: version,
      requestId: deferredPromise.id,
    });

    this.#requests[deferredPromise.id] = deferredPromise;
    return deferredPromise.promise;
  }

  #postToValuApp(name, message) {
     const data = { name: name, message: message};
     this.#valuApplication.source.postMessage(data, this.#valuApplication.origin);
  }

  async #onApiRunRequest(functionName, params, requestId, apiPointer) {

    this.#requests[requestId] = apiPointer;

    this.#postToValuApp('api:run', {
      apiPointerId: apiPointer.guid,
      requestId: requestId,
      functionName: functionName,
      params: params,
    });
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
    let deferredPromise = this.#createDeferred();

    this.#postToValuApp('api:run-intent', {
      applicationId: intent.applicationId,
      action: intent.action,
      params: intent.params,
      requestId: deferredPromise.id,
    });

    this.#requests[deferredPromise.id] = deferredPromise;
    return deferredPromise.promise;
  }

  async callService(intent) {
    let deferredPromise = this.#createDeferred();

    this.#postToValuApp('api:service-intent', {
      applicationId: intent.applicationId,
      action: intent.action,
      params: intent.params,
      requestId: deferredPromise.id,
    });

    this.#requests[deferredPromise.id] = deferredPromise;
    return deferredPromise.promise;
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
    let deferredPromise = this.#createDeferred();
    this.#requests[deferredPromise.id] = deferredPromise;

    this.#postToValuApp('api:run-console', {
      requestId: deferredPromise.id,
      command: command,
    });

    return deferredPromise.promise;
  }


  #runCommand(name, data) {
    this.#postToValuApp('api:run-command', {
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


  #createDeferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    return { id: nextId(), promise, resolve, reject };
  }

  #handleParentMessage(event) {
    if(event.data?.target !== 'valuApi') {
      //console.log('Skipped non valu event: ');
       return;
    }

    const message = event.data.message;
    //console.log('Message From Valu: ', event.data.name, ' ', message);

    switch (event.data.name) {
      case 'api:ready': {
        this.#valuApplication = {
          id : message.applicationId,
          source: event.source,
          origin: event.origin,
        }

        this.#eventEmitter.emit(ValuApi.API_READY);

        const intent = new Intent(message.applicationId, message.action, message.params);
        this.#applicationInstance?.onCreate(intent);
        this.#lastIntent = intent;
        break;
      }

      case 'api:trigger': {
        switch (message.action) {
          case ValuApi.ON_ROUTE: {
            this.#eventEmitter.emit(ValuApi.ON_ROUTE, message.data);
            this.#applicationInstance?.onUpdateRouterContext(message.data);
          }
        }
        break;
      }

      case 'api:new-intent': {
        const intent = new Intent(message.applicationId, message.action, message.params);
        this.#applicationInstance?.onNewIntent(intent);
        break;
      }

      case 'api:run-console-completed': {
        const requestId = event.data.requestId;
        const deferred = this.#requests[requestId];

        if(deferred) {
          deferred.resolve(message);
        } else {
          console.log('Failed to locate console request with Id: ', requestId);
        }

        delete this.#requests[requestId];
        break;
      }

      case 'api:run-completed': {
        const requestId = event.data.requestId;
        const apiPointer = this.#requests[requestId];
        if(!apiPointer)  {
          console.error(`Failed to find Api Pointer for requestId: ${requestId}`);
          break
        }

        apiPointer.postRunResult(requestId, message);
        delete this.#requests[requestId];
        break;
      }

      case 'api:pointer-created': {
        const requestId = event.data.requestId;
        const deferred = this.#requests[requestId];
        if(deferred) {
          deferred.resolve(message);
          delete this.#requests[requestId];
        } else {
          console.log('Failed to locate pointer create request with Id: ', requestId);
        }

        break;
      }
    }
  }
}