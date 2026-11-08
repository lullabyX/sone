import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  loadHeroImage,
  paintArtistHero,
  type HeroImage,
} from "../lib/artistHero";
import { useElementSize } from "../hooks/useElementSize";
import { useDerivedTheme } from "../hooks/useDerivedTheme";

interface ArtistHeroCanvasProps {
  /** Low-res blob URL, shown blurred until `hi` has loaded. */
  low: string | null;
  /** Hi-res blob URL. */
  hi: string | null;
}

interface Loaded extends HeroImage {
  src: string;
}

/** Artist page hero backdrop: the low-res image blurred, then the hi-res one once loaded. */
export default function ArtistHeroCanvas({ low, hi }: ArtistHeroCanvasProps) {
  const [sizeRef, box] = useElementSize<HTMLCanvasElement>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const setCanvas = useCallback(
    (el: HTMLCanvasElement | null) => {
      canvasRef.current = el;
      sizeRef(el);
    },
    [sizeRef],
  );
  const { bgBase } = useDerivedTheme();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const src = hi ?? low;

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    loadHeroImage(src, src !== hi)
      .then((image) => {
        if (!cancelled) setLoaded({ src, ...image });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [src, hi]);

  const hero =
    loaded && (loaded.src === hi || loaded.src === low) ? loaded : null;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) paintArtistHero(canvas, hero, box.w, box.h, bgBase);
  }, [hero, box, bgBase]);

  return (
    <canvas
      ref={setCanvas}
      aria-hidden
      data-testid="artist-hero-canvas"
      className="pointer-events-none absolute inset-0 w-full h-full block"
    />
  );
}
