import TidalImage from "./TidalImage";

interface CoverBannerProps {
  /** Resolved image URL (UUID already run through getTidalImageUrl, or a direct URL). */
  src: string | undefined;
  /**
   * "blur" — heavily blurred, faint backdrop (playlists, mixes).
   * "dark" — sharp art, darkened, TIDAL album-page style.
   */
  variant?: "blur" | "dark";
}

// Fade applied to the unscaled outer box so it dissolves at the true bottom edge.
const FADE =
  "linear-gradient(to bottom, #000 0%, #000 50%, transparent 100%)";

/**
 * Album/playlist/mix art rendered as a banner behind the page header. The crisp
 * cover keeps living in its own box on top of this. Renders nothing when there's
 * no artwork.
 */
export default function CoverBanner({ src, variant = "blur" }: CoverBannerProps) {
  if (!src) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden select-none"
      style={{ maskImage: FADE, WebkitMaskImage: FADE }}
    >
      {variant === "blur" ? (
        <div className="absolute inset-0 scale-125 blur-[64px] opacity-60">
          <TidalImage src={src} alt="" className="h-full w-full" />
        </div>
      ) : (
        <>
          <div className="absolute inset-0 scale-105 brightness-[0.65]">
            <TidalImage src={src} alt="" className="h-full w-full" />
          </div>
          {/* Darken the left where the title/metadata sit, reveal art on the right. */}
          <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/30 to-transparent" />
        </>
      )}
    </div>
  );
}
