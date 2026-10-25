import { useEffect, useInsertionEffect, useState, type ReactNode } from "react";
import { useStore } from "jotai";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { maximizedPlayerAtom } from "../../atoms/ui";
import { videoFullscreenAtom } from "../../atoms/video";
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
 * window fullscreen and hides the idle pointer, and undoes all of it on exit.
 */
export default function TvShell({ children }: { children: ReactNode }) {
  const store = useStore();
  const [cursorHidden, setCursorHidden] = useState(false);

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

  return (
    <div className="tv-shell h-full w-full bg-th-base">
      <div className="tv-safe relative h-full w-full">{children}</div>
    </div>
  );
}
