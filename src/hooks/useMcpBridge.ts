import { useEffect, useRef } from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  currentTrackAtom,
  isPlayingAtom,
  queueAtom,
  manualQueueAtom,
  repeatAtom,
  shuffleAtom,
} from "../atoms/playback";
import {
  userPlaylistsAtom,
  addedToFolderAtom,
  deletedPlaylistIdsAtom,
  updatedPlaylistsAtom,
} from "../atoms/playlists";
import {
  favoriteTrackIdsAtom,
  favoriteAlbumIdsAtom,
  followedArtistIdsAtom,
  optimisticFavoriteAlbumsAtom,
  optimisticFollowedArtistsAtom,
} from "../atoms/favorites";
import { authTokensAtom } from "../atoms/auth";
import { getTrackArtistDisplay } from "../utils/itemHelpers";
import { usePlaybackActions } from "./usePlaybackActions";
import {
  getTrack,
  getPlaylistTracks,
  getPlaylistDetails,
  getMixItems,
  getArtistTopTracks,
  getArtistDetail,
  getAlbumDetail,
  getAlbumPage,
  getPlaylistFolders,
  normalizePlaylistFolders,
  invalidateCache,
  addAlbumToFavoritesCache,
  removeAlbumFromFavoritesCache,
  addArtistToFollowedCache,
  removeArtistFromFollowedCache,
  removeTrackFromFavoritesCache,
} from "../api/tidal";
import type { Track, Playlist, PlaylistOrFolder } from "../types";

type SourceData = {
  tracks: Track[];
  source: {
    type: string;
    id: string | number;
    name: string;
    image?: string;
    subtitle?: string;
    mixType?: string;
    allTracks: Track[];
  };
  albumMode?: boolean;
};

async function fetchSourceWithMetadata(
  sourceType: string,
  id: string,
): Promise<SourceData | null> {
  if (sourceType === "playlist") {
    const tracks = await getPlaylistTracks(id);
    try {
      const details = await getPlaylistDetails(id);
      return {
        tracks,
        source: {
          type: "playlist",
          id,
          name: details.title,
          image: details.squareImage ?? details.image,
          allTracks: tracks,
        },
      };
    } catch {
      // metadata fetch failed — fall back to tracks-only
      return {
        tracks,
        source: { type: "playlist", id, name: "Playlist", allTracks: tracks },
      };
    }
  } else if (sourceType === "album") {
    const { page } = await getAlbumPage(Number(id));
    const tracks = page.tracks;
    return {
      tracks,
      source: {
        type: "album",
        id: Number(id),
        name: page.album.title,
        image: page.album.cover,
        allTracks: tracks,
      },
      albumMode: true,
    };
  } else if (sourceType === "artist") {
    const tracks = await getArtistTopTracks(Number(id));
    try {
      const detail = await getArtistDetail(Number(id));
      return {
        tracks,
        source: {
          type: "artist",
          id: Number(id),
          name: detail.name,
          image: detail.picture ?? undefined,
          subtitle: "Top tracks",
          allTracks: tracks,
        },
      };
    } catch {
      // metadata fetch failed — fall back to tracks-only
      return {
        tracks,
        source: {
          type: "artist",
          id: Number(id),
          name: "Artist",
          allTracks: tracks,
        },
      };
    }
  } else if (sourceType === "mix") {
    const result = await getMixItems(id);
    return {
      tracks: result.tracks,
      source: {
        type: "mix",
        id,
        name: result.title ?? "Mix",
        image: result.image ?? undefined,
        mixType: result.mixType ?? undefined,
        allTracks: result.tracks,
      },
    };
  }
  return null;
}

type NowPlayingSnapshot = {
  trackId: number | null;
  title: string;
  artist: string;
  album: string | null;
  durationSeconds: number;
  positionSeconds: number;
  isPlaying: boolean;
};

type QueueTrackSnapshot = {
  id: number;
  title: string;
  artist: string;
};

export function useMcpBridge() {
  const currentTrack = useAtomValue(currentTrackAtom);
  const isPlaying = useAtomValue(isPlayingAtom);
  const queue = useAtomValue(queueAtom);
  const manualQueue = useAtomValue(manualQueueAtom);
  const setRepeat = useSetAtom(repeatAtom);
  const setShuffle = useSetAtom(shuffleAtom);
  const actions = usePlaybackActions();
  const store = useStore();

  // Refs so listener closures always read the latest values without
  // forcing the listener effect to re-run on every state change.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const manualQueueRef = useRef(manualQueue);
  manualQueueRef.current = manualQueue;

  const queueRef = useRef(queue);
  queueRef.current = queue;

  // Position is updated via a custom DOM event so we avoid re-rendering
  // this hook on every tick — a ref read is sufficient at publish time.
  const positionRef = useRef(0);

  useEffect(() => {
    const onTime = (e: Event) => {
      const detail = (e as CustomEvent<{ position: number }>).detail;
      if (typeof detail?.position === "number") {
        positionRef.current = Math.round(detail.position);
      }
    };
    window.addEventListener("sone:playback-position", onTime);
    return () => window.removeEventListener("sone:playback-position", onTime);
  }, []);

  useEffect(() => {
    const nowPlaying: NowPlayingSnapshot | null = currentTrack
      ? {
          trackId: currentTrack.id ?? null,
          title: currentTrack.title ?? "",
          artist: getTrackArtistDisplay(currentTrack),
          album: currentTrack.album?.title ?? null,
          durationSeconds: currentTrack.duration ?? 0,
          positionSeconds: positionRef.current,
          isPlaying,
        }
      : null;

    const merged: QueueTrackSnapshot[] = [...manualQueue, ...queue]
      .slice(0, 50)
      .map((t) => ({
        id: t.id,
        title: t.title ?? "",
        artist: getTrackArtistDisplay(t),
      }));

    invoke("mcp_publish_state", {
      nowPlaying,
      queue: merged,
    }).catch((e) => {
      console.warn("mcp_publish_state failed:", e);
    });
  }, [currentTrack, isPlaying, queue, manualQueue]);

  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [];

    unlisteners.push(
      listen<{ trackIds: number[]; action: string }>(
        "mcp:play-tracks",
        async (e) => {
          const { trackIds, action } = e.payload;
          try {
            const settled = await Promise.allSettled(
              trackIds.map((id) => getTrack(id)),
            );
            const tracks = settled
              .filter(
                (r): r is PromiseFulfilledResult<Track> =>
                  r.status === "fulfilled",
              )
              .map((r) => r.value);
            if (tracks.length === 0) return;

            if (action === "play_now") {
              await actionsRef.current.playAllFromSource(tracks);
            } else if (action === "queue") {
              for (const t of tracks) actionsRef.current.addToQueue(t);
            } else if (action === "play_next") {
              for (const t of [...tracks].reverse())
                actionsRef.current.playNextInQueue(t);
            }
          } catch (err) {
            console.error("mcp:play-tracks failed:", err);
          }
        },
      ),
    );

    unlisteners.push(
      listen<{ sourceType: string; id: string }>(
        "mcp:play-source",
        async (e) => {
          const { sourceType, id } = e.payload;
          try {
            const data = await fetchSourceWithMetadata(sourceType, id);
            if (!data || data.tracks.length === 0) return;
            const opts: { source: typeof data.source; albumMode?: boolean } = {
              source: data.source,
            };
            if (data.albumMode) opts.albumMode = true;
            await actionsRef.current.playAllFromSource(data.tracks, opts);
          } catch (err) {
            console.error("mcp:play-source failed:", err);
          }
        },
      ),
    );

    unlisteners.push(
      listen<{ sourceType: string; id: string }>(
        "mcp:shuffle-source",
        async (e) => {
          const { sourceType, id } = e.payload;
          try {
            const data = await fetchSourceWithMetadata(sourceType, id);
            if (!data || data.tracks.length === 0) return;
            setShuffle(true);
            const opts: { source: typeof data.source; albumMode?: boolean } = {
              source: data.source,
            };
            if (data.albumMode) opts.albumMode = true;
            await actionsRef.current.playAllFromSource(data.tracks, opts);
          } catch (err) {
            console.error("mcp:shuffle-source failed:", err);
          }
        },
      ),
    );

    unlisteners.push(
      listen("mcp:pause", () => {
        actionsRef.current.pauseTrack().catch(() => {});
      }),
    );
    unlisteners.push(
      listen("mcp:resume", () => {
        actionsRef.current.resumeTrack().catch(() => {});
      }),
    );
    unlisteners.push(
      listen("mcp:skip-next", () => {
        actionsRef.current.playNext({ explicit: true }).catch(() => {});
      }),
    );
    unlisteners.push(
      listen("mcp:skip-previous", () => {
        actionsRef.current.playPrevious().catch(() => {});
      }),
    );
    unlisteners.push(
      listen("mcp:clear-queue", () => {
        actionsRef.current.clearQueue();
      }),
    );
    unlisteners.push(
      listen("mcp:toggle-shuffle", () => {
        actionsRef.current.toggleShuffle();
      }),
    );

    unlisteners.push(
      listen<{ positionSeconds: number }>("mcp:seek", (e) => {
        actionsRef.current.seekTo(e.payload.positionSeconds).catch(() => {});
      }),
    );

    unlisteners.push(
      listen<{ level: number }>("mcp:set-volume", (e) => {
        actionsRef.current.setVolume(e.payload.level).catch(() => {});
      }),
    );

    unlisteners.push(
      listen<{ trackId: number }>("mcp:remove-from-queue", (e) => {
        // removeFromQueue takes an index into the combined [manualQueue, queue] array.
        // Find the first occurrence of the given trackId across both segments.
        const combined = [...manualQueueRef.current, ...queueRef.current];
        const index = combined.findIndex((t) => t.id === e.payload.trackId);
        if (index !== -1) actionsRef.current.removeFromQueue(index);
      }),
    );

    unlisteners.push(
      listen<{ mode: string }>("mcp:set-repeat", (e) => {
        const map: Record<string, number> = { off: 0, all: 1, one: 2 };
        const v = map[e.payload.mode];
        if (v !== undefined) setRepeat(v);
      }),
    );

    // ================================================================
    //  Library mutations from MCP server
    // ================================================================

    // Re-fetch root playlists list and merge into atoms — used to pick up
    // server-generated cover art / exact counts after an MCP mutation.
    const refreshSidebarPlaylists = () => {
      getPlaylistFolders("root", 0, 50)
        .then((res) => {
          const normalized = normalizePlaylistFolders(res);
          const fresh = normalized.items
            .filter(
              (i): i is Extract<PlaylistOrFolder, { kind: "playlist" }> =>
                i.kind === "playlist",
            )
            .map((i) => i.data);
          if (!fresh.length) return;
          store.set(userPlaylistsAtom, (prev) => {
            if (prev.length === 0) return fresh;
            const freshUuids = new Set(fresh.map((p) => p.uuid));
            const retained = prev.filter((p) => !freshUuids.has(p.uuid));
            return [...fresh, ...retained];
          });
          const freshMap = new Map(fresh.map((p) => [p.uuid, p]));
          store.set(addedToFolderAtom, (prev) => {
            const rootList = prev.get("root");
            if (!rootList?.length) return prev;
            let changed = false;
            const updated = rootList.map((entry) => {
              if (entry.kind !== "playlist") return entry;
              const ref = freshMap.get(entry.data.uuid);
              if (
                ref &&
                (ref.image !== entry.data.image ||
                  ref.numberOfTracks !== entry.data.numberOfTracks)
              ) {
                changed = true;
                return { ...entry, data: { ...entry.data, ...ref } };
              }
              return entry;
            });
            if (!changed) return prev;
            const next = new Map(prev);
            next.set("root", updated);
            return next;
          });
        })
        .catch(() => {});
    };

    unlisteners.push(
      listen<Playlist>("mcp:playlist-created", (e) => {
        const playlist = e.payload;
        store.set(userPlaylistsAtom, (prev) =>
          prev.some((p) => p.uuid === playlist.uuid)
            ? prev
            : [playlist, ...prev],
        );
        store.set(addedToFolderAtom, (prev) => {
          const next = new Map(prev);
          const list = next.get("root") ?? [];
          if (
            list.some(
              (e) => e.kind === "playlist" && e.data.uuid === playlist.uuid,
            )
          )
            return prev;
          next.set("root", [
            ...list,
            { kind: "playlist" as const, data: playlist },
          ]);
          return next;
        });
        invalidateCache("user-playlists");
        // Delayed refresh to pick up cover art generated server-side
        setTimeout(refreshSidebarPlaylists, 3000);
      }),
    );

    unlisteners.push(
      listen<{
        uuid: string;
        title: string | null;
        description: string | null;
      }>("mcp:playlist-updated", (e) => {
        const { uuid, title, description } = e.payload;
        store.set(userPlaylistsAtom, (prev) =>
          prev.map((p) =>
            p.uuid === uuid
              ? {
                  ...p,
                  ...(title != null ? { title } : {}),
                  ...(description != null ? { description } : {}),
                }
              : p,
          ),
        );
        store.set(updatedPlaylistsAtom, (prev) => {
          const next = new Map(prev);
          const existing = next.get(uuid) ?? {
            title: title ?? "",
            description: undefined,
          };
          next.set(uuid, {
            title: title ?? existing.title,
            description: description ?? existing.description,
          });
          return next;
        });
        invalidateCache("user-playlists");
      }),
    );

    unlisteners.push(
      listen<{ uuid: string }>("mcp:playlist-deleted", (e) => {
        const { uuid } = e.payload;
        store.set(userPlaylistsAtom, (prev) =>
          prev.filter((p) => p.uuid !== uuid),
        );
        store.set(deletedPlaylistIdsAtom, (prev) => new Set(prev).add(uuid));
        invalidateCache("user-playlists");
        invalidateCache(`playlist:${uuid}`);
        invalidateCache(`playlist-page:${uuid}`);
      }),
    );

    unlisteners.push(
      listen<{ uuid: string; delta: number }>(
        "mcp:playlist-tracks-changed",
        (e) => {
          const { uuid, delta } = e.payload;
          store.set(userPlaylistsAtom, (prev) =>
            prev.map((p) =>
              p.uuid === uuid
                ? {
                    ...p,
                    numberOfTracks: Math.max(
                      0,
                      (p.numberOfTracks ?? 0) + delta,
                    ),
                  }
                : p,
            ),
          );
          invalidateCache(`playlist:${uuid}`);
          invalidateCache(`playlist-page:${uuid}`);
          invalidateCache("user-playlists");
          // Refresh to re-sync exact count + cover art with the server
          setTimeout(refreshSidebarPlaylists, 3000);
        },
      ),
    );

    unlisteners.push(
      listen<{ kind: string; id: number; action: string }>(
        "mcp:favorite-changed",
        (e) => {
          const { kind, id, action } = e.payload;
          const userId = store.get(authTokensAtom)?.user_id;
          if (kind === "track") {
            if (action === "add") {
              store.set(favoriteTrackIdsAtom, (prev) => new Set([...prev, id]));
            } else {
              store.set(favoriteTrackIdsAtom, (prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
              });
              if (userId) removeTrackFromFavoritesCache(userId, id);
            }
          } else if (kind === "album") {
            if (action === "add") {
              store.set(favoriteAlbumIdsAtom, (prev) => new Set([...prev, id]));
              getAlbumDetail(id)
                .then((album) => {
                  if (userId) addAlbumToFavoritesCache(userId, album);
                  store.set(optimisticFavoriteAlbumsAtom, (prev) => [
                    album,
                    ...prev.filter((a) => a.id !== id),
                  ]);
                })
                .catch(() => {});
            } else {
              store.set(favoriteAlbumIdsAtom, (prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
              });
              store.set(optimisticFavoriteAlbumsAtom, (prev) =>
                prev.filter((a) => a.id !== id),
              );
              if (userId) removeAlbumFromFavoritesCache(userId, id);
            }
          } else if (kind === "artist") {
            if (action === "add") {
              store.set(
                followedArtistIdsAtom,
                (prev) => new Set([...prev, id]),
              );
              getArtistDetail(id)
                .then((artist) => {
                  if (userId) addArtistToFollowedCache(userId, artist);
                  store.set(optimisticFollowedArtistsAtom, (prev) => [
                    artist,
                    ...prev.filter((a) => a.id !== id),
                  ]);
                })
                .catch(() => {});
            } else {
              store.set(followedArtistIdsAtom, (prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
              });
              store.set(optimisticFollowedArtistsAtom, (prev) =>
                prev.filter((a) => a.id !== id),
              );
              if (userId) removeArtistFromFollowedCache(userId, id);
            }
          }
        },
      ),
    );

    return () => {
      for (const p of unlisteners) {
        p.then((fn) => fn()).catch(() => {});
      }
    };
  }, []);
}
