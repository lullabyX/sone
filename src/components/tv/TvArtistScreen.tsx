import { useCallback } from "react";
import { Heart, Play, Radio } from "lucide-react";
import { getArtistPage } from "../../api/tidal";
import { useFavorites } from "../../hooks/useFavorites";
import { usePlaybackActions } from "../../hooks/usePlaybackActions";
import { getArtistImage } from "../../utils/itemHelpers";
import { useTvInitialFocus, useTvNav } from "./TvNavContext";
import {
  TvButton,
  TvError,
  TvHeader,
  TvRow,
  TvSpinner,
  TvTrackRow,
} from "./TvParts";
import { sectionEntries, type TvView } from "./tvItems";
import { useTvLoader } from "./useTvLoader";

const CARD_SECTIONS = [
  "ALBUM_LIST",
  "ARTIST_LIST",
  "PLAYLIST_LIST",
  "MIX_LIST",
  "VIDEO_LIST",
];
const TOP_TRACKS_SHOWN = 10;

export default function TvArtistScreen({
  view,
}: {
  view: Extract<TvView, { type: "artist" }>;
}) {
  const nav = useTvNav();
  const { playAllFromSource } = usePlaybackActions();
  const { followedArtistIds, followArtist, unfollowArtist } = useFavorites();
  const load = useCallback(() => getArtistPage(view.id), [view.id]);
  const { data, error, retry } = useTvLoader(load, "Couldn't load artist");

  useTvInitialFocus(data !== null || error !== null);

  if (error) return <TvError message={error} onRetry={retry} />;
  if (!data) return <TvSpinner />;

  const name = data.artistName || view.name || "Artist";
  const image = getArtistImage(data, 750) || view.image;
  const topTracks = data.topTracks.slice(0, TOP_TRACKS_SHOWN);
  const source = {
    type: "artist",
    id: view.id,
    name,
    image,
    allTracks: data.topTracks,
  };
  const following = followedArtistIds.has(view.id);

  return (
    <div className="pb-[3rem]">
      <TvHeader
        image={image}
        round
        kicker="Artist"
        title={name}
        subtitle={
          data.followers
            ? `${data.followers.toLocaleString()} followers`
            : undefined
        }
      >
        {data.topTracks.length > 0 && (
          <TvButton
            primary
            autoFocus
            icon={<Play className="w-[1rem] h-[1rem]" fill="currentColor" />}
            label="Play"
            onClick={() => {
              void playAllFromSource(data.topTracks, { source });
              nav.showNowPlaying();
            }}
          />
        )}
        {data.radioMixId && (
          <TvButton
            icon={<Radio className="w-[1rem] h-[1rem]" />}
            label="Artist radio"
            onClick={() =>
              nav.push({
                type: "mix",
                mixId: data.radioMixId!,
                title: `${name} Radio`,
              })
            }
          />
        )}
        <TvButton
          active={following}
          icon={
            <Heart
              className="w-[1rem] h-[1rem]"
              fill={following ? "currentColor" : "none"}
            />
          }
          label={following ? "Following" : "Follow"}
          onClick={() =>
            void (
              following
                ? unfollowArtist(view.id)
                : followArtist(view.id, {
                    id: view.id,
                    name,
                    picture: data.picture,
                  })
            ).catch(() => {})
          }
        />
      </TvHeader>

      {topTracks.length > 0 && (
        <section className="mb-[1.5rem]">
          <h2 className="text-[1.05rem] font-bold text-th-text-primary px-[3rem] mb-[0.4rem]">
            Top tracks
          </h2>
          <div className="px-[2rem]">
            {topTracks.map((track, i) => (
              <TvTrackRow
                key={track.id}
                track={track}
                index={i}
                showCover
                onSelect={() =>
                  nav.playTrack(track, data.topTracks, { source })
                }
              />
            ))}
          </div>
        </section>
      )}

      {data.sections
        .filter((s) => CARD_SECTIONS.includes(s.type))
        .map((section, i) => {
          const { entries } = sectionEntries(section.items, section.type);
          return (
            <TvRow
              key={`${section.title}:${i}`}
              title={section.title}
              entries={entries}
              viewAll={
                section.apiPath
                  ? {
                      type: "list",
                      title: `${name}: ${section.title}`,
                      source: {
                        kind: "artist",
                        artistId: view.id,
                        apiPath: section.apiPath,
                      },
                    }
                  : undefined
              }
            />
          );
        })}
    </div>
  );
}
