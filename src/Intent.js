
export class Intent {

  // Predefined actions
  static ACTION_VIEW = 'view';
  static ACTION_OPEN = 'open';


  // Private fields
  #applicationId;
  #action;
  #params;

  /** @returns {string} */
  get applicationId() {
    return this.#applicationId;
  }

  /** @returns {string} */
  get action() {
    return this.#action;
  }

  /** @returns {Object} */
  get params() {
    return this.#params;
  }



  constructor(applicationId, action = Intent.ACTION_OPEN, params = {}) {
    this.#applicationId = applicationId;
    this.#action = action;
    this.#params = params;
  }

  /**
   * Validates if a given object is a valid Intent instance.
   * @param {any} obj
   * @returns {boolean}
   */
  static isValid(obj) {
    return (
      obj instanceof Intent &&
      typeof obj.applicationId === 'string' &&
      typeof obj.action === 'string'
    );
  }

  /**
   * Returns a stringified representation of the intent.
   * @returns {string}
   */
  toString() {
    return `[Intent] applicationId="${this.applicationId}", action="${this.action}", params=${JSON.stringify(this.params)}`;
  }
}