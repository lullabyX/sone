import { memo, useEffect, useRef, useState } from "react";
import type { ComponentProps, RefObject, SyntheticEvent } from "react";
import { useAtomValue } from "jotai";
import { videoCoversAtom } from "../atoms/ui";
import { getTidalImageUrl, getTidalVideoUrl } from "../types";
import { acquireVideoCover, releaseVideoCover } from "../lib/videoCoverCache";
import TidalImage from "./TidalImage";

const MAX_LOAD_RETRIES = 10;
const SWAP_AFTER_FRAMES = 2;
const REVEAL_AFTER_S = 0.08;
const SWAP_TIMEOUT_MS = 500;
const STANDBY_LEAD_S = 2;

// A removed <video> keeps its decoder (~390 MB of GPU memory on NVDEC) until
// garbage collection; release it as soon as the element unmounts.
function CoverVideo({
  handleRef,
  ...props
}: ComponentProps<"video"> & {
  handleRef?: RefObject<HTMLVideoElement | null>;
}) {
  const own = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = own.current;
    if (!handleRef) return;
    handleRef.current = el;
    return () => {
      if (handleRef.current === el) handleRef.current = null;
    };
  }, [handleRef]);
  useEffect(() => {
    const el = own.current;
    return () => {
      if (!el) return;
      el.pause();
      el.removeAttribute("src");
      el.load();
    };
  }, []);
  return <video ref={own} {...props} />;
}

interface TidalVideoCoverProps {
  cover?: string;
  videoCover?: string;
  // Video resolution: 640 / 1280 bracket, or "origin" (native).
  size: number | "origin";
  // Static-art size (defaults to `size`, or 1280 for "origin").
  imageSize?: number;
  alt: string;
  className?: string;
}

function TidalVideoCoverComponent({
  cover,
  videoCover,
  size,
  imageSize,
  alt,
  className = "",
}: TidalVideoCoverProps) {
  const enabled = useAtomValue(videoCoversAtom);
  const videoUrl = enabled ? getTidalVideoUrl(videoCover, size) : "";
  const posterSize = imageSize ?? (typeof size === "number" ? size : 1280);
  const [blob, setBlob] = useState<{ src: string; url: string } | null>(null);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [gen, setGen] = useState(0);
  const [standbyGen, setStandbyGen] = useState(-1);
  const standby = useRef<HTMLVideoElement>(null);
  const failures = useRef(0);

  useEffect(() => {
    if (!videoUrl) return;
    let alive = true;
    acquireVideoCover(videoUrl).then(
      (url) => alive && setBlob({ src: videoUrl, url }),
      () => {},
    );
    return () => {
      alive = false;
      releaseVideoCover(videoUrl);
    };
  }, [videoUrl]);

  const blobUrl = blob?.src === videoUrl ? blob.url : null;

  const swapFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(swapFrame.current), []);

  // WebKitGTK can't loop a <video> cleanly (native `loop` freezes the picture
  // for seconds; reloading leaves a visible hold). Instead a hidden fresh copy
  // is loaded near the end, starts when the visible one ends, and is swapped in
  // once it has presented frames — a new decode's first frame can come up
  // green on the hardware decoder, so it must not be shown. The ended copy
  // holds its last frame meanwhile.
  const onEnded = (e: SyntheticEvent<HTMLVideoElement>) => {
    const old = e.currentTarget;
    const next = standby.current;
    if (!next) return setGen((g) => g + 1);
    next.play().catch(() => {});
    const started = performance.now();
    const check = () => {
      const presented = next.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
      if (
        presented >= SWAP_AFTER_FRAMES ||
        next.currentTime >= REVEAL_AFTER_S ||
        performance.now() - started > SWAP_TIMEOUT_MS
      ) {
        next.style.opacity = "1";
        old.style.opacity = "0";
        setGen((g) => g + 1);
      } else {
        swapFrame.current = requestAnimationFrame(check);
      }
    };
    swapFrame.current = requestAnimationFrame(check);
  };

  // Blob loads fail intermittently in WebKitGTK (MEDIA_ERR_SRC_NOT_SUPPORTED)
  // and succeed on retry; give up to the static art if they keep failing.
  const retry = (e: SyntheticEvent<HTMLVideoElement>, play: boolean) => {
    if (++failures.current > MAX_LOAD_RETRIES) {
      setFailedUrl(blobUrl);
      return;
    }
    const el = e.currentTarget;
    el.src = blobUrl!;
    if (play) el.play().catch(() => {});
  };

  const videoClass = "absolute inset-0 w-full h-full object-cover";

  // Static art stays underneath; the video fades in over it once playback has
  // moved past its first frames (and never appears if the fetch fails).
  return (
    <div className={`relative ${className}`}>
      <TidalImage
        src={getTidalImageUrl(cover, posterSize)}
        alt={alt}
        className="w-full h-full"
      />
      {blobUrl && failedUrl !== blobUrl && (
        <div
          className={`absolute inset-0 transition-opacity duration-300 ${
            playingUrl === blobUrl ? "opacity-100" : "opacity-0"
          }`}
        >
          {standbyGen === gen && (
            <CoverVideo
              key={`${blobUrl}#${gen + 1}`}
              handleRef={standby}
              src={blobUrl}
              preload="auto"
              muted
              playsInline
              onLoadedData={() => (failures.current = 0)}
              onError={(e) => retry(e, false)}
              className={videoClass}
              style={{ opacity: 0 }}
            />
          )}
          <CoverVideo
            key={`${blobUrl}#${gen}`}
            src={blobUrl}
            preload="auto"
            autoPlay
            muted
            playsInline
            onEnded={onEnded}
            onError={(e) => retry(e, true)}
            onTimeUpdate={(e) => {
              const el = e.currentTarget;
              if (el.currentTime >= REVEAL_AFTER_S) setPlayingUrl(blobUrl);
              if (el.duration - el.currentTime <= STANDBY_LEAD_S)
                setStandbyGen(gen);
            }}
            className={videoClass}
          />
        </div>
      )}
    </div>
  );
}

const TidalVideoCover = memo(TidalVideoCoverComponent);
TidalVideoCover.displayName = "TidalVideoCover";
export default TidalVideoCover;
