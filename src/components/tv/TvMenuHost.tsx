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
  FolderInput,
  FolderOpen,
  Globe,
  Heart,
  ListEnd,
  ListPlus,
  ListStart,
  Loader2,
  Lock,
  Play,
  Radio,
  User,
  Pencil,
  Plus,
  Trash2,
  Users,
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
  favoriteVideoIdsAtom,
  followedArtistIdsAtom,
} from "../../atoms/favorites";
import {
  allFoldersAtom,
  allFoldersFetchedAtom,
  allPlaylistsAtom,
} from "../../atoms/playlists";
import { useToast } from "../../contexts/ToastContext";
import { useFavorites } from "../../hooks/useFavorites";
import { getRecentFolderIds, useFolders } from "../../hooks/useFolders";
import { usePlaybackActions } from "../../hooks/usePlaybackActions";
import { usePlaylists } from "../../hooks/usePlaylists";
import { focusElement, focusFirstIn } from "../../lib/spatialNav";
import type { Folder, MediaItemType, Playlist, Track } from "../../types";
import { getTidalImageUrl } from "../../types";
import { getTrackArtistDisplay, trackCoverId } from "../../utils/itemHelpers";
import { fetchAllFolders, recordFolderCreated } from "./tvFolders";
import { actionForMedia, type TvView } from "./tvItems";
import { confirmMenu, type TvMenuItem, type TvMenuSpec } from "./tvMenu";
import { playlistSettled, queuePlaylistEdit } from "./tvPlaylistEdits";
import type { TvPromptRequest } from "./TvPrompt";
import { TvQrCode } from "./TvQrCode";
import { useTvPlayback } from "./useTvPlayback";

export interface TvMenuHostHandle {
  open: (spec: TvMenuSpec) => void;
  isOpen: () => boolean;
  /** Back inside the menu: leaves a submenu, or closes the menu. */
  back: () => void;
  /** Closes the whole menu, submenus included. */
  close: () => void;
  trackMenu: (track: Track, extra?: TvMenuItem[]) => TvMenuSpec;
  mediaMenu: (
    item: MediaItemType,
    onItsPage?: boolean,
    context?: { folderId?: string; creatorId?: number },
  ) => TvMenuSpec;
}

/** A playlist's visibility, to send back unchanged with an edit. */
const accessOf = (p: Playlist) =>
  p.accessType ?? (p.sharingLevel === "PUBLIC" ? "PUBLIC" : "UNLISTED");

const PLAYLISTS_PAGE = 500;
/** The slide-out in tv.css (`tv-menu-out`). */
const MENU_SLIDE_MS = 180;

/** All the user's playlists, page by page as AddToPlaylistMenu loads them. */
async function fetchAllPlaylists(userId: number): Promise<Playlist[]> {
  const first = await getAllPlaylists(userId, 0, PLAYLISTS_PAGE);
  const rest = [];
  for (
    let offset = PLAYLISTS_PAGE;
    offset < (first.totalNumberOfItems ?? 0);
    offset += PLAYLISTS_PAGE
  ) {
    rest.push(getAllPlaylists(userId, offset, PLAYLISTS_PAGE));
  }
  const pages = await Promise.all(rest);
  return first.items.concat(...pages.map((p) => p.items));
}

/** Names in folder toasts, cut at 25 characters as the desktop does. */
const shortName = (text: string) =>
  text.length > 25 ? `${text.slice(0, 23)}…` : text;

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
  const { playMedia } = useTvPlayback(onPlayed);
  const fav = useFavorites();
  const { addTrackToPlaylist, createPlaylist, updatePlaylist, deletePlaylist } =
    usePlaylists();
  // Playlist writes wait behind the ones already going to that playlist
  // (an open page's removals) and mark its pages out of date.
  const addToPlaylist = useCallback(
    (uuid: string, trackId: number) =>
      queuePlaylistEdit(uuid, () => addTrackToPlaylist(uuid, trackId)),
    [addTrackToPlaylist],
  );
  const editPlaylist = useCallback(
    (uuid: string, title: string, description: string, access: string) =>
      queuePlaylistEdit(uuid, async () => {
        await updatePlaylist(uuid, title, description, access);
      }),
    [updatePlaylist],
  );
  const { createFolder, movePlaylistTo } = useFolders();
  const userId = useAtomValue(authTokensAtom)?.user_id;
  const setAllPlaylists = useSetAtom(allPlaylistsAtom);

  const [stack, setStack] = useState<TvMenuSpec[]>([]);
  const [loadingFor, setLoadingFor] = useState<TvMenuSpec | null>(null);
  const stackRef = useRef(stack);
  useLayoutEffect(() => {
    stackRef.current = stack;
  }, [stack]);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  // A closed menu stays drawn while it slides out, inert and no longer a
  // layer (keys and focus are the screen's again at once).
  const [leaving, setLeaving] = useState<TvMenuSpec | null>(null);
  const lastSpec = useRef<TvMenuSpec | null>(null);
  useLayoutEffect(() => {
    const top = stack[stack.length - 1];
    if (top) {
      lastSpec.current = top;
      setLeaving(null);
      return;
    }
    if (!lastSpec.current) return;
    setLeaving(lastSpec.current);
    lastSpec.current = null;
    const timer = window.setTimeout(() => setLeaving(null), MENU_SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [stack]);

  // Per menu on the stack, the index of its entry that opened the next one.
  const openers = useRef<number[]>([]);
  const shownDepth = useRef(0);

  const close = useCallback(() => setStack([]), []);
  const openMenu = useCallback((spec: TvMenuSpec) => {
    if (stackRef.current.length === 0) {
      const active = document.activeElement;
      returnFocus.current = active instanceof HTMLElement ? active : null;
    }
    openers.current = [];
    setStack([spec]);
  }, []);

  // Focus the first entry whenever a (sub)menu opens, and the entry that
  // opened a submenu when Back leaves it; give focus back to where it was
  // when the menu closes.
  useLayoutEffect(() => {
    const left = stack.length < shownDepth.current;
    shownDepth.current = stack.length;
    if (stack.length > 0) {
      const panel = panelRef.current;
      if (!panel) return;
      const at = left ? openers.current[stack.length - 1] : undefined;
      const entry =
        at === undefined
          ? undefined
          : panel.querySelectorAll<HTMLElement>("[role='menuitem']")[at];
      if (entry) focusElement(entry);
      else focusFirstIn(panel);
    } else if (returnFocus.current) {
      const el = returnFocus.current;
      returnFocus.current = null;
      if (el.isConnected) focusElement(el);
    }
  }, [stack]);

  const label = (text: string) =>
    text.length > 32 ? `${text.slice(0, 30)}…` : text;

  const folderMenu = useCallback(
    async (
      item: Extract<MediaItemType, { type: "playlist" }>,
      sourceFolderId?: string,
    ): Promise<TvMenuSpec> => {
      let folders = store.get(allFoldersAtom);
      if (!store.get(allFoldersFetchedAtom)) {
        folders = await fetchAllFolders();
        store.set(allFoldersAtom, folders);
        store.set(allFoldersFetchedAtom, true);
      }
      const recent = getRecentFolderIds()
        .map((id) => folders.find((f) => f.id === id))
        .filter((f): f is Folder => !!f);
      const rest = folders.filter((f) => !recent.includes(f));
      const playlistLabel = shortName(item.title);
      const moveTo = (targetFolderId: string, done: string) => async () => {
        try {
          await movePlaylistTo({
            playlistUuid: item.uuid,
            targetFolderId,
            sourceFolderId,
            playlistSnapshot: {
              title: item.title,
              image: item.image,
              creatorName: item.creatorName,
            },
          });
          showToast(done);
        } catch (err) {
          console.error("[TvMenuHost] failed to move playlist:", err);
          showToast("Failed to move playlist", "error");
        }
      };
      const items: TvMenuItem[] = [];
      if (sourceFolderId && sourceFolderId !== "root") {
        items.push({
          label: "Playlists (top level)",
          icon: FolderInput,
          onSelect: moveTo("root", `Moved "${playlistLabel}" to Playlists`),
        });
      }
      for (const folder of [...recent, ...rest]) {
        items.push({
          label: folder.name,
          icon: FolderOpen,
          onSelect: moveTo(
            folder.id,
            `Moved "${playlistLabel}" to "${shortName(folder.name)}"`,
          ),
        });
      }
      items.push({
        label: "New folder…",
        icon: Plus,
        onSelect: async () => {
          const name = await onPrompt({
            title: "New folder",
            confirm: "Create and move",
          });
          if (!name) return;
          try {
            const result = await createFolder(
              name,
              "root",
              `trn:playlist:${item.uuid}`,
            );
            recordFolderCreated(store, {
              folderId: result?.id ?? `optimistic-${Date.now()}`,
              name,
              playlistUuid: item.uuid,
              sourceFolderId,
            });
            showToast(`Moved "${playlistLabel}" to "${shortName(name)}"`);
          } catch (err) {
            console.error("[TvMenuHost] failed to create folder:", err);
            showToast("Failed to create folder", "error");
          }
        },
      });
      return { title: "Move to folder", subtitle: item.title, items };
    },
    [store, movePlaylistTo, createFolder, onPrompt, showToast],
  );

  // The user's playlists, for "Add to playlist" and for which playlists are
  // their own (Edit details, Delete). Loaded once; a failed load is tried
  // again the next time a menu needs them. Resolves whether they loaded.
  const playlistsLoad = useRef<{
    done: boolean;
    running: Promise<boolean> | null;
  }>({ done: false, running: null });
  const loadPlaylists = useCallback((): Promise<boolean> => {
    const s = playlistsLoad.current;
    if (s.done) return Promise.resolve(true);
    if (userId == null) return Promise.resolve(false);
    if (!s.running) {
      s.running = fetchAllPlaylists(userId)
        .then(
          (all) => {
            setAllPlaylists(all);
            s.done = true;
            return true;
          },
          () => false,
        )
        .finally(() => {
          s.running = null;
        });
    }
    return s.running;
  }, [userId, setAllPlaylists]);

  const playlistMenu = useCallback(
    async (track: Track): Promise<TvMenuSpec> => {
      const loaded = await loadPlaylists();
      const playlists = store.get(allPlaylistsAtom);
      if (!loaded && playlists.length === 0) {
        throw new Error("Couldn't load your playlists");
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
            confirm: "Next",
          });
          if (!title) return;
          const create = async (accessType: string) => {
            let created: Playlist;
            try {
              created = await createPlaylist(title, "", accessType);
            } catch {
              showToast("Couldn't create the playlist", "error");
              return;
            }
            setAllPlaylists((prev) => [created, ...prev]);
            try {
              await addToPlaylist(created.uuid, track.id);
              showToast(`Added to new playlist "${label(title)}"`);
            } catch {
              showToast(
                `Created "${label(title)}" but couldn't add the track`,
                "error",
              );
            }
          };
          // Back here cancels: nothing is created.
          openMenu({
            title: "New playlist",
            subtitle: label(title),
            items: [
              {
                label: "Private playlist",
                icon: Lock,
                onSelect: () => create("UNLISTED"),
              },
              {
                label: "Public playlist",
                icon: Globe,
                onSelect: () => create("PUBLIC"),
              },
            ],
          });
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
                    await addToPlaylist(p.uuid, track.id);
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
      loadPlaylists,
      setAllPlaylists,
      addToPlaylist,
      createPlaylist,
      onPrompt,
      openMenu,
      showToast,
    ],
  );

  const trackMenu = useCallback(
    (track: Track, extra: TvMenuItem[] = []): TvMenuSpec => {
      const isVideo = track.itemType === "video";
      const liked = store
        .get(isVideo ? favoriteVideoIdsAtom : favoriteTrackIdsAtom)
        .has(track.id);
      const source = track.album
        ? {
            type: "album" as const,
            id: track.album.id,
            name: track.album.title,
            image: track.album.cover,
          }
        : undefined;
      const artists = (
        track.artists?.length ? track.artists : [track.artist]
      ).filter(
        (a, i, all): a is NonNullable<Track["artist"]> =>
          !!a && all.findIndex((b) => b?.id === a.id) === i,
      );
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
      if (isVideo) {
        items.push({
          label: liked ? "Remove from collection" : "Add to collection",
          icon: Heart,
          checked: liked,
          onSelect: async () => {
            try {
              if (liked) await fav.removeFavoriteVideo(track.id);
              else await fav.addFavoriteVideo(track.id);
            } catch {
              showToast("Couldn't update your collection", "error");
            }
          },
        });
      } else {
        items.push(
          {
            label: "Add to playlist",
            icon: ListPlus,
            submenu: () => playlistMenu(track),
          },
          {
            label: liked ? "Remove from Loved Tracks" : "Add to Loved Tracks",
            icon: Heart,
            checked: liked,
            onSelect: async () => {
              try {
                if (liked) await fav.removeFavoriteTrack(track.id);
                else await fav.addFavoriteTrack(track.id, track);
              } catch {
                showToast("Couldn't update Loved Tracks", "error");
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
              const artist = track.artists?.[0] ?? track.artist;
              onNavigate({
                type: "mix",
                mixId,
                title: `${track.title} Radio`,
                mixType: "TRACK_MIX",
                artist: artist
                  ? { id: artist.id, name: artist.name }
                  : undefined,
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
              wide: true,
              // One line per role, e.g. "Producer: A, B"; for reading only.
              items:
                credits.length > 0
                  ? credits.map((c) => ({
                      label: `${c.creditType}: ${c.contributors
                        .map((p) => p.name)
                        .join(", ")}`,
                      multiline: true,
                    }))
                  : [
                      {
                        label: "No credits available for this track",
                        multiline: true,
                      },
                    ],
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
        const goTo = (a: { id: number; name: string }) => () =>
          onNavigate({ type: "artist", id: a.id, name: a.name });
        if (artists.length === 1) {
          items.push({
            label: "Go to artist",
            icon: User,
            onSelect: goTo(artists[0]),
          });
        } else if (artists.length > 1) {
          items.push({
            label: "Go to artist",
            icon: User,
            submenu: () => ({
              title: "Go to artist",
              subtitle: track.title,
              items: artists.map((a) => ({
                label: a.name,
                icon: User,
                onSelect: goTo(a),
              })),
            }),
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
    (
      item: MediaItemType,
      onItsPage = false,
      context?: { folderId?: string; creatorId?: number },
    ): TvMenuSpec => {
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
          onSelect: () => void playMedia(item),
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

      if (item.type === "playlist") {
        items.push({
          label: "Move to folder",
          icon: FolderInput,
          submenu: () => folderMenu(item, context?.folderId),
        });
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
          case "video": {
            const on = store.get(favoriteVideoIdsAtom).has(item.id);
            return {
              on,
              label: on ? "Remove from collection" : "Add to collection",
              run: () =>
                on
                  ? fav.removeFavoriteVideo(item.id)
                  : fav.addFavoriteVideo(item.id),
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
        }
      })();
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
      // The user's own playlists can be edited and deleted (same ownership
      // rule as the desktop: they are its creator), as listed in their
      // playlists or, on its page, as its details say.
      const listed =
        item.type === "playlist"
          ? store.get(allPlaylistsAtom).find((p) => p.uuid === item.uuid)
          : undefined;
      if (item.type === "playlist") void loadPlaylists();
      const own =
        userId != null &&
        (listed?.creator?.id === userId || context?.creatorId === userId);
      if (item.type === "playlist" && own) {
        // Its name as last edited, which a card built earlier may not show.
        const current = listed?.title || item.title;
        items.push(
          {
            label: "Edit details",
            icon: Pencil,
            submenu: () => ({
              title: "Edit details",
              subtitle: label(current),
              items: [
                {
                  label: "Name…",
                  onSelect: async () => {
                    const title = await onPrompt({
                      title: "Name",
                      initial: current,
                      confirm: "Save",
                    });
                    if (!title || title === current) return;
                    try {
                      // Keep its description and visibility as they are.
                      const details = await getPlaylistDetails(item.uuid);
                      await editPlaylist(
                        item.uuid,
                        title,
                        details.description ?? "",
                        accessOf(details),
                      );
                      setAllPlaylists((prev) =>
                        prev.map((p) =>
                          p.uuid === item.uuid ? { ...p, title } : p,
                        ),
                      );
                      showToast(`Renamed to "${label(title)}"`);
                    } catch {
                      showToast("Couldn't rename the playlist", "error");
                    }
                  },
                },
                {
                  label: "Description…",
                  onSelect: async () => {
                    let details: Playlist;
                    try {
                      details = await getPlaylistDetails(item.uuid);
                    } catch {
                      showToast("Couldn't load the playlist", "error");
                      return;
                    }
                    const before = details.description ?? "";
                    // Multi-line and untrimmed, so its line breaks and an
                    // untouched text come back exactly as they were.
                    const description = await onPrompt({
                      title: "Description",
                      initial: before,
                      confirm: "Save",
                      placeholder: "Description",
                      allowEmpty: true,
                      trim: false,
                      multiline: true,
                    });
                    if (description === null || description === before) {
                      return;
                    }
                    try {
                      // Keep its name and visibility as they are.
                      await editPlaylist(
                        item.uuid,
                        details.title || current,
                        description,
                        accessOf(details),
                      );
                      setAllPlaylists((prev) =>
                        prev.map((p) =>
                          p.uuid === item.uuid ? { ...p, description } : p,
                        ),
                      );
                      showToast("Description saved");
                    } catch {
                      showToast("Couldn't save the description", "error");
                    }
                  },
                },
              ],
            }),
          },
          {
            label: "Delete playlist",
            icon: Trash2,
            submenu: () =>
              confirmMenu({
                title: `Delete "${label(name)}"?`,
                subtitle: "This can't be undone.",
                confirmLabel: "Delete",
                icon: Trash2,
                onConfirm: async () => {
                  try {
                    // Its queued removals and adds would fail once it is gone.
                    await playlistSettled(item.uuid);
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
      folderMenu,
      showToast,
      onNavigate,
      userId,
      onPrompt,
      loadPlaylists,
      editPlaylist,
      deletePlaylist,
      setAllPlaylists,
      onPlaylistDeleted,
    ],
  );

  // Owning a playlist is looked up in the user's playlists; load them once
  // so Edit details / Delete show up without visiting "Add to playlist" first.
  useEffect(() => {
    if (userId == null) return;
    if (store.get(allPlaylistsAtom).length > 0) {
      playlistsLoad.current.done = true;
      return;
    }
    void loadPlaylists();
  }, [userId, store, loadPlaylists]);

  useImperativeHandle(
    ref,
    () => ({
      open: openMenu,
      isOpen: () => stackRef.current.length > 0,
      back: () => setStack((s) => s.slice(0, -1)),
      close,
      trackMenu,
      mediaMenu,
    }),
    [openMenu, close, trackMenu, mediaMenu],
  );

  const select = async (item: TvMenuItem, index: number) => {
    const from = stackRef.current[stackRef.current.length - 1];
    if (loadingFor === from) return;
    if (item.submenu) {
      setLoadingFor(from);
      try {
        const next = await item.submenu();
        // Dropped if its menu was closed or replaced meanwhile.
        if (stackRef.current[stackRef.current.length - 1] !== from) return;
        openers.current[stackRef.current.length - 1] = index;
        setStack((s) => [...s, next]);
      } catch {
        showToast("Couldn't load", "error");
      } finally {
        setLoadingFor((cur) => (cur === from ? null : cur));
      }
      return;
    }
    if (!item.onSelect) return;
    // Run with focus back on the opener, so a screen the action opens
    // remembers it for Back.
    const el = returnFocus.current;
    returnFocus.current = null;
    if (el?.isConnected) focusElement(el);
    close();
    await item.onSelect();
  };

  const spec = stack[stack.length - 1] ?? leaving;
  if (!spec) return null;
  const closing = stack.length === 0;

  return (
    <div
      className={`fixed inset-0 z-[10000] tv-overlay flex justify-end ${
        closing ? "pointer-events-none" : ""
      }`}
    >
      {!closing && (
        <div className="absolute inset-0 bg-black/55" onClick={close} />
      )}
      <div
        ref={panelRef}
        data-tv-modal={closing ? undefined : true}
        data-closing={closing || undefined}
        inert={closing}
        role={closing ? undefined : "menu"}
        aria-label={spec.title}
        className={`tv-menu-panel tv-screen relative h-full ${
          spec.wide ? "w-[40rem]" : "w-[28rem]"
        } max-w-full overflow-y-auto bg-th-elevated shadow-2xl px-[1.5rem] py-[2rem]`}
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
              <div className="text-[0.75rem] text-th-text-muted truncate">
                {spec.subtitle}
              </div>
            )}
          </div>
        </div>
        {spec.qr && (
          <div className="flex justify-center mb-[1.4rem]">
            <TvQrCode
              value={spec.qr}
              label="Link code"
              className="w-[14rem] h-[14rem]"
            />
          </div>
        )}
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
                onClick={() => void select(item, i)}
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
                {item.avatar !== undefined && (
                  <MenuAvatar avatar={item.avatar} alt={item.label} />
                )}
                <span
                  className={`flex-1 min-w-0 ${
                    item.multiline
                      ? "whitespace-normal break-words"
                      : "truncate"
                  }`}
                >
                  {item.label}
                </span>
                {item.submenu &&
                  (loadingFor === spec ? (
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

/** A row's round avatar; a loader's picture appears once it resolves. */
function MenuAvatar({
  avatar,
  alt,
}: {
  avatar: NonNullable<TvMenuItem["avatar"]>;
  alt: string;
}) {
  const [loaded, setLoaded] = useState<string | undefined>();
  useEffect(() => {
    if (typeof avatar === "string") return;
    let live = true;
    avatar()
      .then((src) => live && setLoaded(src))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [avatar]);
  const src = typeof avatar === "string" ? avatar : loaded;
  return (
    <TidalImage
      src={src || undefined}
      alt={alt}
      type="artist"
      className="w-[2.2rem] h-[2.2rem] shrink-0 rounded-full overflow-hidden"
    />
  );
}

export default TvMenuHost;
