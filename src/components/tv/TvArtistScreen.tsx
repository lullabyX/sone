import { useCallback } from "react";
import { BookOpen, Heart, Play, Radio, Shuffle } from "lucide-react";
import { getArtistPage } from "../../api/tidal";
import { useFavorites } from "../../hooks/useFavorites";
import {
  artistTopTracksPager,
  type PlayableSource,
} from "../../lib/trackSources";
import type { Track } from "../../types";
import { getArtistImage } from "../../utils/itemHelpers";
import { bioParagraphs } from "../BioText";
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
const TRACK_ROWS_SHOWN = 10;

export default function TvArtistScreen({
  view,
}: {
  view: Extract<TvView, { type: "artist" }>;
}) {
  const nav = useTvNav();
  const { followedArtistIds, followArtist, unfollowArtist } = useFavorites();
  const load = useCallback(() => getArtistPage(view.id), [view.id]);
  const { data, error, retry } = useTvLoader(load, "Couldn't load artist");

  useTvInitialFocus(data !== null || error !== null);

  if (error) return <TvError message={error} onRetry={retry} />;
  if (!data) return <TvSpinner />;

  const name = data.artistName || view.name || "Artist";
  const image = getArtistImage(data, 750) || view.image;
  const meta = { type: "artist", id: view.id, name, image };
  // The preview isn't guaranteed to be a prefix of the full list, so page
  // from 0 and let de-duplication drop the overlap (desktop ArtistPage).
  const artistPlayable = (): PlayableSource => ({
    meta,
    loaded: data.topTracks,
    nextOffset: 0,
    fetchPage: artistTopTracksPager(view.id),
    dedupe: true,
  });
  const following = followedArtistIds.has(view.id);
  const bio = data.bio;
  const empty = data.sections.length === 0 && data.topTracks.length === 0;

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
          <>
            <TvButton
              primary
              autoFocus
              icon={<Play className="w-[1rem] h-[1rem]" fill="currentColor" />}
              label="Play"
              onClick={() => void nav.playSource(artistPlayable())}
            />
            <TvButton
              icon={<Shuffle className="w-[1rem] h-[1rem]" />}
              label="Shuffle"
              onClick={() =>
                void nav.playSource(artistPlayable(), { shuffle: true })
              }
            />
          </>
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
                mixType: "ARTIST_MIX",
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
        {bio && (
          <TvButton
            icon={<BookOpen className="w-[1rem] h-[1rem]" />}
            label="Biography"
            onClick={() =>
              nav.openMenu({
                title: "Biography",
                subtitle: data.bioSource
                  ? `Artist bio from ${data.bioSource}`
                  : undefined,
                wide: true,
                items: bioParagraphs(bio).map((p) => ({
                  label: p,
                  multiline: true,
                })),
              })
            }
          />
        )}
      </TvHeader>

      {data.sections.map((section, i) => {
        const key = `${section.title}:${i}`;
        if (section.type === "TRACK_LIST") {
          const tracks = section.items as Track[];
          if (tracks.length === 0) return null;
          // Only the first TRACK_LIST is the top tracks (same array as
          // data.topTracks); other track sections play their own list.
          const isTopTracks = section.items === data.topTracks;
          return (
            <section key={key} className="mb-[1.5rem]">
              <h2 className="text-[1.05rem] font-bold text-th-text-primary px-[3rem] mb-[0.4rem]">
                {section.title}
              </h2>
              <div className="px-[2rem]">
                {tracks.slice(0, TRACK_ROWS_SHOWN).map((track, j) => (
                  <TvTrackRow
                    key={track.id}
                    track={track}
                    index={j}
                    showCover
                    blockedNoMenu
                    onSelect={() =>
                      void nav.playSource(
                        isTopTracks
                          ? artistPlayable()
                          : { meta, loaded: tracks },
                        { startAt: track },
                      )
                    }
                  />
                ))}
                {isTopTracks && (
                  <div className="px-[1rem] pt-[0.6rem]">
                    <TvButton
                      label="View all"
                      onClick={() =>
                        nav.push({
                          type: "artistTracks",
                          artistId: view.id,
                          name,
                        })
                      }
                    />
                  </div>
                )}
              </div>
            </section>
          );
        }
        if (!CARD_SECTIONS.includes(section.type)) return null;
        const { entries } = sectionEntries(section.items, section.type);
        return (
          <TvRow
            key={key}
            title={section.title}
            entries={entries}
            showExplicit
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

      {empty && (
        <p className="px-[3rem] text-[1rem] text-th-text-muted">
          This artist doesn't have any tracks or albums yet.
        </p>
      )}
    </div>
  );
}
