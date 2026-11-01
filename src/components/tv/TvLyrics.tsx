import { useAtomValue } from "jotai";
import {
  useContext,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
} from "react";
import { isPlayingAtom } from "../../atoms/playback";
import { usePlaybackActions } from "../../hooks/usePlaybackActions";
import { findActiveLine } from "../../lib/lrc";
import { getInterpolatedPosition } from "../../lib/playbackPosition";
import { TvScreenContext } from "./TvNavContext";
import type { TvLyricsData } from "./useTvLyrics";

/** Lyrics panel for Now Playing. Synced lyrics follow playback with the
 *  current line centred; each line is a button that jumps there, and
 *  entering the lyrics lands on the current line. Plain lyrics are not
 *  focusable and scroll along with the track's progress. Idle while the
 *  screen is hidden or playback is paused, and held where it is while
 *  `stale` (the last track's lyrics, shown until the next one's arrive). */
export function TvLyricsPanel({
  lyrics,
  duration,
  stale = false,
}: {
  lyrics: TvLyricsData;
  duration: number;
  stale?: boolean;
}) {
  const { active: shown } = useContext(TvScreenContext);
  const isPlaying = useAtomValue(isPlayingAtom);
  const { seekTo } = usePlaybackActions();
  const containerRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [active, setActive] = useState(-1);
  const activeRef = useRef(-1);
  const [focused, setFocused] = useState(-1);

  // One frame on show (a paused track opens on the right line), then every
  // frame while playing; state changes only when the line does.
  useEffect(() => {
    if (lyrics.kind !== "synced" || !shown || stale) return;
    const lines = lyrics.lines;
    let rafId = 0;
    const tick = () => {
      const idx = findActiveLine(lines, getInterpolatedPosition());
      if (idx !== activeRef.current) {
        activeRef.current = idx;
        setActive(idx);
      }
      if (isPlaying) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [lyrics, shown, isPlaying, stale]);

  // The frame loop is idle while paused — re-sync once per seek.
  useEffect(() => {
    if (lyrics.kind !== "synced" || stale) return;
    const lines = lyrics.lines;
    const onSeeked = (e: Event) => {
      const idx = findActiveLine(lines, (e as CustomEvent<number>).detail);
      activeRef.current = idx;
      setActive(idx);
    };
    window.addEventListener("playback-seeked", onSeeked);
    return () => window.removeEventListener("playback-seeked", onSeeked);
  }, [lyrics, stale]);

  useEffect(() => {
    if (
      lyrics.kind !== "plain" ||
      !shown ||
      !isPlaying ||
      stale ||
      duration <= 0
    ) {
      return;
    }
    const tick = () => {
      const el = containerRef.current;
      if (!el) return;
      const max = el.scrollHeight - el.clientHeight;
      const progress = getInterpolatedPosition() / duration;
      el.scrollTo({
        top: Math.max(0, Math.min(1, progress)) * max,
        behavior: "smooth",
      });
    };
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [lyrics, duration, shown, isPlaying, stale]);

  const isInside = (e: FocusEvent<HTMLElement>, node: EventTarget | null) =>
    node instanceof Node && e.currentTarget.contains(node);

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (lyrics.kind !== "synced") return;
    const target: EventTarget = e.target;
    if (!isInside(e, e.relatedTarget)) {
      const line = lineRefs.current[Math.max(active, 0)];
      if (line && line !== target) {
        line.focus({ preventScroll: true });
        return;
      }
    }
    setFocused(lineRefs.current.indexOf(target as HTMLButtonElement));
  };

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!isInside(e, e.relatedTarget)) setFocused(-1);
  };

  // Keep the focused line, else the current one, in the middle of the panel.
  useEffect(() => {
    const el = containerRef.current;
    const idx = focused >= 0 ? focused : active;
    const line = idx >= 0 ? lineRefs.current[idx] : null;
    if (!el) return;
    const target = line
      ? line.offsetTop - el.clientHeight / 2 + line.offsetHeight / 2
      : 0;
    el.scrollTo({ top: target, behavior: "smooth" });
  }, [active, focused]);

  const fade =
    "linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%)";

  return (
    <div
      dir={lyrics.rtl ? "rtl" : "ltr"}
      className="flex h-full w-full flex-col"
    >
      <div
        ref={containerRef}
        data-tv-clip
        className="tv-lyrics relative min-h-0 flex-1 overflow-hidden"
        style={{ maskImage: fade, WebkitMaskImage: fade }}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {lyrics.kind === "synced" ? (
          <div className="py-[45%]">
            {lyrics.lines.map((line, i) => (
              <button
                key={i}
                type="button"
                data-tv-focusable
                ref={(el) => {
                  lineRefs.current[i] = el;
                }}
                onClick={() => void seekTo(line.time)}
                aria-current={i === active ? "true" : undefined}
                className={`tv-track block w-full rounded-[0.6rem] px-[0.75rem] py-[0.35rem] text-start text-[1.5rem] font-bold leading-snug transition-[color,opacity] duration-300 ${
                  i === active
                    ? "text-th-text-primary"
                    : i < active
                      ? "text-th-text-muted opacity-60"
                      : "text-th-text-muted"
                }`}
              >
                {line.text}
              </button>
            ))}
          </div>
        ) : (
          <p className="whitespace-pre-line py-[30%] text-[1.2rem] font-semibold leading-relaxed text-th-text-secondary">
            {lyrics.text}
          </p>
        )}
      </div>
      {lyrics.provider && (
        <p className="shrink-0 pt-[0.75rem] text-[0.75rem] text-th-text-muted">
          Lyrics provided by {lyrics.provider}
        </p>
      )}
    </div>
  );
}
