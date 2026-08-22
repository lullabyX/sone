import { useCallback } from "react";
import { useSetAtom } from "jotai";
import { downloadDrawerOpenAtom, downloadItemsAtom, downloadQueueAtom } from "../atoms/downloads";
import { getTidalImageUrl, type DownloadItem, type DownloadQueueEntry, type MediaItemType, type Track } from "../types";
import { fetchMediaTracks, getAlbumPage, getArtistAlbums } from "../api/tidal";

function numberingWidth(trackCount: number): number {
  return Math.max(2, String(Math.max(trackCount, 1)).length);
}

function albumOutput(trackCount = 0): string {
  return `{album.artist}/{album.title}/{item.number:0${numberingWidth(trackCount)}d} - {item.title}`;
}

function playlistOutput(trackCount = 0): string {
  return `{playlist.title}/{playlist.index:0${numberingWidth(trackCount)}d} - {item.artist} - {item.title}`;
}

const videoOutput = "{item.artist}/Videos/{item.artist} - {item.title}";
const looseTrackOutput = "{item.artist}/{item.title}";

function pendingItem(entryId: string, track: Track, index: number): DownloadItem {
  return {
    itemInstanceId: `${entryId}-${track.id}-${index}`,
    title: track.title,
    artist: track.artist?.name ?? track.artists?.[0]?.name,
    itemType: track.itemType,
    status: "pending",
  };
}

function entryFromTrack(track: Track): DownloadQueueEntry {
  const isVideo = track.itemType === "video";
  const sourceType = isVideo ? "video" : "track";
  return {
    id: crypto.randomUUID(),
    sourceType,
    url: `https://tidal.com/${sourceType}/${track.id}`,
    title: track.title,
    subtitle: track.artist?.name ?? track.artists?.[0]?.name,
    output: isVideo ? videoOutput : track.album ? albumOutput() : looseTrackOutput,
    resolvedItems: [track],
    resolutionStatus: "ready" as const,
  };
}

function entryFromMedia(item: MediaItemType): DownloadQueueEntry | null {
  switch (item.type) {
    case "album":
      return { id: crypto.randomUUID(), sourceType: "album" as const, url: `https://tidal.com/album/${item.id}`, title: item.title, subtitle: item.artistName, output: albumOutput(), coverUrl: getTidalImageUrl(item.cover, 1280) || undefined };
    case "playlist":
      return { id: crypto.randomUUID(), sourceType: "playlist" as const, url: `https://tidal.com/playlist/${item.uuid}`, title: item.title, subtitle: item.creatorName, output: playlistOutput() };
    case "artist":
      return { id: crypto.randomUUID(), sourceType: "artist" as const, url: `https://tidal.com/artist/${item.id}`, title: item.name, output: albumOutput() };
    case "video":
      return { id: crypto.randomUUID(), sourceType: "video" as const, url: `https://tidal.com/video/${item.id}`, title: item.title, subtitle: item.artist, output: videoOutput };
    case "mix":
      return null;
  }
}

export function useDownloadQueue() {
  const setQueue = useSetAtom(downloadQueueAtom);
  const setItems = useSetAtom(downloadItemsAtom);
  const setDrawerOpen = useSetAtom(downloadDrawerOpenAtom);
  const addTrackToDownloads = useCallback((track: Track) => {
    const entry = entryFromTrack(track);
    const pending = pendingItem(entry.id, track, 0);
    setQueue((queue) => [...queue, entry]);
    setItems((items) => ({ ...items, [pending.itemInstanceId]: pending }));
  }, [setItems, setQueue]);
  const addMediaToDownloads = useCallback((item: MediaItemType) => {
    const entry = entryFromMedia(item);
    if (!entry) return;
    setQueue((queue) => [...queue, { ...entry, resolutionStatus: "loading" }]);
    const resolveItems = async () => {
      try {
        const albumPage = item.type === "album" ? (await getAlbumPage(item.id)).page : undefined;
        const tracks = item.type === "artist"
          ? (await Promise.all((await getArtistAlbums(item.id, 100)).map((album) => getAlbumPage(album.id).then(({ page }) => page.tracks)))).flat()
          : albumPage?.tracks ?? await fetchMediaTracks(item);
        const output = item.type === "playlist" ? playlistOutput(tracks.length) : albumOutput(tracks.length);
        setQueue((queue) => queue.map((queued) => queued.id === entry.id ? {
          ...queued,
          output,
          coverUrl: albumPage ? getTidalImageUrl(albumPage.album.cover, 1280) || queued.coverUrl : queued.coverUrl,
          resolvedItems: tracks,
          resolutionStatus: "ready",
        } : queued));
        setItems((items) => ({
          ...items,
          ...Object.fromEntries(tracks.map((track, index) => {
            const pending = pendingItem(entry.id, track, index);
            return [pending.itemInstanceId, pending];
          })),
        }));
      } catch {
        setQueue((queue) => queue.map((queued) => queued.id === entry.id ? { ...queued, resolutionStatus: "error" } : queued));
      }
    };
    void resolveItems();
  }, [setItems, setQueue]);
  return { addTrackToDownloads, addMediaToDownloads, openDownloadQueue: () => setDrawerOpen(true) };
}
