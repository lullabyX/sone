import { memo } from "react";
import { useAtomValue } from "jotai";
import { videoCoversAtom } from "../atoms/ui";
import { getTidalImageUrl, getTidalVideoUrl } from "../types";
import TidalImage from "./TidalImage";

interface TidalVideoCoverProps {
  cover?: string;
  videoCover?: string;
  // Video resolution: 640 / 1280 bracket, or "origin" (native).
  size: number | "origin";
  // Poster / static-fallback image size (defaults to `size`, or 1280 for "origin").
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
  const videoUrl = getTidalVideoUrl(videoCover, size);
  const posterSize = imageSize ?? (typeof size === "number" ? size : 1280);

  // No animated cover (disabled or none): just the cached static art.
  if (!enabled || !videoUrl) {
    return (
      <div className={`relative ${className}`}>
        <TidalImage
          src={getTidalImageUrl(cover, posterSize)}
          alt={alt}
          className="w-full h-full"
        />
      </div>
    );
  }

  // Play the high-res video directly; the cover image is the poster, shown
  // until the first frame paints (and if playback fails). Keyed by src so a
  // track change remounts cleanly.
  return (
    <div className={`relative ${className}`}>
      <video
        key={videoUrl}
        src={videoUrl}
        poster={getTidalImageUrl(cover, posterSize)}
        autoPlay
        loop
        muted
        playsInline
        className="absolute inset-0 w-full h-full object-cover"
      />
    </div>
  );
}

const TidalVideoCover = memo(TidalVideoCoverComponent);
TidalVideoCover.displayName = "TidalVideoCover";
export default TidalVideoCover;
