import { useAtomValue } from "jotai";
import { useContext, useEffect, useRef, useState } from "react";
import { isPlayingAtom } from "../../atoms/playback";
import { findActiveLine } from "../../lib/lrc";
import { getInterpolatedPosition } from "../../lib/playbackPosition";
import { TvScreenContext } from "./TvNavContext";
import type { TvLyricsData } from "./useTvLyrics";

/** Lyrics panel for Now Playing. Synced lyrics follow playback with the
 *  current line centred; plain lyrics scroll along with the track's
 *  progress. Not focusable — it only follows the music. Idle while the
 *  screen is hidden or playback is paused. */
export function TvLyricsPanel({
  lyrics,
  duration,
}: {
  lyrics: TvLyricsData;
  duration: number;
}) {
  const { active: shown } = useContext(TvScreenContext);
  const isPlaying = useAtomValue(isPlayingAtom);
  const containerRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const [active, setActive] = useState(-1);
  const activeRef = useRef(-1);

  // One frame on show (a paused track opens on the right line), then every
  // frame while playing; state changes only when the line does.
  useEffect(() => {
    if (lyrics.kind !== "synced" || !shown) return;
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
  }, [lyrics, shown, isPlaying]);

  // The frame loop is idle while paused — re-sync once per seek.
  useEffect(() => {
    if (lyrics.kind !== "synced") return;
    const lines = lyrics.lines;
    const onSeeked = (e: Event) => {
      const idx = findActiveLine(lines, (e as CustomEvent<number>).detail);
      activeRef.current = idx;
      setActive(idx);
    };
    window.addEventListener("playback-seeked", onSeeked);
    return () => window.removeEventListener("playback-seeked", onSeeked);
  }, [lyrics]);

  useEffect(() => {
    if (lyrics.kind !== "plain" || !shown || !isPlaying || duration <= 0) {
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
  }, [lyrics, duration, shown, isPlaying]);

  // Keep the current line in the middle of the panel.
  useEffect(() => {
    const el = containerRef.current;
    const line = active >= 0 ? lineRefs.current[active] : null;
    if (!el) return;
    const target = line
      ? line.offsetTop - el.clientHeight / 2 + line.offsetHeight / 2
      : 0;
    el.scrollTo({ top: target, behavior: "smooth" });
  }, [active]);

  const fade =
    "linear-gradient(to bottom, transparent 0%, black 18%, black 82%, transparent 100%)";

  return (
    <div
      ref={containerRef}
      dir={lyrics.rtl ? "rtl" : "ltr"}
      className="tv-lyrics relative h-full w-full overflow-hidden"
      style={{ maskImage: fade, WebkitMaskImage: fade }}
    >
      {lyrics.kind === "synced" ? (
        <div className="py-[45%]">
          {lyrics.lines.map((line, i) => (
            <p
              key={i}
              ref={(el) => {
                lineRefs.current[i] = el;
              }}
              aria-current={i === active ? "true" : undefined}
              className={`py-[0.35rem] text-[1.5rem] font-bold leading-snug transition-[color,opacity] duration-300 ${
                i === active
                  ? "text-th-text-primary"
                  : i < active
                    ? "text-th-text-muted opacity-60"
                    : "text-th-text-muted"
              }`}
            >
              {line.text}
            </p>
          ))}
        </div>
      ) : (
        <p className="whitespace-pre-line py-[30%] text-[1.2rem] font-semibold leading-relaxed text-th-text-secondary">
          {lyrics.text}
        </p>
      )}
    </div>
  );
}
