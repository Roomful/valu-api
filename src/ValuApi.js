import {EventEmitter} from "./EventEmitter.js";
import {APIPointer} from "./APIPointer.js";
import {guid4, nextId} from "@/valu-api/Utils.js";


/**
 * Allows to invoke functions of a registered Valu application and subscribe to its events.
 *
 * More info:
 * https://github.com/Roomful/valu-api
 */
export class ValuApi {

  static API_READY = 'api:ready'

  #eventEmitter;
  #valuApplication = {};
  #apiRequests = {};
  #consoleCommands = new Map();


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
   * @param {string} [version] The optional version of the API module. If not provided, the APIPointer will be bound to the latest available version.
   * @returns {APIPointer} An APIPointer object bound to the specified API version (or the latest version if no version is specified).
   *
   * The APIPointer object provides the ability to:
   * - Run functions within the specified API module.
   * - Subscribe to events associated with the module.
   *
   * This method enables interaction with a specific version of an API module, allowing users to access its functionality and listen to events.
   */
  getApi(apiName, version) {
    const apiPointer = new APIPointer(apiName, version, (functionName, params, requestId, apiPointer) => {
      this.#onApiRunRequest(functionName, params, requestId, apiPointer);
    });
    this.#registerApiPointer(apiPointer);
    return apiPointer;
  }

  #registerApiPointer(apiPointer) {
    this.#postToValuApp('api:create-pointer', {
      guid: apiPointer.guid,
      api: apiPointer.apiName,
      version: apiPointer.version,
    });
  }

  #postToValuApp(name, message) {
     const data = { name: name, message: message};

     console.log('Posting to Valu: ', name, ' ', message, ' source: ', this.#valuApplication.source);
     this.#valuApplication.source.postMessage(data, this.#valuApplication.origin);
  }

  async #onApiRunRequest(functionName, params, requestId, apiPointer) {
    console.log('onApiRunRequest', this);

    this.#apiRequests[requestId] = apiPointer;

    this.#postToValuApp('api:run', {
      apiPointerId: apiPointer.guid,
      requestId: requestId,
      functionName: functionName,
      params: params,
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
    let deferredPromise = this.#createDeferred();
    this.#consoleCommands[deferredPromise.id] = deferredPromise;

    this.#postToValuApp('api:run-console', {
      requestId: deferredPromise.id,
      command: command,
    });

    return deferredPromise.promise;
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
    console.log('Message From Valu: ', event.data.name, ' ', message);

    switch (event.data.name) {
      case 'api:ready': {
        this.#valuApplication = {
          id : message,
          source: event.source,
          origin: event.origin,
        }

        this.#eventEmitter.emit(ValuApi.API_READY);
        break;
      }

      case 'api:run-console-completed': {
        const requestId = event.data.requestId;
        const deferred = this.#consoleCommands[requestId];
        if(deferred) {
          deferred.resolve(message);
        } else {
          console.log('Failed to locate console request with Id: ', requestId);
        }

        delete this.#consoleCommands[requestId];
        break;
      }

      case 'api:run-completed': {
        const requestId = event.data.requestId;
        const apiPointer = this.#apiRequests[requestId];
        if(!apiPointer)  {
          console.error(`Failed to find Api Pointer for requestId: ${requestId}`);
          break
        }

        apiPointer.postRunResult(requestId, message);
        delete this.#apiRequests[requestId];
        break;
      }
    }
  }
}