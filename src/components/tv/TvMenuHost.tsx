import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import {
  Album,
  Check,
  ChevronRight,
  Heart,
  ListEnd,
  ListPlus,
  ListStart,
  Loader2,
  Play,
  Radio,
  User,
  Pencil,
  Plus,
  Trash2,
  Users,
  X,
} from "lucide-react";
import TidalImage from "../TidalImage";
import {
  fetchMediaTracks,
  getAllPlaylists,
  getPlaylistDetails,
  getTrack,
  getTrackCredits,
} from "../../api/tidal";
import { authTokensAtom } from "../../atoms/auth";
import {
  favoriteAlbumIdsAtom,
  favoriteMixIdsAtom,
  favoritePlaylistUuidsAtom,
  favoriteTrackIdsAtom,
  followedArtistIdsAtom,
} from "../../atoms/favorites";
import { allPlaylistsAtom } from "../../atoms/playlists";
import { useToast } from "../../contexts/ToastContext";
import { useFavorites } from "../../hooks/useFavorites";
import { useMediaPlay } from "../../hooks/useMediaPlay";
import { usePlaybackActions } from "../../hooks/usePlaybackActions";
import { usePlaylists } from "../../hooks/usePlaylists";
import { focusElement, focusFirstIn } from "../../lib/spatialNav";
import type { MediaItemType, Playlist, Track } from "../../types";
import { getTidalImageUrl } from "../../types";
import { getTrackArtistDisplay, trackCoverId } from "../../utils/itemHelpers";
import { actionForMedia, type TvView } from "./tvItems";
import type { TvMenuItem, TvMenuSpec } from "./tvMenu";
import type { TvPromptRequest } from "./TvPrompt";

export interface TvMenuHostHandle {
  open: (spec: TvMenuSpec) => void;
  isOpen: () => boolean;
  /** Back inside the menu: leaves a submenu, or closes the menu. */
  back: () => void;
  trackMenu: (track: Track, extra?: TvMenuItem[]) => TvMenuSpec;
  mediaMenu: (item: MediaItemType, onItsPage?: boolean) => TvMenuSpec;
}

/**
 * Owns the action menu (the TV stand-in for the desktop right-click menu):
 * its builders for tracks and media cards, and the panel itself. Kept in its
 * own component so favorite changes re-render only this, not every screen.
 */
const TvMenuHost = forwardRef<
  TvMenuHostHandle,
  {
    onNavigate: (view: TvView) => void;
    onPlayed: () => void;
    /** Ask for a name with the on-screen keyboard (null: cancelled). */
    onPrompt: (request: TvPromptRequest) => Promise<string | null>;
    /** A playlist was deleted (close its page if it is open). */
    onPlaylistDeleted: (uuid: string) => void;
  }
>(function TvMenuHost(
  { onNavigate, onPlayed, onPrompt, onPlaylistDeleted },
  ref,
) {
  const store = useStore();
  const { showToast } = useToast();
  const { addToQueue, playNextInQueue } = usePlaybackActions();
  const playMedia = useMediaPlay();
  const fav = useFavorites();
  const { addTrackToPlaylist, createPlaylist, updatePlaylist, deletePlaylist } =
    usePlaylists();
  const userId = useAtomValue(authTokensAtom)?.user_id;
  const setAllPlaylists = useSetAtom(allPlaylistsAtom);

  const [stack, setStack] = useState<TvMenuSpec[]>([]);
  const [loading, setLoading] = useState(false);
  const stackRef = useRef(stack);
  useLayoutEffect(() => {
    stackRef.current = stack;
  }, [stack]);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const close = useCallback(() => setStack([]), []);

  // Focus the first entry whenever a (sub)menu opens; give focus back to
  // where it was when the menu closes.
  useLayoutEffect(() => {
    if (stack.length > 0) {
      if (panelRef.current) focusFirstIn(panelRef.current);
    } else if (returnFocus.current) {
      const el = returnFocus.current;
      returnFocus.current = null;
      if (el.isConnected) focusElement(el);
    }
  }, [stack]);

  const label = (text: string) =>
    text.length > 32 ? `${text.slice(0, 30)}…` : text;

  const playlistMenu = useCallback(
    async (track: Track): Promise<TvMenuSpec> => {
      let playlists: Playlist[] = store.get(allPlaylistsAtom);
      if (playlists.length === 0 && userId) {
        playlists = (await getAllPlaylists(userId, 0, 500)).items;
        setAllPlaylists(playlists);
      }
      // Only playlists the user can edit.
      const own = playlists.filter(
        (p) => p.creator?.id == null || p.creator.id === userId,
      );
      const newPlaylist: TvMenuItem = {
        label: "New playlist…",
        icon: Plus,
        onSelect: async () => {
          const title = await onPrompt({
            title: "New playlist",
            confirm: "Create and add",
          });
          if (!title) return;
          try {
            const created = await createPlaylist(title);
            setAllPlaylists((prev) => [created, ...prev]);
            await addTrackToPlaylist(created.uuid, track.id);
            showToast(`Added to new playlist "${label(title)}"`);
          } catch {
            showToast("Couldn't create the playlist", "error");
          }
        },
      };
      return {
        title: "Add to playlist",
        subtitle: track.title,
        items: [
          newPlaylist,
          ...(own.length > 0
            ? own.map((p) => ({
                label: p.title,
                icon: ListPlus,
                onSelect: async () => {
                  try {
                    await addTrackToPlaylist(p.uuid, track.id);
                    showToast(`Added to "${label(p.title)}"`);
                  } catch {
                    showToast("Couldn't add to playlist", "error");
                  }
                },
              }))
            : [{ label: "You have no playlists yet" }]),
        ],
      };
    },
    [
      store,
      userId,
      setAllPlaylists,
      addTrackToPlaylist,
      createPlaylist,
      onPrompt,
      showToast,
    ],
  );

  const trackMenu = useCallback(
    (track: Track, extra: TvMenuItem[] = []): TvMenuSpec => {
      const isVideo = track.itemType === "video";
      const liked = isVideo
        ? false
        : store.get(favoriteTrackIdsAtom).has(track.id);
      const source = track.album
        ? {
            type: "album" as const,
            id: track.album.id,
            name: track.album.title,
            image: track.album.cover,
          }
        : undefined;
      const artist = track.artist ?? track.artists?.[0];
      const items: TvMenuItem[] = [
        {
          label: "Play next",
          icon: ListStart,
          onSelect: () => {
            playNextInQueue(track, source);
            showToast(`"${label(track.title)}" will play next`);
          },
        },
        {
          label: "Add to queue",
          icon: ListEnd,
          onSelect: () => {
            addToQueue(track, source);
            showToast(`Added "${label(track.title)}" to queue`);
          },
        },
      ];
      if (!isVideo) {
        items.push(
          {
            label: "Add to playlist",
            icon: ListPlus,
            submenu: () => playlistMenu(track),
          },
          {
            label: liked ? "Remove from My Tracks" : "Add to My Tracks",
            icon: Heart,
            checked: liked,
            onSelect: async () => {
              try {
                if (liked) await fav.removeFavoriteTrack(track.id);
                else await fav.addFavoriteTrack(track.id, track);
              } catch {
                showToast("Couldn't update My Tracks", "error");
              }
            },
          },
          {
            label: "Track radio",
            icon: Radio,
            onSelect: async () => {
              let mixId = track.mixes?.TRACK_MIX;
              if (!mixId) {
                mixId = await getTrack(track.id)
                  .then((d) => d.mixes?.TRACK_MIX)
                  .catch(() => undefined);
              }
              if (!mixId) {
                showToast("Track radio unavailable", "info");
                return;
              }
              onNavigate({
                type: "mix",
                mixId,
                title: `${track.title} Radio`,
              });
            },
          },
        );
        items.push({
          label: "Credits",
          icon: Users,
          submenu: async () => {
            const credits = await getTrackCredits(track.id);
            return {
              title: "Credits",
              subtitle: track.title,
              // One line per role, e.g. "Producer: A, B"; for reading only.
              items:
                credits.length > 0
                  ? credits.map((c) => ({
                      label: `${c.creditType}: ${c.contributors
                        .map((p) => p.name)
                        .join(", ")}`,
                    }))
                  : [{ label: "No credits available for this track" }],
            };
          },
        });
        if (track.album?.id) {
          items.push({
            label: "Go to album",
            icon: Album,
            onSelect: () =>
              onNavigate({
                type: "album",
                id: track.album!.id,
                title: track.album!.title,
              }),
          });
        }
        if (artist) {
          items.push({
            label: "Go to artist",
            icon: User,
            onSelect: () =>
              onNavigate({ type: "artist", id: artist.id, name: artist.name }),
          });
        }
      }
      return {
        title: track.title,
        subtitle: getTrackArtistDisplay(track),
        image: getTidalImageUrl(trackCoverId(track), 320),
        // Actions that depend on where the track is listed (remove it from
        // the queue or from this playlist) come last, away from the entry
        // that has focus when the menu opens.
        items: [...items, ...extra],
      };
    },
    [
      store,
      fav,
      addToQueue,
      playNextInQueue,
      playlistMenu,
      showToast,
      onNavigate,
    ],
  );

  const mediaMenu = useCallback(
    (item: MediaItemType, onItsPage = false): TvMenuSpec => {
      const name = item.type === "artist" ? item.name : item.title;
      const open = actionForMedia(item);
      const withTracks = async (fn: (tracks: Track[]) => void, msg: string) => {
        try {
          const tracks = await fetchMediaTracks(item);
          if (tracks.length === 0) return;
          fn(tracks);
          showToast(msg);
        } catch {
          showToast("Couldn't load the tracks", "error");
        }
      };
      const items: TvMenuItem[] = [
        {
          label: "Play",
          icon: Play,
          onSelect: () => {
            void playMedia(item);
            if (item.type !== "video") onPlayed();
          },
        },
      ];
      if (item.type !== "video") {
        items.push(
          {
            label: "Play next",
            icon: ListStart,
            onSelect: () =>
              withTracks(
                (tracks) => {
                  // Front of the queue in reverse, so the first plays first.
                  for (let i = tracks.length - 1; i >= 0; i--) {
                    playNextInQueue(tracks[i]);
                  }
                },
                `"${label(name)}" will play next`,
              ),
          },
          {
            label: "Add to queue",
            icon: ListEnd,
            onSelect: () =>
              withTracks(
                (tracks) => tracks.forEach((t) => addToQueue(t)),
                `Added "${label(name)}" to queue`,
              ),
          },
        );
      }

      const toggle = (() => {
        switch (item.type) {
          case "album": {
            const on = store.get(favoriteAlbumIdsAtom).has(item.id);
            return {
              on,
              label: on ? "Remove from collection" : "Add to collection",
              run: () =>
                on
                  ? fav.removeFavoriteAlbum(item.id)
                  : fav.addFavoriteAlbum(item.id, {
                      id: item.id,
                      title: item.title,
                      cover: item.cover,
                      artist: item.artistName
                        ? { id: 0, name: item.artistName }
                        : undefined,
                    }),
            };
          }
          case "playlist": {
            const on = store.get(favoritePlaylistUuidsAtom).has(item.uuid);
            return {
              on,
              label: on ? "Remove from collection" : "Add to collection",
              run: () =>
                on
                  ? fav.removeFavoritePlaylist(item.uuid)
                  : fav.addFavoritePlaylist(item.uuid, {
                      uuid: item.uuid,
                      title: item.title,
                      squareImage: item.image,
                    }),
            };
          }
          case "mix": {
            const on = store.get(favoriteMixIdsAtom).has(item.mixId);
            return {
              on,
              label: on ? "Remove from collection" : "Add to collection",
              run: () =>
                on
                  ? fav.removeFavoriteMix(item.mixId)
                  : fav.addFavoriteMix(item.mixId, {
                      id: item.mixId,
                      title: item.title,
                      subTitle: item.subtitle || "",
                      images: item.image
                        ? {
                            SMALL: { url: item.image },
                            MEDIUM: { url: item.image },
                          }
                        : undefined,
                    }),
            };
          }
          case "artist": {
            const on = store.get(followedArtistIdsAtom).has(item.id);
            return {
              on,
              label: on ? "Unfollow" : "Follow",
              run: () =>
                on ? fav.unfollowArtist(item.id) : fav.followArtist(item.id),
            };
          }
          default:
            return null;
        }
      })();
      if (toggle) {
        items.push({
          label: toggle.label,
          icon: Heart,
          checked: toggle.on,
          onSelect: async () => {
            try {
              await toggle.run();
            } catch {
              showToast("Couldn't update your collection", "error");
            }
          },
        });
      }
      // The user's own playlists can be renamed and deleted (same ownership
      // rule as the desktop: they are its creator).
      if (
        item.type === "playlist" &&
        userId != null &&
        store
          .get(allPlaylistsAtom)
          .some((p) => p.uuid === item.uuid && p.creator?.id === userId)
      ) {
        items.push(
          {
            label: "Rename playlist",
            icon: Pencil,
            onSelect: async () => {
              const title = await onPrompt({
                title: "Rename playlist",
                initial: item.title,
                confirm: "Rename",
              });
              if (!title || title === item.title) return;
              try {
                // Keep its description and visibility as they are.
                const details = await getPlaylistDetails(item.uuid);
                await updatePlaylist(
                  item.uuid,
                  title,
                  details.description ?? "",
                  details.accessType ??
                    (details.sharingLevel === "PUBLIC" ? "PUBLIC" : "UNLISTED"),
                );
                setAllPlaylists((prev) =>
                  prev.map((p) => (p.uuid === item.uuid ? { ...p, title } : p)),
                );
                showToast(`Renamed to "${label(title)}"`);
              } catch {
                showToast("Couldn't rename the playlist", "error");
              }
            },
          },
          {
            label: "Delete playlist",
            icon: Trash2,
            submenu: () => ({
              title: `Delete "${label(name)}"?`,
              subtitle: "This can't be undone.",
              items: [
                {
                  label: "Delete",
                  icon: Trash2,
                  onSelect: async () => {
                    try {
                      await deletePlaylist(item.uuid);
                      setAllPlaylists((prev) =>
                        prev.filter((p) => p.uuid !== item.uuid),
                      );
                      onPlaylistDeleted(item.uuid);
                      showToast(`Deleted "${label(name)}"`);
                    } catch {
                      showToast("Couldn't delete the playlist", "error");
                    }
                  },
                },
                { label: "Cancel", icon: X, onSelect: () => {} },
              ],
            }),
          },
        );
      }
      // On the item's own page there is nothing to open.
      if (open.kind === "open" && !onItsPage) {
        const what =
          item.type === "artist"
            ? "Go to artist"
            : item.type === "album"
              ? "Open album"
              : item.type === "playlist"
                ? "Open playlist"
                : "Open mix";
        items.push({
          label: what,
          icon: ChevronRight,
          onSelect: () => onNavigate(open.view),
        });
      }

      const image =
        item.type === "album"
          ? getTidalImageUrl(item.cover, 320)
          : item.type === "playlist"
            ? getTidalImageUrl(item.image, 320)
            : item.type === "mix"
              ? item.image
              : item.type === "artist"
                ? undefined
                : getTidalImageUrl(item.imageId, 320);
      return {
        title: name,
        subtitle:
          item.type === "album"
            ? item.artistName
            : item.type === "playlist"
              ? item.creatorName
              : item.type === "mix"
                ? item.subtitle
                : item.type === "video"
                  ? item.artist
                  : "Artist",
        image,
        round: item.type === "artist",
        items,
      };
    },
    [
      store,
      fav,
      addToQueue,
      playNextInQueue,
      playMedia,
      showToast,
      onNavigate,
      onPlayed,
      userId,
      onPrompt,
      updatePlaylist,
      deletePlaylist,
      setAllPlaylists,
      onPlaylistDeleted,
    ],
  );

  // Owning a playlist is looked up in the user's playlists; load them once
  // so Rename / Delete show up without visiting "Add to playlist" first.
  useEffect(() => {
    if (userId == null || store.get(allPlaylistsAtom).length > 0) return;
    getAllPlaylists(userId, 0, 500)
      .then((r) => setAllPlaylists(r.items))
      .catch(() => {});
  }, [userId, store, setAllPlaylists]);

  useImperativeHandle(
    ref,
    () => ({
      open: (spec) => {
        if (stackRef.current.length === 0) {
          const active = document.activeElement;
          returnFocus.current = active instanceof HTMLElement ? active : null;
        }
        setStack([spec]);
      },
      isOpen: () => stackRef.current.length > 0,
      back: () => setStack((s) => s.slice(0, -1)),
      trackMenu,
      mediaMenu,
    }),
    [trackMenu, mediaMenu],
  );

  const select = async (item: TvMenuItem) => {
    if (loading) return;
    if (item.submenu) {
      setLoading(true);
      try {
        const next = await item.submenu();
        setStack((s) => [...s, next]);
      } catch {
        showToast("Couldn't load", "error");
      } finally {
        setLoading(false);
      }
      return;
    }
    if (!item.onSelect) return;
    close();
    await item.onSelect();
  };

  const spec = stack[stack.length - 1];
  if (!spec) return null;

  return (
    <div className="fixed inset-0 z-[9000] flex justify-end">
      <div className="absolute inset-0 bg-black/55" onClick={close} />
      <div
        ref={panelRef}
        data-tv-modal
        role="menu"
        aria-label={spec.title}
        className="tv-screen relative h-full w-[28rem] max-w-full overflow-y-auto bg-th-elevated shadow-2xl px-[1.5rem] py-[2rem]"
      >
        <div className="flex items-center gap-[1rem] px-[0.5rem] mb-[1.4rem]">
          {spec.image !== undefined && (
            <TidalImage
              src={spec.image || undefined}
              alt=""
              type={spec.round ? "artist" : "album"}
              className={`w-[3.6rem] h-[3.6rem] shrink-0 overflow-hidden ${
                spec.round ? "rounded-full" : "rounded-[0.5rem]"
              }`}
            />
          )}
          <div className="min-w-0">
            <div className="text-[1rem] font-bold text-th-text-primary line-clamp-2">
              {spec.title}
            </div>
            {spec.subtitle && (
              <div className="text-[0.7rem] text-th-text-muted truncate">
                {spec.subtitle}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-[0.2rem]">
          {spec.items.map((item, i) => {
            const Icon = item.icon;
            const actionable = !!(item.onSelect || item.submenu);
            return (
              <button
                key={`${item.label}:${i}`}
                data-tv-focusable
                role="menuitem"
                aria-disabled={!actionable || undefined}
                onClick={() => void select(item)}
                className="tv-track flex items-center gap-[0.9rem] w-full px-[0.9rem] py-[0.7rem] rounded-[0.6rem] text-left text-[0.85rem] font-semibold text-th-text-primary aria-disabled:text-th-text-muted aria-disabled:font-normal"
              >
                {Icon && (
                  <Icon
                    className={`w-[1.1rem] h-[1.1rem] shrink-0 ${
                      item.checked ? "text-th-accent" : "text-th-text-secondary"
                    }`}
                    fill={
                      item.checked && Icon === Heart ? "currentColor" : "none"
                    }
                  />
                )}
                <span className="flex-1 min-w-0 truncate">{item.label}</span>
                {item.submenu &&
                  (loading ? (
                    <Loader2 className="w-[1rem] h-[1rem] animate-spin text-th-text-muted" />
                  ) : (
                    <ChevronRight className="w-[1rem] h-[1rem] text-th-text-muted" />
                  ))}
                {item.checked && Icon !== Heart && (
                  <Check className="w-[1rem] h-[1rem] text-th-accent" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
});

export default TvMenuHost;
