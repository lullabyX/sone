import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  WINDOW_FULLSCREEN_EVENT,
  windowIsFullscreen,
} from "../lib/windowFullscreen";

/** The window's real fullscreen state, kept current. */
export function useWindowFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let alive = true;
    let heard = false;
    windowIsFullscreen().then((on) => {
      if (alive && !heard) setFullscreen(on);
    });
    const unlisten = listen<boolean>(WINDOW_FULLSCREEN_EVENT, (e) => {
      heard = true;
      setFullscreen(e.payload);
    });
    return () => {
      alive = false;
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  return fullscreen;
}
