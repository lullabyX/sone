import { useNavigation } from "../hooks/useNavigation";
import type { ProfilePlaylist } from "../types";
import TidalImage from "./TidalImage";
import MediaGrid, { MediaGridEmpty } from "./MediaGrid";
import MediaCard from "./MediaCard";
import PageContainer from "./PageContainer";

interface ProfilePlaylistsPageProps {
  playlists: ProfilePlaylist[];
  profileName: string;
}

/**
 * Full grid of a profile's public playlists. The list is whatever getProfile
 * returned (one openapi page) and is passed in via the AppView; this page does
 * no fetching or pagination, so it only ever shows that one page of playlists.
 * Full pagination is a deferred backend follow-up.
 */
export default function ProfilePlaylistsPage({
  playlists,
  profileName,
}: ProfilePlaylistsPageProps) {
  const { navigateToPlaylist } = useNavigation();
  const count = playlists.length;

  return (
    <div className="flex-1 bg-linear-to-b from-th-surface to-th-base overflow-y-auto scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent">
      <PageContainer>
        <div className="px-8 pt-10 pb-6">
          <h1 className="text-[32px] font-extrabold text-th-text-primary leading-tight tracking-tight">
            Public playlists
          </h1>
          <p className="text-[14px] text-th-text-muted mt-1">
            {count} {count === 1 ? "playlist" : "playlists"}
          </p>
        </div>
        <div className="px-8 pb-8">
          {count === 0 ? (
            <MediaGridEmpty message="No public playlists" />
          ) : (
            <MediaGrid>
              {playlists.map((pl) => (
                <MediaCard
                  key={pl.id}
                  item={{ title: pl.title, subTitle: profileName }}
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
                      creatorName: profileName,
                      numberOfTracks: pl.numberOfTracks,
                    })
                  }
                />
              ))}
            </MediaGrid>
          )}
        </div>
      </PageContainer>
    </div>
  );
}
