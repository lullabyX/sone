import { useEffect, useRef, useState } from "react";
import type { LrcLine } from "../../lib/lrc";
import { getInterpolatedPosition } from "../../lib/playbackPosition";
import type { TvLyricsData } from "./useTvLyrics";

function activeLineAt(lines: LrcLine[], pos: number): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (pos >= lines[i].time) return i;
  }
  return -1;
}

/** Lyrics panel for Now Playing. Synced lyrics follow playback with the
 *  current line centred; plain lyrics scroll along with the track's
 *  progress. Not focusable — it only follows the music. */
export function TvLyricsPanel({
  lyrics,
  duration,
}: {
  lyrics: TvLyricsData;
  duration: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const tick = () => {
      const pos = getInterpolatedPosition();
      const el = containerRef.current;
      if (!el) return;
      if (lyrics.kind === "synced") {
        setActive(activeLineAt(lyrics.lines, pos));
      } else if (duration > 0) {
        const max = el.scrollHeight - el.clientHeight;
        el.scrollTo({
          top: Math.max(0, Math.min(1, pos / duration)) * max,
          behavior: "smooth",
        });
      }
    };
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [lyrics, duration]);

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
