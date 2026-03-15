import { memo } from "react";
import { useNavigation } from "../hooks/useNavigation";

interface ArtistInfo {
  id: number;
  name: string;
  picture?: string;
}

interface TrackArtistsProps {
  /** Full artists array (preferred) */
  artists?: ArtistInfo[];
  /** Singular artist fallback */
  artist?: ArtistInfo;
  /** CSS class for each artist name span */
  className?: string;
  /** Fallback text when no artist data exists */
  fallback?: string;
  /** Called on click instead of default navigation (e.g. for NowPlayingDrawer's drawer-close-then-navigate) */
  onArtistClick?: (artist: ArtistInfo) => void;
}

/** Renders comma-separated, individually-clickable artist names. */
export const TrackArtists = memo(function TrackArtists({
  artists,
  artist,
  className = "",
  fallback = "Unknown Artist",
  onArtistClick,
}: TrackArtistsProps) {
  const { navigateToArtist } = useNavigation();

  // Build the list: prefer artists[], fall back to singular artist
  const list: ArtistInfo[] =
    artists && artists.length > 0
      ? artists
      : artist
        ? [artist]
        : [];

  if (list.length === 0) return <>{fallback}</>;

  return (
    <>
      {list.map((a, i) => (
        <span key={`${a.id}-${i}`}>
          <span
            className={className}
            onClick={(e) => {
              e.stopPropagation();
              if (onArtistClick) {
                onArtistClick(a);
              } else if (a.id) {
                navigateToArtist(a.id, { name: a.name, picture: a.picture });
              }
            }}
          >
            {a.name}
          </span>
          {i < list.length - 1 && ", "}
        </span>
      ))}
    </>
  );
});

export type { ArtistInfo };
