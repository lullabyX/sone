import {
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { useAtomValue, useStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPlayingAtom } from "../../atoms/playback";
import { tvOverscanAtom } from "../../atoms/tv";
import { maximizedPlayerAtom } from "../../atoms/ui";
import {
  currentVideoAtom,
  videoFullscreenAtom,
  videoPlayingAtom,
} from "../../atoms/video";
import { useHideMiniplayer } from "../../hooks/useMiniplayerWindow";
import { useTvGamepad } from "./useTvGamepad";
import "./tv.css";

const TV_CURSOR_HIDE_MS = 2500;
const TV_FULLSCREEN_RECHECK_MS = 300;

function updateScale() {
  const html = document.documentElement;
  const rem = parseFloat(getComputedStyle(html).fontSize);
  // Pixel-sized desktop pieces shown in TV mode (toasts) scale by this.
  html.style.setProperty(
    "--tv-px-scale",
    String(Number.isFinite(rem) ? Math.max(1, rem / 16) : 1),
  );
}

/**
 * The root of every TV surface (sign-in and the TV interface), kept mounted
 * across sign-in and sign-out: it scales the UI with the screen, keeps the
 * window fullscreen, hides the idle pointer and the always-on-top miniplayer,
 * keeps the screen awake while something plays, turns gamepad input into
 * remote keys, and undoes all of it on exit.
 */
export default function TvShell({ children }: { children: ReactNode }) {
  const store = useStore();
  const [cursorHidden, setCursorHidden] = useState(false);
  const isPlaying = useAtomValue(isPlayingAtom);
  const currentVideo = useAtomValue(currentVideoAtom);
  const videoPlaying = useAtomValue(videoPlayingAtom);
  const inhibit = isPlaying || (!!currentVideo && videoPlaying);
  const overscan = useAtomValue(tvOverscanAtom);
  useHideMiniplayer();
  useTvGamepad(true);

  // Before any child's layout effect, so they measure the TV sizes.
  useInsertionEffect(() => {
    const html = document.documentElement;
    html.classList.add("tv-mode");
    updateScale();
    return () => {
      html.classList.remove("tv-mode");
      html.style.removeProperty("--tv-px-scale");
    };
  }, []);
  // Overlays outside the shell (menu, prompt, the full-screen video) inset
  // their content by the same margin.
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.style.setProperty("--tv-safe-x", `${overscan}vw`);
    html.style.setProperty("--tv-safe-y", `${overscan}vh`);
    return () => {
      html.style.removeProperty("--tv-safe-x");
      html.style.removeProperty("--tv-safe-y");
    };
  }, [overscan]);
  useEffect(() => {
    window.addEventListener("resize", updateScale);
    return () => window.removeEventListener("resize", updateScale);
  }, []);

  // Fullscreen on entry. On exit the window goes back to how the user had
  // it, unless that fullscreen belonged to the maximized player or a video,
  // which entering TV mode closes.
  useEffect(() => {
    const win = getCurrentWindow();
    const blocked =
      store.get(maximizedPlayerAtom) || store.get(videoFullscreenAtom);
    store.set(maximizedPlayerAtom, false);
    store.set(videoFullscreenAtom, false);
    const restore = win
      .isFullscreen()
      .catch(() => false)
      .then(async (was) => {
        await win.setFullscreen(true).catch(() => {});
        return was && !blocked;
      });
    return () => {
      void restore.then((keep) => {
        if (!keep) win.setFullscreen(false).catch(() => {});
      });
    };
  }, [store]);

  // Anything that drops fullscreen (the WM shortcut, a video leaving its
  // own fullscreen) is undone.
  useEffect(() => {
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const recheck = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const full = await win.isFullscreen().catch(() => true);
        if (active && !full) win.setFullscreen(true).catch(() => {});
      }, TV_FULLSCREEN_RECHECK_MS);
    };
    window.addEventListener("resize", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener("resize", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, []);

  // Hide the pointer until the mouse moves. Set on the document, so it also
  // covers the video player, which sits outside the TV interface. Synthetic
  // moves (sent to wake the video controls from the remote) don't count.
  useEffect(() => {
    let timer = setTimeout(() => setCursorHidden(true), TV_CURSOR_HIDE_MS);
    const onMove = (e: MouseEvent) => {
      if (!e.isTrusted) return;
      setCursorHidden(false);
      clearTimeout(timer);
      timer = setTimeout(() => setCursorHidden(true), TV_CURSOR_HIDE_MS);
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousemove", onMove);
    };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("tv-cursor-hidden", cursorHidden);
    return () => root.classList.remove("tv-cursor-hidden");
  }, [cursorHidden]);

  useEffect(() => {
    if (!inhibit) return;
    invoke("inhibit_idle", { holder: "tv" }).catch(() => {});
    return () => {
      invoke("uninhibit_idle", { holder: "tv" }).catch(() => {});
    };
  }, [inhibit]);

  return (
    <div
      className="tv-shell h-full w-full bg-th-base"
      style={{ padding: `${overscan}vh ${overscan}vw` }}
    >
      <div className="tv-safe relative h-full w-full">{children}</div>
    </div>
  );
}
