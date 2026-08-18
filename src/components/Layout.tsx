import Sidebar from "./Sidebar";
import Header from "./Header";
import PlayerBar from "./PlayerBar";
import NowPlayingDrawer from "./NowPlayingDrawer";
import TitleBar from "./TitleBar";
import ResizeEdges from "./ResizeEdges";
import { ReactNode, useRef, useEffect, useCallback } from "react";
import { useAtomValue } from "jotai";
import { currentViewAtom } from "../atoms/navigation";
import {
  decorationsAtom,
  hideTitleBarAtom,
  maximizedPlayerAtom,
} from "../atoms/ui";
import MaximizedPlayer from "./MaximizedPlayer";
import VideoPlayer from "./VideoPlayer";
import { currentVideoAtom, videoExpandedAtom } from "../atoms/video";
import { useMiniplayerEmitter } from "../hooks/useMiniplayerEmitter";
import { useScrollRestoration } from "../hooks/useScrollRestoration";

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentView = useAtomValue(currentViewAtom);
  const maximized = useAtomValue(maximizedPlayerAtom);
  const currentVideo = useAtomValue(currentVideoAtom);
  const videoExpanded = useAtomValue(videoExpandedAtom);
  // Hide the audio chrome only while the overlay is actually showing; when the
  // video is minimized the normal view + player bar return (video keeps playing).
  const overlayShowing = currentVideo && videoExpanded;
  // `false` = custom titlebar shown; `true` = native OS chrome (escape hatch)
  const nativeChrome = useAtomValue(decorationsAtom);
  const hideTitleBar = useAtomValue(hideTitleBarAtom);

  useMiniplayerEmitter();
  useScrollRestoration(scrollRef);

  // The container has to own focus for bare arrow keys to scroll it, and
  // nothing else would give it focus before the first click; `preventScroll`
  // keeps that focus from scrolling the container out from under a restore.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement
    ) {
      return;
    }
    el.focus({ preventScroll: true });
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
    <div className="relative flex flex-col h-full w-full bg-th-overlay text-th-text-primary overflow-hidden">
      {!nativeChrome && !hideTitleBar && <TitleBar />}
      {/* Hide the audio chrome (sidebar + heavy library grids + player bar) while a
          fullscreen video overlay is open. An opaque overlay does NOT stop WebKit from
          compositing the layer tree beneath it every video frame — at 4K that throttles
          the compositor ~3x and makes the video stutter. display:none removes those
          layers from compositing entirely. `contents` keeps the wrapper layout-neutral
          for the fixed-positioned chrome when no video is playing. */}
      <div
        className={`flex flex-1 overflow-hidden ${overlayShowing ? "hidden" : ""}`}
      >
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0 bg-th-base">
          <Header />
          <div
            ref={scrollRef}
            onMouseDown={onMouseDown}
            tabIndex={-1}
            className="flex-1 overflow-y-auto custom-scrollbar relative outline-none"
          >
            {children}
          </div>
        </div>
      </div>
      <div className={overlayShowing ? "hidden" : "contents"}>
        <NowPlayingDrawer />
        {maximized && <MaximizedPlayer />}
        <PlayerBar />
      </div>
      {currentVideo && <VideoPlayer />}
      {!nativeChrome && <ResizeEdges top={4} bottom={4} left={4} right={4} />}
    </div>
  );
}
