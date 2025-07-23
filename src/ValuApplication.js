
/**
 * Abstract base class for Valu iframe applications.
 *
 * Developers should extend this class to implement application-specific logic
 * for handling lifecycle events within the Valu Social ecosystem.
 *
 * The Valu API will automatically call these lifecycle methods when the host
 * application sends corresponding events (e.g., app launch, new intent, destroy).
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
}
