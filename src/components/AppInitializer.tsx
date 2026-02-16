/**
 * AppInitializer — invisible component rendered once at the app root.
 *
 * Centralises all one-time and global side-effects so they execute exactly
 * once, regardless of how many components import the domain hooks.
 *
 * Uses usePlaybackActions() (zero-subscription) for all action callbacks,
 * and useAtomValue() only for atoms that must be read reactively.
 */

import { useEffect, useRef, startTransition } from "react";
import { useSetAtom, useAtomValue, useStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";

// Atoms — write-only setters (no re-render from reading)
import {
  isAuthenticatedAtom,
  authTokensAtom,
  userNameAtom,
} from "../atoms/auth";
import { userPlaylistsAtom, favoritePlaylistsAtom } from "../atoms/playlists";
import { favoriteTrackIdsAtom } from "../atoms/favorites";
import { currentViewAtom } from "../atoms/navigation";
import {
  isPlayingAtom,
  currentTrackAtom,
  queueAtom,
  historyAtom,
  volumeAtom,
} from "../atoms/playback";
import { drawerOpenAtom } from "../atoms/ui";

// Stable action callbacks (no atom subscriptions)
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useFavorites } from "../hooks/useFavorites";
import { clearCache } from "../api/tidal";

import type { AuthTokens, Playlist, Track, PlaybackSnapshot } from "../types";

const PLAYBACK_STATE_KEY = "tide-vibe.playback-state.v1";

export function AppInitializer() {
  // ---- Auth atom setters (useSetAtom = write-only, no subscribe) ----
  const setIsAuthenticated = useSetAtom(isAuthenticatedAtom);
  const setAuthTokens = useSetAtom(authTokensAtom);
  const setUserName = useSetAtom(userNameAtom);
  const setUserPlaylists = useSetAtom(userPlaylistsAtom);
  const setFavoritePlaylists = useSetAtom(favoritePlaylistsAtom);
  const setFavoriteTrackIds = useSetAtom(favoriteTrackIdsAtom);

  // ---- Playback atom setters (for restore from localStorage) ----
  const setCurrentTrack = useSetAtom(currentTrackAtom);
  const setQueue = useSetAtom(queueAtom);
  const setHistory = useSetAtom(historyAtom);

  // ---- Stable playback actions (no subscriptions) ----
  const { playNext, playPrevious, pauseTrack, resumeTrack, setVolume } =
    usePlaybackActions();
  const { addFavoriteTrack, removeFavoriteTrack, favoriteTrackIds } = useFavorites();
  const setDrawerOpen = useSetAtom(drawerOpenAtom);

  // ---- Read only the atoms we NEED to react to ----
  const isPlaying = useAtomValue(isPlayingAtom);
  const currentTrack = useAtomValue(currentTrackAtom);

  // ---- Store for one-time reads (volume, queue, history) — no subscription ----
  const store = useStore();

  // ---- Navigation ----
  const setCurrentView = useSetAtom(currentViewAtom);

  // ---- Refs ----
  const hasRestoredPlaybackRef = useRef(false);
  const playbackPersistReady = useRef(false);
  const volumeSyncedRef = useRef(false);

  // ================================================================
  //  AUTH LOADING (one-time)
  // ================================================================
  useEffect(() => {
    const loadAuth = async () => {
      try {
        const tokens = await invoke<AuthTokens | null>("load_saved_auth");
        if (!tokens) return;

        let userId = tokens.user_id;
        if (!userId) {
          try {
            userId = await invoke<number>("get_session_user_id");
          } catch {
            // no user id available
          }
        }

        let activeTokens = { ...tokens, user_id: userId };
        setAuthTokens(activeTokens);
        setIsAuthenticated(true);

        if (!userId) return;

        // User name (non-blocking)
        invoke<[string, string | null]>("get_user_profile", { userId })
          .then(([name]) => {
            if (name) setUserName(name);
          })
          .catch(() => {});

        // Playlists
        try {
          const playlists = await invoke<Playlist[]>("get_user_playlists", {
            userId,
          });
          setUserPlaylists(playlists || []);

          invoke<Playlist[]>("get_favorite_playlists", { userId })
            .then((fp) => setFavoritePlaylists(fp || []))
            .catch(() => setFavoritePlaylists([]));
        } catch (playlistErr: any) {
          const errStr = String(playlistErr);
          console.error("Failed to load playlists:", playlistErr);

          if (errStr.includes("401") || errStr.includes("expired")) {
            try {
              console.log("Token expired, attempting refresh...");
              const refreshed = await invoke<AuthTokens>(
                "refresh_tidal_auth"
              );
              activeTokens = {
                ...refreshed,
                user_id: userId ?? refreshed.user_id,
              };
              setAuthTokens(activeTokens);

              const playlists = await invoke<Playlist[]>(
                "get_user_playlists",
                { userId }
              );
              setUserPlaylists(playlists || []);

              invoke<Playlist[]>("get_favorite_playlists", { userId })
                .then((fp) => setFavoritePlaylists(fp || []))
                .catch(() => setFavoritePlaylists([]));
            } catch (refreshErr) {
              console.error("Token refresh failed:", refreshErr);
              setIsAuthenticated(false);
              setAuthTokens(null);
              setUserPlaylists([]);
              setFavoritePlaylists([]);
            }
          } else {
            setUserPlaylists([]);
          }
        }

        // Favorite track IDs
        try {
          const ids = await invoke<number[]>("get_favorite_track_ids", {
            userId,
          });
          setFavoriteTrackIds(new Set(ids));
        } catch (error) {
          console.error("Failed to load favorite track IDs:", error);
        }
      } catch (err) {
        console.error("Failed to load saved auth:", err);
      }
    };

    loadAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ================================================================
  //  PLAYBACK RESTORE from localStorage (one-time)
  // ================================================================
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PLAYBACK_STATE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PlaybackSnapshot>;

        if (
          parsed.currentTrack &&
          typeof parsed.currentTrack.id === "number"
        ) {
          setCurrentTrack(parsed.currentTrack as Track);
        }

        if (Array.isArray(parsed.queue)) {
          setQueue(
            parsed.queue.filter(
              (t): t is Track => !!t && typeof t.id === "number"
            )
          );
        }

        if (Array.isArray(parsed.history)) {
          setHistory(
            parsed.history.filter(
              (t): t is Track => !!t && typeof t.id === "number"
            )
          );
        }
      }
    } catch (err) {
      console.error("Failed to restore playback state:", err);
    } finally {
      hasRestoredPlaybackRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ================================================================
  //  VOLUME SYNC to backend (one-time, reads volume from store)
  // ================================================================
  useEffect(() => {
    if (!volumeSyncedRef.current) {
      volumeSyncedRef.current = true;
      const vol = store.get(volumeAtom);
      invoke("set_volume", { level: vol }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ================================================================
  //  PLAYBACK PERSISTENCE (reactive — persists on every state change)
  //  Uses store.sub() to listen for changes without React re-renders.
  // ================================================================
  useEffect(() => {
    // Wait until restore has run
    if (!hasRestoredPlaybackRef.current) return;

    const persist = () => {
      if (!playbackPersistReady.current) {
        playbackPersistReady.current = true;
        return;
      }
      const snapshot: PlaybackSnapshot = {
        currentTrack: store.get(currentTrackAtom),
        queue: store.get(queueAtom),
        history: store.get(historyAtom),
      };
      try {
        localStorage.setItem(PLAYBACK_STATE_KEY, JSON.stringify(snapshot));
      } catch (err) {
        console.error("Failed to persist playback state:", err);
      }
    };

    // Subscribe directly to the atoms we care about — no React re-render
    const unsub1 = store.sub(currentTrackAtom, persist);
    const unsub2 = store.sub(queueAtom, persist);
    const unsub3 = store.sub(historyAtom, persist);

    return () => {
      unsub1();
      unsub2();
      unsub3();
    };
  }, [store]);

  // ================================================================
  //  AUTO-PLAY next track when current finishes
  //  Only depends on isPlaying + currentTrack (both read via useAtomValue).
  //  playNext is stable (from usePlaybackActions).
  // ================================================================
  useEffect(() => {
    if (!isPlaying || !currentTrack) return;

    const id = setInterval(async () => {
      try {
        const finished = await invoke<boolean>("is_track_finished");
        if (finished) {
          playNext();
        }
      } catch (err) {
        console.error("Failed to check track status:", err);
      }
    }, 1000);

    return () => clearInterval(id);
  }, [isPlaying, currentTrack, playNext]);

  // ================================================================
  //  KEYBOARD SHORTCUTS
  //  All action callbacks are stable (from usePlaybackActions).
  //  Volume / isPlaying are read from store at call-time.
  // ================================================================
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inInput =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement;

      // ── Ctrl / Cmd combos (work even when inside an input) ──
      const mod = e.ctrlKey || e.metaKey;

      if (mod) {
        switch (e.code) {
          case "ArrowRight":
            if (e.repeat) return;
            e.preventDefault();
            playNext();
            return;
          case "ArrowLeft":
            if (e.repeat) return;
            e.preventDefault();
            playPrevious();
            return;
          case "KeyS":
            e.preventDefault();
            window.dispatchEvent(new CustomEvent("focus-search"));
            return;
          case "KeyR":
            e.preventDefault();
            clearCache();
            window.location.reload();
            return;
        }
      }

      // ── The rest only fire when NOT typing in an input ──
      if (inInput) return;

      switch (e.code) {
        case "Space":
          e.preventDefault();
          if (store.get(isPlayingAtom)) {
            pauseTrack();
          } else {
            resumeTrack();
          }
          break;
        case "ArrowUp":
          e.preventDefault();
          setVolume(Math.min(1.0, store.get(volumeAtom) + 0.1));
          break;
        case "ArrowDown":
          e.preventDefault();
          setVolume(Math.max(0.0, store.get(volumeAtom) - 0.1));
          break;
        case "KeyM":
          if (e.repeat) return;
          e.preventDefault();
          // Toggle mute: store previous volume to restore
          {
            const vol = store.get(volumeAtom);
            if (vol > 0) {
              (window as any).__preMuteVolume = vol;
              setVolume(0);
            } else {
              setVolume((window as any).__preMuteVolume ?? 0.5);
            }
          }
          break;
        case "KeyL":
          if (e.repeat) return;
          e.preventDefault();
          // Like / unlike current track
          {
            const track = store.get(currentTrackAtom);
            if (track) {
              if (favoriteTrackIds.has(track.id)) {
                removeFavoriteTrack(track.id);
              } else {
                addFavoriteTrack(track.id, track);
              }
            }
          }
          break;
        case "Escape":
          e.preventDefault();
          setDrawerOpen(false);
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [store, playNext, playPrevious, pauseTrack, resumeTrack, setVolume, setDrawerOpen, favoriteTrackIds, addFavoriteTrack, removeFavoriteTrack]);

  // ================================================================
  //  POPSTATE (browser back/forward navigation)
  // ================================================================
  useEffect(() => {
    if (!window.history.state) {
      window.history.replaceState({ type: "home" }, "");
    }

    const handler = (event: PopStateEvent) => {
      if (event.state) startTransition(() => setCurrentView(event.state));
    };

    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [setCurrentView]);

  return null;
}
