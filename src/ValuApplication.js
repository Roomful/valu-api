
/**
 * Abstract base class for Valu iframe applications.
 *
 * Developers should extend this class to implement application-specific logic
 * for handling lifecycle events within the Valu Social ecosystem.
 *
 * The Valu API will automatically call these lifecycle methods when the Valu
 * Social application sends corresponding events (e.g., app launch, new intent, destroy).
 */

export class ValuApplication {
  /**
   * Called when the app is first launched with an Intent.
   * @param {Intent} intent
   * @returns {Promise<any>}
   */
  async onCreate(intent) {}

  /**
   * Called when the app receives an Intent while already running (docked).
   * @param {Intent} intent
   * @returns {Promise<any>} - The result will be sent back to the caller
   */
  async onNewIntent(intent) {}

  /**
   * Called when the app is about to be destroyed.
   */
  async onDestroy() {}


  /**
   * Called when the application’s router context changes.
   *
   * This typically happens when:
   *  the app moves between main / side / modal containers
   *  Valu Social updates routing or layout state
   * @param {string} context
   */
  onUpdateRouterContext(context) {};

  /**
   * Called with a Commerce event the app subscribed to, after the
   * `ValuApi.ON_COMMERCE` listeners. Subscribe with the
   * `Commerce.subscribe-events` service intent; nothing arrives otherwise.
   *
   * The event says what changed, never the new state: re-read with the
   * matching intent.
   * @param {{event: string} & Record<string, any>} event e.g.
   *   `{event: 'order-updated', orderId, status}`
   */
  onCommerceEvent(event) {};
}
