import { useEffect, useRef, useCallback } from "react";
import { useStore, useAtomValue } from "jotai";
import {
  currentTrackAtom,
  isPlayingAtom,
  shuffleAtom,
  repeatAtom,
  volumeAtom,
  playbackSourceAtom,
  contextSourceAtom,
  bitPerfectAtom,
} from "../atoms/playback";
import { favoriteTrackIdsAtom } from "../atoms/favorites";
import { miniplayerOpenAtom } from "../atoms/ui";
import { getInterpolatedPosition } from "../lib/playbackPosition";
import { usePlaybackActions } from "./usePlaybackActions";
import { useFavorites } from "./useFavorites";
import { useDrawer } from "./useDrawer";
import { useNavigation } from "./useNavigation";
import { useToast } from "../contexts/ToastContext";
import { getTrackShareUrl } from "../utils/itemHelpers";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

export interface MiniplayerState {
  track: {
    id: number;
    title: string;
    version?: string;
    artist: { id: number; name: string };
    artists?: { id: number; name: string }[];
    album: { id: number; cover?: string; vibrantColor?: string };
  } | null;
  isPlaying: boolean;
  position: number;
  duration: number;
  isFavorite: boolean;
  shuffle: boolean;
  repeat: number;
  volume: number;
  playbackSourceLabel: {
    type: string;
    id: string | number;
    name: string;
  } | null;
  bitPerfect: boolean;
  accentColor: string;
  error?: string;
}

export function useMiniplayerEmitter() {
  const miniplayerOpen = useAtomValue(miniplayerOpenAtom);
  const store = useStore();
  const pendingEmit = useRef(false);
  const lastErrorRef = useRef<string | undefined>(undefined);

  // Build the state payload from current atom values
  const buildState = useCallback((): MiniplayerState => {
    const track = store.get(currentTrackAtom);
    const isPlaying = store.get(isPlayingAtom);
    const shuffle = store.get(shuffleAtom);
    const repeat = store.get(repeatAtom);
    const volume = store.get(volumeAtom);
    const favoriteIds = store.get(favoriteTrackIdsAtom);
    const source =
      store.get(contextSourceAtom) || store.get(playbackSourceAtom);

    // Read accent from theme in localStorage
    let accentColor = "#A855F7"; // fallback
    try {
      const stored = localStorage.getItem("sone.theme.v1");
      if (stored) {
        const theme = JSON.parse(stored);
        if (theme.accent) accentColor = theme.accent;
      }
    } catch {}

    return {
      track: track
        ? {
            id: track.id,
            title: track.title,
            version: track.version,
            artist: track.artist
              ? { id: track.artist.id, name: track.artist.name }
              : { id: 0, name: "Unknown" },
            artists: track.artists?.map((a) => ({ id: a.id, name: a.name })),
            album: {
              id: track.album?.id ?? 0,
              cover: track.album?.cover,
              vibrantColor: track.album?.vibrantColor,
            },
          }
        : null,
      isPlaying,
      position: getInterpolatedPosition(),
      duration: track?.duration ?? 0,
      isFavorite: track ? favoriteIds.has(track.id) : false,
      shuffle,
      repeat,
      volume,
      playbackSourceLabel: source
        ? { type: source.type, id: source.id, name: source.name }
        : null,
      bitPerfect: store.get(bitPerfectAtom),
      accentColor,
      error: lastErrorRef.current,
    };
  }, [store]);

  // Batched emit -- coalesces multiple atom changes into one event per microtask
  const scheduleEmit = useCallback(() => {
    if (!pendingEmit.current) {
      pendingEmit.current = true;
      queueMicrotask(() => {
        pendingEmit.current = false;
        const state = buildState();
        emitTo("miniplayer", "miniplayer-state-update", state).catch(() => {});
      });
    }
  }, [buildState]);

  // Subscribe to atoms and emit state changes
  useEffect(() => {
    if (!miniplayerOpen) return;

    const atoms = [
      currentTrackAtom,
      isPlayingAtom,
      shuffleAtom,
      repeatAtom,
      volumeAtom,
      favoriteTrackIdsAtom,
      playbackSourceAtom,
      contextSourceAtom,
      bitPerfectAtom,
    ];

    const unsubs = atoms.map((a) => store.sub(a, scheduleEmit));

    // Listen for miniplayer-ready handshake
    const unlistenReady = listen("miniplayer-ready", () => {
      const state = buildState();
      emitTo("miniplayer", "miniplayer-state-update", state).catch(() => {});
    });

    // Listen for seek events and relay updated position to miniplayer
    const onSeeked = () => scheduleEmit();
    window.addEventListener("playback-seeked", onSeeked);

    // Listen for playback errors (DOM CustomEvent) and relay to miniplayer
    const onPlaybackError = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      lastErrorRef.current =
        typeof detail === "string"
          ? detail
          : detail?.message || "Playback error";
      scheduleEmit();
      // Auto-clear error after 5 seconds
      setTimeout(() => {
        lastErrorRef.current = undefined;
        scheduleEmit();
      }, 5000);
    };
    window.addEventListener("playback-error", onPlaybackError);

    // Periodic re-emit so the miniplayer self-heals from position drift that
    // fires no atom change: the async re-anchor right after resume, the 2s
    // sync-loop correction, or an optimistic toggle the backend never confirmed.
    // Position lives in a module singleton (not an atom), so without this the
    // miniplayer can stay stuck on a stale value until the next unrelated change.
    const heartbeat = setInterval(scheduleEmit, 1000);

    return () => {
      unsubs.forEach((fn) => fn());
      unlistenReady.then((fn) => fn());
      window.removeEventListener("playback-seeked", onSeeked);
      window.removeEventListener("playback-error", onPlaybackError);
      clearInterval(heartbeat);
    };
  }, [miniplayerOpen, store, scheduleEmit, buildState]);

  // Listen for miniplayer-command events and dispatch to existing hooks
  const {
    pauseTrack,
    resumeTrack,
    playNext,
    playPrevious,
    toggleShuffle,
    seekTo,
    setVolume,
  } = usePlaybackActions();
  const { addFavoriteTrack, removeFavoriteTrack } = useFavorites();
  const { openDrawerToTab } = useDrawer();
  const {
    navigateToArtist,
    navigateToArtistTracks,
    navigateToAlbum,
    navigateToPlaylist,
    navigateToMix,
    navigateToFavorites,
  } = useNavigation();
  const { showToast } = useToast();

  const focusMainWindow = useCallback(async () => {
    const appWindow = getCurrentWindow();
    await appWindow.show();
    await appWindow.unminimize();
    await appWindow.setFocus();
  }, []);

  useEffect(() => {
    if (!miniplayerOpen) return;

    const unlisten = listen<{ action: string; value?: number }>(
      "miniplayer-command",
      async (event) => {
        const { action, value } = event.payload;
        switch (action) {
          case "toggle-play": {
            const playing = store.get(isPlayingAtom);
            if (playing) await pauseTrack();
            else await resumeTrack();
            break;
          }
          case "play-next":
            await playNext({ explicit: true });
            break;
          case "play-previous":
            await playPrevious();
            break;
          case "toggle-favorite": {
            const track = store.get(currentTrackAtom);
            if (!track) break;
            const favIds = store.get(favoriteTrackIdsAtom);
            if (favIds.has(track.id)) {
              await removeFavoriteTrack(track.id);
            } else {
              await addFavoriteTrack(track.id, track);
            }
            break;
          }
          case "toggle-shuffle":
            toggleShuffle();
            break;
          case "cycle-repeat": {
            const current = store.get(repeatAtom);
            store.set(repeatAtom, (current + 1) % 3);
            break;
          }
          case "set-volume":
            if (value !== undefined) await setVolume(value);
            break;
          case "seek":
            if (value !== undefined) await seekTo(value);
            break;
          case "focus-main": {
            await focusMainWindow();
            break;
          }
          case "show-album": {
            const t = store.get(currentTrackAtom);
            await focusMainWindow();
            if (t?.album?.id) {
              navigateToAlbum(t.album.id, {
                title: t.album.title,
                cover: t.album.cover,
                artistName: t.artist?.name,
              });
            }
            break;
          }
          case "show-now-playing": {
            await focusMainWindow();
            openDrawerToTab("queue");
            break;
          }
          case "show-artist": {
            const t = store.get(currentTrackAtom);
            if (t?.artist) {
              await focusMainWindow();
              navigateToArtist(t.artist.id, { name: t.artist.name });
            }
            break;
          }
          case "show-source": {
            const src =
              store.get(contextSourceAtom) || store.get(playbackSourceAtom);
            if (!src) break;
            switch (src.type) {
              case "favorites":
                await focusMainWindow();
                navigateToFavorites();
                break;
              case "album":
                await focusMainWindow();
                navigateToAlbum(Number(src.id), { title: src.name });
                break;
              case "playlist":
                await focusMainWindow();
                navigateToPlaylist(String(src.id), { title: src.name });
                break;
              case "playlist-recs":
                await focusMainWindow();
                navigateToPlaylist(String(src.id));
                break;
              case "mix":
                await focusMainWindow();
                navigateToMix(String(src.id), {
                  title: src.name,
                  image: src.image,
                  subtitle: src.subtitle,
                  mixType: src.mixType,
                });
                break;
              case "artist":
                await focusMainWindow();
                navigateToArtist(Number(src.id));
                break;
              case "artist-tracks":
                await focusMainWindow();
                navigateToArtistTracks(Number(src.id), src.name);
                break;
              case "radio":
                await focusMainWindow();
                navigateToMix(String(src.id), {
                  title: src.name,
                  image: src.image,
                  mixType: "TRACK_MIX",
                });
                break;
              // Non-navigable sources (e.g. "playlist-recs"): no focus, no nav.
            }
            break;
          }
          case "share": {
            const shareTrack = store.get(currentTrackAtom);
            if (shareTrack) {
              try {
                await navigator.clipboard.writeText(
                  getTrackShareUrl(shareTrack.id),
                );
                showToast("Copied share link to clipboard");
              } catch {
                showToast("Failed to copy link", "error");
              }
            }
            break;
          }
        }
      },
    );

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [
    miniplayerOpen,
    store,
    pauseTrack,
    resumeTrack,
    playNext,
    playPrevious,
    toggleShuffle,
    seekTo,
    setVolume,
    addFavoriteTrack,
    removeFavoriteTrack,
    openDrawerToTab,
    focusMainWindow,
    navigateToArtist,
    navigateToArtistTracks,
    navigateToAlbum,
    navigateToPlaylist,
    navigateToMix,
    navigateToFavorites,
    showToast,
  ]);

  // Close miniplayer when queue empties (if main window is visible)
  useEffect(() => {
    if (!miniplayerOpen) return;

    const unsub = store.sub(currentTrackAtom, () => {
      const track = store.get(currentTrackAtom);
      if (!track) {
        // Check if main window is visible
        getCurrentWindow()
          .isVisible()
          .then((visible) => {
            if (visible) {
              // Main window is visible — close miniplayer
              WebviewWindow.getByLabel("miniplayer").then((win) => {
                if (win) win.close();
              });
            }
            // If main window is hidden (tray), keep miniplayer open showing last track
          });
      }
    });

    return unsub;
  }, [miniplayerOpen, store]);
}
