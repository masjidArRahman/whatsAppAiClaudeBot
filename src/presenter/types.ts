import type { DispatchResponse } from '../dispatcher/types.js';

/**
 * Public contract for the Presenter module.
 */
export interface PresenterInterface {
  /** Turn a Dispatcher result into the final display-ready WhatsApp message text. */
  processResponse(response: DispatchResponse): Promise<string>;
}
