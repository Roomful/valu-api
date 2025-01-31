import {EventEmitter} from "./EventEmitter.js";
import {guid4, nextId} from "./Utils.js";

/**
 * An access point to a specified API based on the provided API name and version.
 * It simplifies interaction with APIs by dynamically resolving the appropriate versioned endpoints or features.
 */
export class APIPointer {

  #apiName;
  #version;
  #guid;
  #eventEmitter;
  #runRequest

  #apiCalls = new Map();


  /**
   * @private
   * @description Unique identifier (GUID) for the API Pointer object.
   * Used for communication between your and valu app.
   * @type {string}
   */
  get guid ()  {
    return this.#guid;
  }

  /**
   * @private
   * @description Stores the API name.
   * @type {string}
   */
  get apiName ()  {
    return this.#apiName;
  }

  /**
   * @private
   * @description Stores the version of the API.
   * @type {string}
   */
  get version ()  {
    return this.#version;
  }

  constructor(apiName, version, runRequest) {
    this.#apiName = apiName
    this.#version = version;
    this.#eventEmitter = new EventEmitter();
    this.#guid = guid4();
    this.#runRequest = runRequest;
  }

  /**
   * Use to subscribe to the API events.
   */
  addEventListener = (...parameters) => this.#eventEmitter.addEventListener(...parameters);

  /**
   * Removes API event subscription.
   */
  removeEventListener = (...parameters) => this.#eventEmitter.removeEventListener(...parameters);

  /**
   * Executes and api request.
   *
   * @param {string} functionName - The name of the function to execute.
   * @param {Object} params - The parameters required for the function execution.
   * @private
   */
  run(functionName, params) {
    let deferredPromise = this.#createDeferred();
    this.#apiCalls[deferredPromise.id] = deferredPromise;
    this.#runRequest(functionName, params, deferredPromise.id, this);

    return deferredPromise.promise;
  }


  postRunResult(requestId, result) {
    let deferred = this.#apiCalls[requestId];
    if(!deferred) {
      console.error(`Failed to postRunResult for ${requestId}`);
      return;
    }

    if(result?.error) {
      deferred.reject(result.error);
    } else {
      deferred.resolve(result);
    }

    delete this.#apiCalls[requestId];
  }

  /**
   * Creates a deferred object with a promise and its resolve/reject functions.
   * @returns {object} A deferred object.
   */
  #createDeferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    return { id: nextId(), promise, resolve, reject };
  }
}