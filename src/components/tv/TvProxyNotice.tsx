import { useLayoutEffect, useRef } from "react";
import { Power, Settings, X } from "lucide-react";
import {
  openNetworkSettings,
  useProxyNotice,
} from "../../hooks/useProxyNotice";
import { TvButton } from "./TvParts";

const TONE = {
  blocked: {
    box: "border-[#ff6666]/30 bg-[#ff6666]/10",
    dot: "bg-[#ff6666]",
    text: "text-[#ff6666]",
  },
  unreachable: {
    box: "border-[#e8a33d]/30 bg-[#e8a33d]/10",
    dot: "bg-[#e8a33d]",
    text: "text-[#e8a33d]",
  },
} as const;

/**
 * The proxy notice on a TV screen (the desktop bar's state and actions, see
 * ProxyNoticeBanner), reached with Up from the top of the screen below it.
 * Inside the app it offers Network settings and Dismiss beside Turn off
 * proxy; on the sign-in screen Turn off proxy is the only way out, so it is
 * the main action and the notice cannot be dismissed.
 */
export default function TvProxyNotice({
  offerSettings = false,
  onGone,
}: {
  offerSettings?: boolean;
  /** Puts focus back on the screen when the notice goes away with it. */
  onGone?: () => void;
}) {
  const { notice, busy, actionError, turnOff, dismiss } = useProxyNotice();
  const rootRef = useRef<HTMLDivElement>(null);
  // The notice's button that last had focus, until focus moves elsewhere.
  const focused = useRef<HTMLElement | null>(null);
  const shown = notice !== null;

  useLayoutEffect(() => {
    if (shown) return;
    const was = focused.current;
    focused.current = null;
    if (!was || was.isConnected) return;
    const now = document.activeElement;
    if (now && now !== document.body) return;
    onGone?.();
  }, [shown, onGone]);

  if (!notice) return null;
  const tone = TONE[notice.tone];

  return (
    <div
      ref={rootRef}
      role="alert"
      onFocus={(e) => {
        focused.current = e.target;
      }}
      onBlur={(e) => {
        const to = e.relatedTarget;
        if (to instanceof Node && !rootRef.current?.contains(to)) {
          focused.current = null;
        }
      }}
      className={`tv-proxy-notice shrink-0 flex items-center gap-[1.5rem] px-[3rem] py-[0.8rem] border-b ${tone.box}`}
    >
      <span
        aria-hidden
        className={`shrink-0 w-[0.6rem] h-[0.6rem] rounded-full ${tone.dot}`}
      />
      <div className="flex-1 min-w-0">
        <p
          className={`text-[0.85rem] font-bold leading-snug break-words ${tone.text}`}
        >
          {notice.headline}
        </p>
        {notice.detail && (
          <p className="mt-[0.15rem] text-[0.75rem] leading-snug text-th-text-secondary break-words line-clamp-2">
            {notice.detail}
          </p>
        )}
        {actionError && (
          <p className="mt-[0.15rem] text-[0.75rem] font-semibold leading-snug text-th-text-primary break-words line-clamp-2">
            {actionError}
          </p>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-[0.8rem]">
        {offerSettings && (
          <TvButton
            icon={<Settings className="w-[1rem] h-[1rem]" />}
            label="Network settings"
            onClick={openNetworkSettings}
          />
        )}
        <TvButton
          primary={!offerSettings}
          icon={<Power className="w-[1rem] h-[1rem]" />}
          label={busy ? "Turning off…" : "Turn off proxy"}
          onClick={() => {
            if (!busy) void turnOff();
          }}
        />
        {offerSettings && (
          <TvButton
            icon={<X className="w-[1.1rem] h-[1.1rem]" />}
            title="Dismiss"
            onClick={dismiss}
          />
        )}
      </div>
    </div>
  );
}
