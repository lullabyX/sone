import { useState, useRef, useEffect } from "react";
import TidalImage from "./TidalImage";

interface CrossfadeTidalImageProps {
  src: string | undefined;
  alt: string;
  className?: string;
  /** Duration of the crossfade in ms (default 300) */
  fadeDuration?: number;
}

export default function CrossfadeTidalImage({
  src,
  alt,
  className = "",
  fadeDuration = 300,
}: CrossfadeTidalImageProps) {
  // The "committed" src — last successfully loaded image.
  const [displaySrc, setDisplaySrc] = useState(src);
  // Whether the new (front) image has finished loading.
  const [newLoaded, setNewLoaded] = useState(false);
  const pendingSrc = useRef(src);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Clean up fade timer on unmount.
  useEffect(() => {
    return () => clearTimeout(fadeTimerRef.current);
  }, []);

  // When src changes, update pendingSrc and clear any in-flight fade timer.
  useEffect(() => {
    pendingSrc.current = src;
    if (src !== displaySrc) {
      setNewLoaded(false);
      clearTimeout(fadeTimerRef.current);
    }
  }, [src, displaySrc]);

  const handleNewLoad = () => {
    if (pendingSrc.current === src) {
      setNewLoaded(true);
      // After fade completes, promote new src to display and unmount old layer.
      fadeTimerRef.current = setTimeout(() => {
        // Re-check pendingSrc to guard against rapid skipping:
        // a stale timeout must not promote a src that is no longer current.
        if (pendingSrc.current === src) {
          setDisplaySrc(src);
          setNewLoaded(false);
        }
      }, fadeDuration);
    }
  };

  const isTransitioning = src !== displaySrc;

  return (
    <div className={`relative overflow-hidden ${className}`}>
      {/* Back layer: previous image */}
      <TidalImage
        src={displaySrc}
        alt={alt}
        className="absolute inset-0 w-full h-full object-cover"
      />

      {/* Front layer: new image — starts invisible, fades in on load */}
      {isTransitioning && (
        <div
          className="absolute inset-0"
          style={{
            opacity: newLoaded ? 1 : 0,
            transition: `opacity ${fadeDuration}ms ease-in-out`,
          }}
        >
          <TidalImage
            src={src}
            alt={alt}
            className="w-full h-full object-cover"
            onLoad={handleNewLoad}
          />
        </div>
      )}
    </div>
  );
}
