import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { safeErrorMessage } from "../lib/errorUtils";
import { PROXY_SAVED_EVENT, type ProxySettings } from "../atoms/proxy";

/** The serialized `proxy::ProxyStatus`, `#[serde(tag = "state")]`. */
type ProxyStatus =
  | { state: "off" }
  | { state: "active"; degraded: string[] }
  | { state: "unreachable"; endpoint: string }
  | { state: "blocked"; reason: string };

/** Dispatched on `window` whenever a save may have changed the status. The
 *  notice re-reads the status rather than guessing from the settings it sent:
 *  the backend, not the form, decides whether a proxy is usable. */
export const PROXY_STATUS_EVENT = "sone:proxy-status";

/** Asked of the authenticated shell, which owns the settings sheet. The detail
 *  is the tab to land on. */
export const OPEN_SETTINGS_EVENT = "sone:open-settings";

/** How often the status is re-read while a proxy is configured.
 *
 *  `unreachable` is *entered* by requests the app was already making, so
 *  nothing tells the notice when one fails — it has to look. Only while a
 *  proxy is configured, though: with the proxy off there is no state this
 *  notice can ever report, so it does not poll at all.
 *
 *  Leaving that state is the half that ordinary requests cannot supply, and
 *  the reason `PROBE_CMD` exists. The count behind `unreachable` is cleared
 *  only by an answered request, and by the time the bar is up the app is
 *  making none — every one of them is the thing that is failing. A user who
 *  repairs the proxy outside SONE, by restarting it or plugging the cable back
 *  in, saves no settings and so rebuilds no client: without a request of our
 *  own the count would sit at its threshold forever.
 *
 *  Long, because nothing here is latency-critical and the call is not free:
 *  `get_proxy_status` decrypts the settings file each time. */
const POLL_MS = 15000;

/** One request through the live client, sent only while the status is already
 *  `unreachable`.
 *
 *  Every other state keeps the property that asking about the proxy puts
 *  nothing on the wire — `off` and `active` have nothing to find out, and
 *  `blocked` has no client to send through. */
const PROBE_CMD = "probe_proxy_reachability";

interface ProxyNotice {
  /** Red for "nothing was sent", amber for "something was sent and vanished". */
  tone: "blocked" | "unreachable";
  headline: string;
  detail: string | null;
}

/**
 * What to say about the proxy right now, or null when there is nothing to say.
 *
 * Two states render, and they are different claims:
 *
 * - `blocked` — the settings could not be turned into a plan, or the client
 *   could not be built. Nothing was sent at all, and the backend knows which
 *   field is at fault, so its reason is shown verbatim.
 * - `unreachable` — requests went out through the proxy and nothing came back.
 *
 * The wording of the second one is the part to leave alone, and it is wider
 * than it first looks it needs to be. reqwest cannot distinguish "the proxy is
 * not there" from "the proxy answered and refused": a 407 on the CONNECT tunnel
 * — which is what a mistyped proxy password produces, and every origin here is
 * HTTPS so every request tunnels — comes back as the same `Kind::Request` +
 * `is_connect()` as a failed DNS lookup. A 502 or 403 on CONNECT, which is how
 * a proxy says the destination is blocked, arrives the same way. So does an
 * unplugged network cable.
 *
 * Naming only unreachability would therefore actively misdirect the single most
 * likely user in this state — someone who typo'd a password — while offering
 * them one action, turning the proxy off, that does not address it. The
 * headline says what was observed (no reply came back through `host:port`) and
 * the detail lists every cause that produces that evidence, refusal included.
 * "Your proxy is down" would be a guess dressed as a diagnosis.
 *
 * `off` and `active` are the normal states and must not put a bar across the
 * window. `degraded` is a per-feature notice, filled from the backend's probe
 * of this host — a tier the proxy cannot serve here is named without waiting
 * for the user to play one.
 */
export function proxyNotice(status: unknown): ProxyNotice | null {
  if (typeof status !== "object" || status === null) return null;
  const s = status as { state?: unknown; reason?: unknown; endpoint?: unknown };

  if (s.state === "blocked") {
    const reason = typeof s.reason === "string" ? s.reason.trim() : "";
    return {
      tone: "blocked",
      headline: "Proxy blocked — nothing can connect.",
      // A red bar that says nothing is worse than a generic sentence.
      detail: reason.length > 0 ? reason : "The proxy settings are unusable",
    };
  }

  if (s.state === "unreachable") {
    const endpoint = typeof s.endpoint === "string" ? s.endpoint.trim() : "";
    return {
      tone: "unreachable",
      headline:
        endpoint.length > 0
          ? `SONE isn't getting a reply through the proxy at ${endpoint}.`
          : "SONE isn't getting a reply through the proxy.",
      detail:
        "Requests are going out and nothing is coming back. The proxy may be unreachable, it may be refusing the connection — a rejected password or a blocked destination look the same from here — or this machine may be offline.",
    };
  }

  return null;
}

/**
 * What a dismissal is pinned to.
 *
 * A dismissal that outlived the thing it dismissed would be a lie: the bar is
 * the only report of a state that stops the app working, and a user who hid
 * one in January must still be told when the proxy fails again in March. So it
 * is keyed to the notice in front of them, not to the component and not to the
 * session — the identity that distinguishes one occurrence from the next.
 *
 * Identity is the state plus what it named, because those are the parts a user
 * read before deciding it was not worth a bar: a different block reason, or the
 * same failure against a different endpoint, is news again.
 *
 * The rule that falls out: the notice stays hidden for exactly as long as the
 * condition it described remains continuously *observed*. Anything else —
 * recovery to `active`, the proxy being turned off, a new reason, and
 * therefore any later relapse into `unreachable` — produces a key the
 * dismissal does not match, and the bar comes back. Nothing here is remembered
 * across a restart, which is the same rule stated once more.
 *
 * "Observed" rather than "true" is the precise word, and the difference is
 * real: a proxy that recovers and fails again between two polls is never seen
 * to have recovered, so the dismissal survives it. That is the behaviour to
 * want — the user dismissed a proxy that is failing, and it is still failing.
 */
export function noticeKey(status: unknown): string | null {
  const notice = proxyNotice(status);
  if (!notice) return null;
  const s = status as { state?: unknown; reason?: unknown; endpoint?: unknown };
  const named = typeof s.endpoint === "string" ? s.endpoint : s.reason;
  return `${notice.tone}:${typeof named === "string" ? named.trim() : ""}`;
}

/** Opens Settings → Network in the authenticated shell. */
export function openNetworkSettings(): void {
  window.dispatchEvent(
    new CustomEvent(OPEN_SETTINGS_EVENT, { detail: "network" }),
  );
}

/**
 * The proxy notice's state, shared by the desktop bar and the TV one: reads
 * the status (again on `PROXY_STATUS_EVENT`), polls while a proxy is
 * configured, probes while it is unreachable, and turns the proxy off.
 * `notice` is null when there is nothing to say or it was dismissed.
 */
export function useProxyNotice() {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<ProxyStatus>("get_proxy_status"));
    } catch (e) {
      // A status call that fails says nothing about the proxy, and a notice
      // invented from an IPC error would be its own false alarm.
      console.error("Failed to read proxy status:", e);
    }
  }, []);

  /** Ask the backend to send one request through the live client, so a proxy
   *  that started working again has something to answer. A probe that fails is
   *  not an error here — failing is the outcome it was sent to measure, and
   *  the count it fed is what the next `refresh` reads. */
  const probe = useCallback(async () => {
    try {
      await invoke(PROBE_CMD);
    } catch (e) {
      console.error("Proxy reachability probe failed:", e);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(PROXY_STATUS_EVENT, onChange);
    return () => window.removeEventListener(PROXY_STATUS_EVENT, onChange);
  }, [refresh]);

  const key = noticeKey(status);
  // A dismissal outlives only the poll that carried the same condition. The
  // moment the key changes — recovery, a different reason, the proxy turned
  // off — it is forgotten, so a later relapse is reported rather than swallowed
  // by a click the user made about an earlier failure.
  useEffect(() => {
    setDismissed((d) => (d === key ? d : null));
  }, [key]);

  // Both flags are booleans rather than the status object, so a poll that
  // returns an equal-but-new object does not restart the timer.
  const configured = !!status && status.state !== "off";
  const unreachable = status?.state === "unreachable";
  useEffect(() => {
    if (!configured) return;
    const id = window.setInterval(() => {
      void (async () => {
        // Before the read, not after: the probe is what gives the next status
        // something new to say. It runs even while the notice is dismissed —
        // dismissal hides a report, it does not make the proxy work, and the
        // probe is the only thing that can retire the dismissal honestly.
        if (unreachable) await probe();
        await refresh();
      })();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [configured, unreachable, probe, refresh]);

  const turnOff = async () => {
    setBusy(true);
    setActionError(null);
    try {
      // Read the saved settings so host, port and credentials survive — the
      // user is turning the proxy off, not throwing their configuration away.
      // A settings read that fails still disables: a default with
      // `enabled: false` is `Direct`, which is the whole point of the button.
      let settings: ProxySettings = {
        enabled: false,
        proxy_type: "http",
        host: "",
        port: 0,
        username: null,
        password: null,
      };
      try {
        settings = { ...(await invoke<ProxySettings>("get_proxy_settings")) };
      } catch (e) {
        console.error("Failed to read proxy settings:", e);
      }
      settings.enabled = false;
      await invoke("set_proxy_settings", { settings });
    } catch (e) {
      console.error("Failed to disable the proxy:", e);
      setActionError(safeErrorMessage(e, "Could not turn the proxy off"));
    } finally {
      setBusy(false);
      // Same save, same detached gapless branch as the settings screen's — this
      // button is reachable inside the app, where a track may be playing.
      window.dispatchEvent(new Event(PROXY_SAVED_EVENT));
      await refresh();
    }
  };

  const notice = proxyNotice(status);
  return {
    notice: notice && dismissed !== key ? notice : null,
    busy,
    actionError,
    turnOff,
    dismiss: () => setDismissed(key),
  };
}
