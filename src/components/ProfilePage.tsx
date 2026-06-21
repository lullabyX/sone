import { User, Share, Pencil } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "jotai";
import { authTokensAtom, currentUserAvatarAtom } from "../atoms/auth";
import { useNavigation } from "../hooks/useNavigation";
import { useToast } from "../contexts/ToastContext";
import { getProfile, deleteProfilePicture } from "../api/tidal";
import { getApiStatus, safeErrorMessage } from "../lib/errorUtils";
import type { Profile, ProfileArtFile, ProfilePlaylist } from "../types";
import NotFoundPage from "./NotFoundPage";
import { fetchCachedImageUrl } from "./TidalImage";
import TidalImage from "./TidalImage";
import BioText from "./BioText";
import MediaGrid from "./MediaGrid";
import MediaCard from "./MediaCard";
import PageContainer from "./PageContainer";
import { ArtistPageSkeleton } from "./PageSkeleton";
import ProfileEditModal from "./ProfileEditModal";


/**
 * Pick the hero photo href from a profile's pictureFiles. The backend sorts
 * these desc by width ([1280, 640, 320]); the hrefs are already full URLs.
 * Prefer the smallest entry that is >= 640 (a sensible hero size), falling back
 * to the widest available, then to the first entry when widths are unknown.
 */
export function pickProfileHeroImage(files: ProfileArtFile[]): string | null {
  if (files.length === 0) return null;
  const withWidth = files.filter((f) => typeof f.width === "number");
  if (withWidth.length === 0) return files[0].href;
  const atLeast640 = withWidth
    .filter((f) => (f.width as number) >= 640)
    .sort((a, b) => (a.width as number) - (b.width as number));
  if (atLeast640.length > 0) return atLeast640[0].href;
  const widest = withWidth.reduce((a, b) =>
    (a.width as number) >= (b.width as number) ? a : b,
  );
  return widest.href;
}

/**
 * Pick the avatar href from a profile's pictureFiles. TIDAL returns both 1:1
 * and 16:9 renditions, so the round avatar must use a SQUARE one. Prefer
 * squares; the list is sorted desc by width, so the last square is the smallest
 * (cheapest for a tiny avatar). Fall back to the smallest overall only when no
 * square rendition is available (e.g. width/height metadata missing). The hrefs
 * are already full URLs.
 */
export function pickProfileAvatarHref(files: ProfileArtFile[]): string | null {
  if (files.length === 0) return null;
  const squares = files.filter(
    (f) => typeof f.width === "number" && f.width === f.height,
  );
  const pool = squares.length > 0 ? squares : files;
  return pool[pool.length - 1]?.href ?? null;
}

export const PROFILE_PLAYLISTS_INLINE_CAP = 8;

/**
 * Whether to offer the "Add bio" affordance: only on the own profile
 * (artistId present, the same gate as the Edit button) when the bio is empty.
 */
export function shouldShowAddBio(
  bio: string | null | undefined,
  artistId: number | null | undefined,
): boolean {
  return !bio && artistId != null;
}

/**
 * Decide how many public playlists to show inline on the profile and whether to
 * surface a "View all" affordance. The list is whatever getProfile returned
 * (one openapi page); full pagination is a deferred backend follow-up.
 */
export function profilePlaylistsViewAll(
  total: number,
  cap: number,
): { visibleCount: number; showViewAll: boolean } {
  return { visibleCount: Math.min(total, cap), showViewAll: total > cap };
}

function HeaderAction({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className="flex flex-col items-center gap-1.5 text-th-text-secondary hover:text-th-text-primary transition-colors"
    >
      {icon}
      <span className="text-[11px] font-semibold">{label}</span>
    </button>
  );
}

function PlaylistsSection({
  playlists,
  subtitle,
}: {
  playlists: ProfilePlaylist[];
  subtitle: string;
}) {
  const { navigateToPlaylist, navigateToProfilePlaylists } = useNavigation();
  const { visibleCount, showViewAll } = profilePlaylistsViewAll(
    playlists.length,
    PROFILE_PLAYLISTS_INLINE_CAP,
  );
  const visible = playlists.slice(0, visibleCount);

  return (
    <div className="px-8 pb-8">
      <div className="flex items-end justify-between mb-4">
        <h2 className="text-[22px] font-bold text-th-text-primary tracking-tight">
          Public playlists
        </h2>
        {showViewAll && (
          <button
            onClick={() => navigateToProfilePlaylists(playlists, subtitle)}
            className="text-[12px] font-semibold text-th-text-secondary hover:text-th-text-primary transition-colors"
          >
            View all
          </button>
        )}
      </div>
      <MediaGrid>
        {visible.map((pl) => (
          <MediaCard
            key={pl.id}
            item={{ title: pl.title, subTitle: subtitle }}
            titleOverride={pl.title}
            showPlayButton={false}
            imageOverride={
              <TidalImage
                src={pl.coverUrl}
                alt={pl.title}
                type="playlist"
                className="w-full h-full"
              />
            }
            onClick={() =>
              navigateToPlaylist(pl.id, {
                title: pl.title,
                image: pl.coverUrl,
                creatorName: subtitle,
                numberOfTracks: pl.numberOfTracks,
              })
            }
          />
        ))}
      </MediaGrid>
    </div>
  );
}

interface ProfilePageProps {
  onBack: () => void;
}

export default function ProfilePage({ onBack }: ProfilePageProps) {
  const store = useStore();
  const { navigateToArtist } = useNavigation();
  const { showToast } = useToast();

  const userId = store.get(authTokensAtom)?.user_id ?? null;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [heroBlob, setHeroBlob] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    if (userId == null) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      setNotFound(false);
      try {
        const data = await getProfile(userId);
        if (!cancelled) setProfile(data);
      } catch (err: unknown) {
        if (!cancelled) {
          console.error("Failed to load profile:", err);
          if (getApiStatus(err) === 404) {
            setNotFound(true);
          } else {
            setError(safeErrorMessage(err, "Failed to load profile"));
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const reloadProfile = async () => {
    if (userId == null) return;
    try {
      const data = await getProfile(userId);
      setProfile(data);
      store.set(currentUserAvatarAtom, pickProfileAvatarHref(data.pictureFiles));
    } catch (err) {
      console.error("Failed to reload profile:", err);
    }
  };

  const heroHref = profile ? pickProfileHeroImage(profile.pictureFiles) : null;

  useEffect(() => {
    setHeroBlob(null);
    if (!heroHref) return;
    let cancelled = false;
    fetchCachedImageUrl(heroHref)
      .then((b) => {
        if (!cancelled) setHeroBlob(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [heroHref]);

  if (userId == null) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center px-8">
          <User size={48} className="text-th-text-disabled" />
          <p className="text-th-text-primary font-semibold text-lg">
            Not signed in
          </p>
          <p className="text-th-text-muted text-sm max-w-md">
            Sign in to view your profile.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <ArtistPageSkeleton />;
  }

  if (notFound) {
    return <NotFoundPage />;
  }

  if (error || !profile) {
    return (
      <div className="flex-1 bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-center px-8">
          <User size={48} className="text-th-text-disabled" />
          <p className="text-th-text-primary font-semibold text-lg">
            Couldn't load profile
          </p>
          <p className="text-th-text-muted text-sm max-w-md">
            {error ?? "Profile unavailable"}
          </p>
          <button
            onClick={onBack}
            className="mt-2 px-6 py-2 bg-th-text-primary text-th-base rounded-full text-sm font-bold hover:scale-105 transition-transform"
          >
            Go back
          </button>
        </div>
      </div>
    );
  }

  const { name, handle, bio, fanCount, publicPlaylists } = profile;
  const fansLabel =
    typeof fanCount === "number"
      ? `${new Intl.NumberFormat("en", {
          notation: "compact",
          maximumFractionDigits: 1,
        }).format(fanCount)} fan${fanCount === 1 ? "" : "s"}`
      : null;
  const metaParts = [handle ? `@${handle}` : null, fansLabel].filter(Boolean);

  const handleShare = async () => {
    if (!handle) return;
    try {
      await navigator.clipboard.writeText(`https://tidal.com/user/${handle}`);
      showToast("Copied share link to clipboard");
    } catch {
      showToast("Failed to copy share link");
    }
  };

  return (
    <div className="flex-1 bg-linear-to-b from-th-surface to-th-base overflow-y-auto scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent">
      {/* Profile hero — full-bleed photo banner */}
      <div className="relative w-full h-[480px] overflow-hidden flex items-end mb-8">
        {heroBlob && (
          <div className="absolute inset-0 flex justify-center overflow-hidden">
            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <img
                key={i}
                src={heroBlob}
                alt=""
                draggable={false}
                className={`h-full w-auto shrink-0 select-none object-cover ${
                  i === 3 ? "" : "brightness-[0.32]"
                }`}
              />
            ))}
          </div>
        )}
        {/* Left scrim for text legibility (tracks the theme base) */}
        <div className="absolute inset-0 bg-gradient-to-r from-th-base/70 via-th-base/30 to-transparent" />
        {/* Glassy frosted fade-out — the tiled photo blurs and melts into the page */}
        <div
          className="absolute inset-x-0 bottom-0 h-2/3 pointer-events-none backdrop-blur-2xl bg-gradient-to-b from-transparent via-th-base/30 to-th-base"
          style={{
            maskImage: "linear-gradient(to bottom, transparent 0%, #000 45%)",
            WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, #000 45%)",
          }}
        />

        {/* Foreground content */}
        <PageContainer className="relative z-10 w-full">
          <div className="px-8 pb-6">
            <div className="max-w-[820px] min-w-0">
              <h1 className="text-[56px] font-extrabold text-th-text-primary leading-[1.1] tracking-tight line-clamp-2 pb-1">
                {name}
              </h1>
              {metaParts.length > 0 && (
                <p className="mt-4 text-[14px] font-bold text-th-text-secondary">
                  {metaParts.join(" · ")}
                </p>
              )}
              {bio && (
                <div className="mt-3">
                  <BioText
                    bio={bio}
                    onArtistClick={(id, n) => navigateToArtist(id, { name: n })}
                    className="text-th-text-muted line-clamp-3"
                  />
                </div>
              )}
              {shouldShowAddBio(bio, profile.artistId) && (
                <button
                  onClick={() => setEditOpen(true)}
                  className="mt-3 inline-flex items-center px-4 py-1.5 rounded-full border border-dashed border-th-border-subtle text-[13px] font-semibold text-th-text-secondary hover:text-th-text-primary hover:border-th-text-secondary transition-colors"
                >
                  Add bio
                </button>
              )}
            </div>

            <div className="mt-6 flex items-center gap-7">
              {profile.artistId != null && (
                <HeaderAction
                  icon={<Pencil size={22} />}
                  label="Edit profile"
                  onClick={() => setEditOpen(true)}
                />
              )}
              {handle && (
                <HeaderAction
                  icon={<Share size={22} />}
                  label="Share"
                  onClick={handleShare}
                />
              )}
            </div>
          </div>
        </PageContainer>
      </div>

      <PageContainer>
        {publicPlaylists.length > 0 && (
          <PlaylistsSection playlists={publicPlaylists} subtitle={name} />
        )}
      </PageContainer>

      {editOpen && (
        <ProfileEditModal
          profile={profile}
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onSaved={reloadProfile}
          onDeletePicture={async () => {
            if (profile.artistId == null) return;
            try {
              await deleteProfilePicture(profile.artistId);
              showToast("Profile picture removed");
              reloadProfile();
            } catch (err) {
              showToast(
                safeErrorMessage(err, "Failed to remove picture"),
                "error",
              );
            }
          }}
        />
      )}
    </div>
  );
}
