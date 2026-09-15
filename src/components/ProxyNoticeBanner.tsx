import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { safeErrorMessage } from "../lib/errorUtils";
import { PROXY_SAVED_EVENT, type ProxySettings } from "../atoms/proxy";

/** The serialized `proxy::ProxyStatus`, `#[serde(tag = "state")]`. */
export type ProxyStatus =
  | { state: "off" }
  | { state: "active"; degraded: string[] }
  | { state: "unreachable"; endpoint: string }
  | { state: "blocked"; reason: string };

/** Dispatched on `window` whenever a save may have changed the status. The
 *  banner re-reads the status rather than guessing from the settings it sent:
 *  the backend, not the form, decides whether a proxy is usable. */
export const PROXY_STATUS_EVENT = "sone:proxy-status";

/** How often the status is re-read while a proxy is configured.
 *
 *  `unreachable` is *entered* by requests the app was already making, so
 *  nothing tells the banner when one fails — it has to look. Only while a
 *  proxy is configured, though: with the proxy off there is no state this
 *  banner can ever report, so it does not poll at all.
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

/** Asked of the authenticated shell, which owns the settings sheet. The detail
 *  is the tab to land on. */
export const OPEN_SETTINGS_EVENT = "sone:open-settings";

export interface ProxyNotice {
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
 * The rule that falls out: the banner stays hidden for exactly as long as the
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

/** Why the bar will come back, said per tone, because the answers differ.
 *
 *  `unreachable` clears itself: the poll probes the live client while it is
 *  showing, so the next time the proxy answers the notice is gone and the
 *  dismissal with it. `blocked` never clears itself — nothing is sent through
 *  a cell that has no client — so the only thing that retires a dismissal
 *  there is the settings changing, which is the one promise this tooltip can
 *  honestly make. */
const DISMISS_TITLE = {
  blocked: "Dismiss — shown again if the reason changes",
  unreachable: "Dismiss — shown again the next time this happens",
} as const;

const TONE = {
  blocked: {
    accent: "#ff6666",
    box: "border-[#ff6666]/25 bg-[#ff6666]/10",
    dot: "bg-[#ff6666]",
    text: "text-[#ff6666]",
    button: "border-[#ff6666]/40 hover:bg-[#ff6666]/15",
  },
  unreachable: {
    accent: "#e8a33d",
    box: "border-[#e8a33d]/25 bg-[#e8a33d]/10",
    dot: "bg-[#e8a33d]",
    text: "text-[#e8a33d]",
    button: "border-[#e8a33d]/40 hover:bg-[#e8a33d]/15",
  },
} as const;

/**
 * Both states this renders refuse the login request itself, so this bar has to
 * live outside the authenticated shell.
 *
 * The trap it exists to close: a proxy that persists but cannot connect. Two
 * ways in. It can fail to build — a SOCKS5 host that does not resolve plans
 * fine and dies while reqwest builds the client — which blocks the cell. Or,
 * far more commonly, it builds perfectly and every request dies in transit,
 * because reqwest defers an `http://` proxy's name lookup to the first request:
 * `nope.invalid:8080` is a valid plan and a valid client right up to the moment
 * it is used. Either way, log out and the login is refused while Settings →
 * Network sits behind the login screen. Without a way out here, the only
 * recovery is editing an AES-GCM encrypted file by hand.
 *
 * The way out is a button, and it works while failing because
 * `set_proxy_settings` persists before it reconfigures: the disabled settings
 * reach disk whether or not anything else succeeds.
 *
 * Which is why the dismiss control is tied to `offerSettings` rather than
 * offered everywhere. Dismissing hides the bar, and the bar is carrying the
 * only escape a logged-out user has; a `blocked` cell makes that permanent for
 * the session, because nothing is ever sent through it and so nothing can
 * change what the status says. Even `unreachable`, whose probe does clear
 * itself, only clears when the proxy actually comes back — which is not
 * something a user with a dead proxy can count on. Where Settings → Network is
 * reachable the bar is a report and can be put away; where it is the way out,
 * it stays.
 */
export default function ProxyNoticeBanner({
  offerSettings = false,
}: {
  /** Whether a settings screen is reachable from here. False on the login
   *  screen, where it is not — which is why the disable button exists at all.
   *  True inside the app, where turning containment off must not be the only
   *  thing on offer. */
  offerSettings?: boolean;
} = {}) {
  const [status, setStatus] = useState<ProxyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<ProxyStatus>("get_proxy_status"));
    } catch (e) {
      // A status call that fails says nothing about the proxy, and a banner
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
  const configured = status !== null && status.state !== "off";
  const unreachable = status?.state === "unreachable";
  useEffect(() => {
    if (!configured) return;
    const id = window.setInterval(() => {
      void (async () => {
        // Before the read, not after: the probe is what gives the next status
        // something new to say. It runs even while the bar is dismissed —
        // dismissal hides a report, it does not make the proxy work, and the
        // probe is the only thing that can retire the dismissal honestly.
        if (unreachable) await probe();
        await refresh();
      })();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [configured, unreachable, probe, refresh]);

  const disableProxy = async () => {
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
  if (!notice || dismissed === key) return null;
  const tone = TONE[notice.tone];

  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center gap-2.5 px-4 py-2.5 border-b ${tone.box}`}
    >
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${tone.dot}`}
        aria-hidden="true"
      />
      <span
        className={`min-w-0 text-[11.5px] font-semibold break-words ${tone.text}`}
      >
        {notice.headline}
      </span>
      {notice.detail && (
        <span className="min-w-0 text-[11.5px] text-th-text-muted break-words">
          {notice.detail}
        </span>
      )}
      {actionError && (
        <span className="min-w-0 text-[11.5px] text-th-text-muted break-words">
          {actionError}
        </span>
      )}
      <div className="ml-auto flex flex-shrink-0 items-center gap-2">
        {offerSettings && (
          <button
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent(OPEN_SETTINGS_EVENT, { detail: "network" }),
              )
            }
            className={`px-2.5 py-1 rounded-md text-[11.5px] font-semibold border text-th-text-primary transition-colors ${tone.button}`}
          >
            Open network settings
          </button>
        )}
        <button
          onClick={() => void disableProxy()}
          disabled={busy}
          className={`px-2.5 py-1 rounded-md text-[11.5px] font-semibold border text-th-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${tone.button}`}
        >
          {busy ? "Turning off…" : "Turn off proxy"}
        </button>
        {offerSettings && (
          <button
            onClick={() => setDismissed(key)}
            aria-label="Dismiss"
            title={DISMISS_TITLE[notice.tone]}
            className={`px-2 py-1 rounded-md text-[13px] leading-none font-semibold border text-th-text-primary transition-colors ${tone.button}`}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
