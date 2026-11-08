import { useEffect } from "react";
import { useStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { maximizedPlayerAtom } from "../atoms/ui";
import { tvModeAtom } from "../atoms/tv";

/** MPRIS Fullscreen: reported true while the maximized player or TV mode is
 *  up. SetFullscreen opens or closes the maximized player, and is ignored in
 *  TV mode, which is always fullscreen. */
export function useMprisFullscreen(): void {
  const store = useStore();

  useEffect(() => {
    const push = () => {
      invoke("update_mpris_fullscreen", {
        fullscreen: store.get(maximizedPlayerAtom) || store.get(tvModeAtom),
      }).catch(() => {});
    };
    push();
    const unsubMax = store.sub(maximizedPlayerAtom, push);
    const unsubTv = store.sub(tvModeAtom, push);
    const unlisten = listen<boolean>("mpris:set-fullscreen", (e) => {
      if (store.get(tvModeAtom)) {
        push();
        return;
      }
      store.set(maximizedPlayerAtom, e.payload);
    });
    return () => {
      unsubMax();
      unsubTv();
      unlisten.then((fn) => fn());
    };
  }, [store]);
}
