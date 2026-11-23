import { useCallback, useEffect, useState } from "react";
import { OPEN_SETTINGS_EVENT } from "../ProxyNoticeBanner";
import type { TabId } from "../settings/SettingsSheet";

/** Which tab the full settings sheet is open on, or null while it is closed. */
export function useTvMoreSettings() {
  const [tab, setTab] = useState<TabId | null>(null);
  // Only a string is a tab: callers wired straight to onClick pass an event.
  const open = useCallback(
    (t?: TabId) => setTab(typeof t === "string" ? t : "playback"),
    [],
  );
  const close = useCallback(() => setTab(null), []);

  useEffect(() => {
    const onOpen = (e: Event) => open((e as CustomEvent<TabId>).detail);
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
  }, [open]);

  return { tab, open, close };
}
