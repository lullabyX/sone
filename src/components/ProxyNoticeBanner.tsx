import { openNetworkSettings, useProxyNotice } from "../hooks/useProxyNotice";

export {
  OPEN_SETTINGS_EVENT,
  PROXY_STATUS_EVENT,
} from "../hooks/useProxyNotice";

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
  const { notice, busy, actionError, turnOff, dismiss } = useProxyNotice();
  if (!notice) return null;
  const tone = TONE[notice.tone];

  return (
    <div
      role="alert"
      className={`sone-proxy-banner flex flex-wrap items-center gap-2.5 px-4 py-2.5 border-b ${tone.box}`}
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
            onClick={openNetworkSettings}
            className={`px-2.5 py-1 rounded-md text-[11.5px] font-semibold border text-th-text-primary transition-colors ${tone.button}`}
          >
            Open network settings
          </button>
        )}
        <button
          onClick={() => void turnOff()}
          disabled={busy}
          className={`px-2.5 py-1 rounded-md text-[11.5px] font-semibold border text-th-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${tone.button}`}
        >
          {busy ? "Turning off…" : "Turn off proxy"}
        </button>
        {offerSettings && (
          <button
            onClick={dismiss}
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
