import {
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { useAtomValue, useStore } from "jotai";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  TV_TEXT_SCALE,
  tvOverscanAtom,
  tvTextSizeAtom,
  tvVolumeOnTvAtom,
} from "../../atoms/tv";
import { maximizedPlayerAtom } from "../../atoms/ui";
import { videoFullscreenAtom } from "../../atoms/video";
import { useHideMiniplayer } from "../../hooks/useMiniplayerWindow";
import { useTvGamepad } from "./useTvGamepad";
import { windowIsFullscreen } from "../../lib/windowFullscreen";
import "./tv.css";

const TV_CURSOR_HIDE_MS = 2500;
const TV_FULLSCREEN_RECHECK_MS = 300;
/** Whether exit leaves the window fullscreen, decided once per TV session.
 *  sessionStorage, so a reload inside TV mode keeps it and a restart drops it. */
const TV_KEEP_FULLSCREEN_KEY = "sone.tvKeepFullscreen.v1";

function readKeep(): boolean | null {
  try {
    const v = sessionStorage.getItem(TV_KEEP_FULLSCREEN_KEY);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
}

function writeKeep(keep: boolean | null) {
  try {
    if (keep === null) sessionStorage.removeItem(TV_KEEP_FULLSCREEN_KEY);
    else sessionStorage.setItem(TV_KEEP_FULLSCREEN_KEY, keep ? "1" : "0");
  } catch {
    /* storage unavailable: a reload re-reads the window */
  }
}

// Window commands run as separate backend tasks, so two in flight can land
// in either order. TV mode's run one after another, across mounts.
let windowOps: Promise<unknown> = Promise.resolve();
function inOrder<T>(op: () => Promise<T>): Promise<T> {
  const next = windowOps.then(op);
  windowOps = next.catch(() => {});
  return next;
}

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
 * turns gamepad input into remote keys, and undoes all of it on exit.
 */
export default function TvShell({ children }: { children: ReactNode }) {
  const store = useStore();
  const [cursorHidden, setCursorHidden] = useState(false);
  const overscan = useAtomValue(tvOverscanAtom);
  const textSize = useAtomValue(tvTextSizeAtom);
  const volumeOnTv = useAtomValue(tvVolumeOnTvAtom);
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
    html.style.setProperty("--tv-safe-x", `${overscan.x}vw`);
    html.style.setProperty("--tv-safe-y", `${overscan.y}vh`);
    return () => {
      html.style.removeProperty("--tv-safe-x");
      html.style.removeProperty("--tv-safe-y");
    };
  }, [overscan]);
  // The TV's remote sets the volume: the video player's volume control is
  // hidden (tv.css).
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.toggleAttribute("data-tv-volume-on-tv", volumeOnTv);
    return () => html.removeAttribute("data-tv-volume-on-tv");
  }, [volumeOnTv]);
  // The text size setting scales the root size, and with it everything.
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.style.setProperty("--tv-text-scale", String(TV_TEXT_SCALE[textSize]));
    updateScale();
    return () => {
      html.style.removeProperty("--tv-text-scale");
    };
  }, [textSize]);
  useEffect(() => {
    window.addEventListener("resize", updateScale);
    return () => window.removeEventListener("resize", updateScale);
  }, []);

  // Fullscreen on entry. On exit the window goes back to how the user had
  // it, unless that fullscreen belonged to the maximized player or a video,
  // which entering TV mode closes. After a reload the window is in TV mode's
  // own fullscreen, so the first answer is kept for the TV session. Anything
  // that drops fullscreen (the WM shortcut, a video leaving its own) is
  // undone without asking first.
  useEffect(() => {
    const win = getCurrentWindow();
    const blocked =
      store.get(maximizedPlayerAtom) || store.get(videoFullscreenAtom);
    store.set(maximizedPlayerAtom, false);
    store.set(videoFullscreenAtom, false);
    const keep = inOrder(async () => {
      const saved = readKeep();
      if (saved !== null) return saved;
      const was = await windowIsFullscreen();
      writeKeep(was && !blocked);
      return was && !blocked;
    });
    const enter = () =>
      void inOrder(() => win.setFullscreen(true).catch(() => {}));
    enter();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recheck = () => {
      clearTimeout(timer);
      timer = setTimeout(enter, TV_FULLSCREEN_RECHECK_MS);
    };
    window.addEventListener("resize", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", recheck);
      window.removeEventListener("focus", recheck);
      void inOrder(async () => {
        writeKeep(null);
        if (!(await keep)) await win.setFullscreen(false).catch(() => {});
      });
    };
  }, [store]);

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
    <div
      className="tv-shell h-full w-full bg-th-base"
      style={{ padding: `${overscan.y}vh ${overscan.x}vw` }}
    >
      <div className="tv-safe relative h-full w-full">{children}</div>
    </div>
  );
}
