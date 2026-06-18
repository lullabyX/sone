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
const FADE = "linear-gradient(to bottom, #000 0%, #000 50%, transparent 100%)";
// Sharp art (dark variant) is more present, so start dissolving sooner.
const DARK_FADE =
  "linear-gradient(to bottom, #000 0%, #000 22%, transparent 100%)";

/**
 * Album/playlist/mix art rendered as a banner behind the page header. The crisp
 * cover keeps living in its own box on top of this. Renders nothing when there's
 * no artwork.
 */
export default function CoverBanner({
  src,
  variant = "blur",
}: CoverBannerProps) {
  if (!src) return null;

  const fade = variant === "dark" ? DARK_FADE : FADE;

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden select-none"
      style={{ maskImage: fade, WebkitMaskImage: fade }}
    >
      {variant === "blur" ? (
        <>
          <div className="absolute inset-0 blur-3xl saturate-150">
            <TidalImage
              src={src}
              alt=""
              className="w-full"
              objectFit="object-top"
            />
          </div>
          {/* Semitransparent base-tone layer: darkens on dark themes, lightens on
              light themes, so the bright blur reads as TIDAL's deep tone either way. */}
          <div className="absolute inset-0 bg-th-base/60" />
          {/* Keep the title/metadata side readable, like TIDAL. */}
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-th-base/20 to-th-base/60" />
        </>
      ) : (
        <>
          <div className="absolute inset-0 scale-105 brightness-[0.65]">
            <TidalImage src={src} alt="" className="h-full w-full" />
          </div>
          {/* Tint the left where the title/metadata sit (theme base), reveal art on the right. */}
          <div className="absolute inset-0 bg-gradient-to-r from-th-base/70 via-th-base/30 to-transparent" />
        </>
      )}
    </div>
  );
}
