import { invoke } from "@tauri-apps/api/core";
import { getProxyBlockedReason, safeErrorMessage } from "../../lib/errorUtils";
import { PROXY_SAVED_EVENT, type ProxySettings } from "../../atoms/proxy";
import { PROXY_STATUS_EVENT } from "../ProxyNoticeBanner";

/**
 * Whether these settings are complete enough to send to the backend.
 *
 * The settings form debounces a save on every keystroke, so without this the
 * host field sends `{ enabled: true, host: "1", port: 0 }` while the user is
 * still typing. The backend fails closed: it plans from whatever it is given,
 * refuses `port: 0` and an unresolvable host, and leaves the shared HTTP cell
 * with no client at all — so half-typed input takes the whole app offline for
 * as long as it takes to finish the word.
 *
 * A disabled proxy is always submittable: turning the proxy OFF is the recovery
 * path out of a bad one, and it must never be gated on the fields being valid.
 */
export function shouldSubmitProxy(d: {
  enabled: boolean;
  host: string;
  port: number;
}): boolean {
  if (!d.enabled) return true;
  return d.host.trim().length > 0 && d.port > 0;
}

/**
 * Save the proxy settings, reporting why they were refused instead of
 * discarding the rejection.
 *
 * The backend persists before it reconfigures, so a refusal still means the
 * settings reached disk — `onError` is a report, not a rollback prompt.
 *
 * Never interpolates `err.message`: it is an object for both `Api` and
 * `ProxyBlocked`, and "[object Object]" in the banner is the best case.
 */
export async function submitProxy(
  settings: ProxySettings,
  onError: (reason: string) => void,
): Promise<void> {
  try {
    await invoke("set_proxy_settings", { settings });
  } catch (err) {
    console.error("Failed to save proxy settings:", err);
    onError(describe(err, "Could not apply proxy settings"));
  } finally {
    // On both paths. A save that succeeded may have cleared a block, and one
    // that was refused may have created one — the global banner re-reads the
    // status either way rather than inferring it from what was sent.
    window.dispatchEvent(new Event(PROXY_STATUS_EVENT));
    // Also on both paths, and for the same reason: the backend detaches the
    // prerolled gapless branch when it takes the settings, before anything can
    // refuse them.
    window.dispatchEvent(new Event(PROXY_SAVED_EVENT));
  }
}

/**
 * The reason the "Test connection" probe failed.
 *
 * `test_proxy_connection` is `Result<String, String>`, so its rejection is a
 * plain string carrying the precise cause — "proxy port must not be 0",
 * "invalid proxy host: …", the GStreamer version refusal. Replacing that with
 * one fixed sentence about "host, port, and credentials" is what the banner
 * used to do, and it named none of them.
 */
export function proxyTestError(err: unknown): string {
  return describe(err, "Connection failed — check host, port, and credentials");
}

/** A block reason if there is one, else any readable message, else `fallback`.
 *  An empty or whitespace-only message is treated as no message: a banner that
 *  goes red and says nothing is worse than a generic sentence. */
function describe(err: unknown, fallback: string): string {
  const blocked = getProxyBlockedReason(err);
  if (blocked) return blocked;
  const msg = safeErrorMessage(err, fallback).trim();
  return msg.length > 0 ? msg : fallback;
}
