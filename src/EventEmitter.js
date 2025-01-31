/** @module EventEmitter */

/**
 * @class EventEmitter
 *
 * @property {function(eventName: string, listener: Function, once?: boolean=false): EventEmitter} addEventListener
 * @property {function(eventName: string, listener: Function): EventEmitter} removeEventListener
 * @property {function(eventName: string): EventEmitter} emit
 */
export class EventEmitter {
  #events = [];

  get events() {
    return this.#events;
  }

  get addEventListener() {
    return (eventName, callback, once = false) => {
      const listeners = this.#events[eventName] || [];

      listeners.push({
        callback,
        once
      });
      this.#events[eventName] = listeners;

      return this;
    };
  }

  get removeEventListener() {
    return (eventName = false, callback = false) => {
      if (!eventName) {
        this.#events = {};
      } else if (!callback) {
        this.#events[eventName] = [];
      } else {
        const listeners = this.#events[eventName] || [];

        for (let i = listeners.length - 1; i >= 0; i--) {
          if (listeners[i].callback === callback) listeners.splice(i, 1);
        }
      }

      return this;
    };
  }

  get emit() {
    return (eventName, ...parameters) => {
      const listeners = this.#events[eventName] || [];
      const onceListeners = [];
      const specialEvent = ['__before__', '__after__'].indexOf(eventName) !== -1;

      let returnValue, lastValue;

      specialEvent || this.emit.apply(this, ['__before__', eventName].concat(parameters));

      for (let i = 0, length = listeners.length; i < length; i++) {
        const listener = listeners[i];

        if (listener === undefined) {
          console.error('Error: incorrect event behaviour!');
          return;
        }

        if (listener.callback) {
          lastValue = listener.callback.apply(this, parameters);
        } else {
          listener.once = true;
        }

        if (listener.once) onceListeners.push(i);
        if (lastValue !== undefined) returnValue = lastValue;
      }

      for (let i = onceListeners.length - 1; i >= 0; i--) {
        listeners.splice(onceListeners[i], 1);
      }

      specialEvent || this.emit.apply(this, ['__after__', eventName].concat(parameters));

      return returnValue;
    };
  }
}
