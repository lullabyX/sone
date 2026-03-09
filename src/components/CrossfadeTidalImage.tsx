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
  // The "committed" src — last successfully loaded & transitioned image.
  const [displaySrc, setDisplaySrc] = useState(src);
  const [fadeIn, setFadeIn] = useState(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(fadeTimerRef.current), []);

  // When src changes, reset fade state.
  useEffect(() => {
    if (src !== displaySrc) {
      setFadeIn(false);
      clearTimeout(fadeTimerRef.current);
    }
  }, [src, displaySrc]);

  const isTransitioning = src !== displaySrc;

  return (
    <div className={`relative overflow-hidden ${className}`}>
      {/* Back layer: currently displayed image */}
      <div className="absolute inset-0">
        <TidalImage
          src={displaySrc}
          alt={alt}
          className="w-full h-full object-cover"
        />
      </div>

      {/* Front layer: new image — fades in on load, then promotes */}
      {isTransitioning && (
        <div
          className="absolute inset-0"
          style={{
            opacity: fadeIn ? 1 : 0,
            transition: `opacity ${fadeDuration}ms ease-in-out`,
          }}
        >
          <TidalImage
            key={src}
            src={src}
            alt={alt}
            className="w-full h-full object-cover"
            onLoad={() => {
              setFadeIn(true);
              clearTimeout(fadeTimerRef.current);
              fadeTimerRef.current = setTimeout(() => {
                setDisplaySrc(src);
                setFadeIn(false);
              }, fadeDuration);
            }}
          />
        </div>
      )}
    </div>
  );
}
