import Sidebar from "./Sidebar";
import Header from "./Header";
import PlayerBar from "./PlayerBar";
import NowPlayingDrawer from "./NowPlayingDrawer";
import { ReactNode, useRef, useEffect, useCallback } from "react";
import { useAtomValue } from "jotai";
import { currentViewAtom } from "../atoms/navigation";
import { maximizedPlayerAtom } from "../atoms/ui";
import MaximizedPlayer from "./MaximizedPlayer";
import { useMiniplayerEmitter } from "../hooks/useMiniplayerEmitter";

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentView = useAtomValue(currentViewAtom);
  const maximized = useAtomValue(maximizedPlayerAtom);

  useMiniplayerEmitter();

  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [currentView]);

  // ── Middle-mouse autoscroll (Chrome-style) ──
  const autoscrollRef = useRef<{
    active: boolean;
    originY: number;
    deltaY: number;
    rafId: number;
  } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    const el = scrollRef.current;
    if (!el) return;

    autoscrollRef.current = {
      active: true,
      originY: e.clientY,
      deltaY: 0,
      rafId: 0,
    };

    const tick = () => {
      const state = autoscrollRef.current;
      if (!state?.active) return;
      const d = state.deltaY;
      if (d !== 0) {
        const sign = d > 0 ? 1 : -1;
        el.scrollTop += sign * Math.pow(Math.abs(d) / 10, 1.6);
      }
      state.rafId = requestAnimationFrame(tick);
    };

    const onMove = (me: MouseEvent) => {
      if (autoscrollRef.current) {
        autoscrollRef.current.deltaY =
          me.clientY - autoscrollRef.current.originY;
      }
    };

    const onUp = (ue: MouseEvent) => {
      if (ue.button !== 1) return;
      if (autoscrollRef.current) {
        autoscrollRef.current.active = false;
        cancelAnimationFrame(autoscrollRef.current.rafId);
        autoscrollRef.current = null;
      }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    autoscrollRef.current.rafId = requestAnimationFrame(tick);
  }, []);

  return (
    <div className="flex flex-col h-full w-full bg-th-overlay text-th-text-primary overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0 bg-th-base">
          <Header />
          <div
            ref={scrollRef}
            onMouseDown={onMouseDown}
            className="flex-1 overflow-y-auto custom-scrollbar relative"
          >
            {children}
          </div>
        </div>
      </div>
      <NowPlayingDrawer />
      {maximized && <MaximizedPlayer />}
      <PlayerBar />
    </div>
  );
}
