import { useEffect } from "react";
import { useStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { tvLaunchAtom } from "../atoms/tv";

/**
 * Switch to the TV interface for this run when SONE is launched with `--tv`
 * (or `SONE_TV_MODE=1`), and when `sone --tv` is run again while it is already
 * open — the single-instance handler forwards that as `tv-mode:enter`.
 */
export function useTvLaunch() {
  const store = useStore();
  useEffect(() => {
    if (store.get(tvLaunchAtom) === "unchecked") {
      invoke<boolean>("get_launch_tv_mode")
        .then((on) => {
          if (store.get(tvLaunchAtom) === "unchecked") {
            store.set(tvLaunchAtom, on ? "on" : "off");
          }
        })
        .catch(() => store.set(tvLaunchAtom, "off"));
    }
    const unlisten = listen("tv-mode:enter", () =>
      store.set(tvLaunchAtom, "on"),
    );
    return () => {
      void unlisten.then((fn) => fn()).catch(() => {});
    };
  }, [store]);
}
