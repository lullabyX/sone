import { isNetworkError, safeErrorMessage } from "../../lib/errorUtils";

export const OFFLINE_TEXT =
  "Can't reach TIDAL. Check the network connection, then try again.";

/** A TV screen's error line: plain words when offline instead of the raw
 *  request error, else the error's own message or `fallback`. */
export function tvErrorText(e: unknown, fallback: string): string {
  return isNetworkError(e) ? OFFLINE_TEXT : safeErrorMessage(e, fallback);
}
