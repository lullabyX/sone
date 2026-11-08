import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { bakeCover, BLUR_OPTIONS, SHARP_OPTIONS } from "../lib/coverBlur";
import {
  alphaStops,
  fadeBottom,
  fillLinear,
  sizeCanvasToBox,
  withAlpha,
} from "../lib/bannerCanvas";
import { useElementSize } from "../hooks/useElementSize";
import { useDerivedTheme } from "../hooks/useDerivedTheme";

type Variant = "blur" | "dark";

interface CoverBannerProps {
  /** Resolved image URL (UUID already run through getTidalImageUrl, or a direct URL). */
  src: string | undefined;
  /**
   * "blur" — heavily blurred, faint backdrop (playlists, mixes).
   * "dark" — sharp art, darkened, TIDAL album-page style.
   */
  variant?: Variant;
}

// Where the bottom fade starts, as a fraction of the banner height. Sharp art
// is more present, so it starts dissolving sooner.
const FADE_START: Record<Variant, number> = { blur: 0.5, dark: 0.22 };

// Horizontal base-tone tint (offset, alpha). Blur keeps the right side calm;
// dark tints the left where the title sits and reveals the art on the right.
const TINT: Record<Variant, [number, number][]> = {
  blur: [
    [0, 0],
    [0.5, 0.1],
    [1, 0.6],
  ],
  dark: [
    [0, 0.3],
    [0.5, 0.7],
    [1, 0],
  ],
};

/**
 * Paints the art, a 50% base-tone wash (darkens on dark themes, lightens on
 * light ones), the horizontal tint and the bottom fade into a canvas the size
 * of the banner box. Blur art spans the width anchored to the top; sharp art
 * is centre-cropped to cover the box.
 */
function paintCoverBanner(
  target: HTMLCanvasElement,
  art: HTMLCanvasElement,
  boxW: number,
  boxH: number,
  variant: Variant,
  base: string,
) {
  if (!boxW || !boxH) return;
  const { w, h } = sizeCanvasToBox(target, boxW, boxH);
  const ctx = target.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  if (variant === "blur") {
    ctx.drawImage(art, 0, 0, w, (w * art.height) / art.width);
  } else {
    const scale = Math.max(w / art.width, h / art.height);
    const dw = art.width * scale;
    const dh = art.height * scale;
    ctx.drawImage(art, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }
  const wash = withAlpha(base, 0.5);
  const tint = alphaStops(base, TINT[variant]);
  if (wash && tint) {
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, w, h);
    fillLinear(ctx, "right", w, h, tint);
  }
  fadeBottom(ctx, w, h, FADE_START[variant]);
}

interface Baked {
  key: string;
  variant: Variant;
  canvas: HTMLCanvasElement;
}

/**
 * Album/playlist/mix art rendered as a banner behind the page header. The crisp
 * cover keeps living in its own box on top of this. Renders nothing when there's
 * no artwork.
 */
export default function CoverBanner({
  src,
  variant = "blur",
}: CoverBannerProps) {
  const [boxRef, box] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { bgBase } = useDerivedTheme();
  const [baked, setBaked] = useState<Baked | null>(null);
  const key = src ? `${variant}:${src}` : null;
  const ready = baked !== null && baked.key === key;

  useEffect(() => {
    if (!src || !key) return;
    let cancelled = false;
    bakeCover(src, variant === "blur" ? BLUR_OPTIONS : SHARP_OPTIONS).then(
      (canvas) => {
        if (!cancelled && canvas) setBaked({ key, variant, canvas });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [src, variant, key]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !baked || !ready) return;
    paintCoverBanner(canvas, baked.canvas, box.w, box.h, baked.variant, bgBase);
  }, [baked, ready, box, bgBase]);

  if (!src) return null;

  return (
    <div
      ref={boxRef}
      className="pointer-events-none absolute inset-0 overflow-hidden select-none"
    >
      <canvas
        ref={canvasRef}
        aria-hidden
        data-testid="cover-banner-canvas"
        className="w-full h-full block transition-opacity duration-300"
        style={{ opacity: ready ? 1 : 0 }}
      />
    </div>
  );
}
