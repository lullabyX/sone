import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { tvModeAtom } from "../atoms/tv";

/**
 * Switch to the TV interface when SONE is launched with `--tv` (or
 * `SONE_TV_MODE=1`), and when `sone --tv` is run again while it is already
 * open — the single-instance handler forwards that as `tv-mode:enter`.
 */
export function useTvLaunch() {
  const setTvMode = useSetAtom(tvModeAtom);
  useEffect(() => {
    invoke<boolean>("get_launch_tv_mode")
      .then((on) => {
        if (on) setTvMode(true);
      })
      .catch(() => {});
    const unlisten = listen("tv-mode:enter", () => setTvMode(true));
    return () => {
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [setTvMode]);
}
