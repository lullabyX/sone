/**
 * AppInitializer — invisible component rendered once at the app root.
 *
 * Centralises all one-time and global side-effects so they execute exactly
 * once, regardless of how many components import the domain hooks.
 *
 * Uses usePlaybackActions() (zero-subscription) for all action callbacks,
 * and store.get() for one-time reads (no reactive subscriptions).
 */

import { useEffect, useRef, startTransition } from "react";
import { useSetAtom, useStore, useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { parseTidalUrl } from "../lib/tidalUrl";

// Atoms — write-only setters (no re-render from reading)
import {
  isAuthenticatedAtom,
  isAuthCheckingAtom,
  authTokensAtom,
  userNameAtom,
} from "../atoms/auth";
import {
  userPlaylistsAtom,
  deletedPlaylistIdsAtom,
} from "../atoms/playlists";
import {
  favoriteTrackIdsAtom,
  favoriteAlbumIdsAtom,
  favoritePlaylistUuidsAtom,
  followedArtistIdsAtom,
  favoriteMixIdsAtom,
} from "../atoms/favorites";
import { currentViewAtom } from "../atoms/navigation";
import {
  isPlayingAtom,
  currentTrackAtom,
  queueAtom,
  historyAtom,
  volumeAtom,
  preMuteVolumeAtom,
  exclusiveModeAtom,
  bitPerfectAtom,
  exclusiveDeviceAtom,
  originalQueueAtom,
  manualQueueAtom,
  playbackSourceAtom,
  contextSourceAtom,
  shuffleAtom,
  repeatAtom,
  streamInfoAtom,
} from "../atoms/playback";
import { drawerOpenAtom, maximizedPlayerAtom } from "../atoms/ui";
import { proxySettingsAtom, type ProxySettings } from "../atoms/proxy";

// Stable action callbacks (no atom subscriptions)
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import { useFavorites } from "../hooks/useFavorites";
import { useToast } from "../contexts/ToastContext";
import {
  checkNetworkError,
  clearCache,
  savePlaybackQueue,
  loadPlaybackQueue,
  getHomePage,
  getAllFavoriteIds,
  getFavoriteTracks,
  getFavoriteArtists,
  getFavoriteAlbums,
  getPlaylistFolders,
  normalizePlaylistFolders,
  getTrack,
} from "../api/tidal";

import type {
  AuthTokens,
  Track,
  QueuedTrack,
  PlaybackSnapshot,
  PlaylistOrFolder,
} from "../types";
import { getTidalImageUrl, getTrackDisplayTitle } from "../types";
import {
  getTrackArtistDisplay,
  getTrackArtistDiscordDisplay,
  getTrackShareUrl,
} from "../utils/itemHelpers";
import { ensureQid, advanceCounterPast } from "../lib/qid";
import {
  initPositionInterpolator,
  destroyPositionInterpolator,
  notifySeek,
  getInterpolatedPosition,
} from "../lib/playbackPosition";

const PLAYBACK_STATE_KEY = "sone.playback-state.v1";

function isValidTrack(t: unknown): t is Track {
  return !!t && typeof (t as Track).id === "number";
}

export function AppInitializer() {
  // Preload subscribes to auth state (single re-render on login)
  const isAuthenticated = useAtomValue(isAuthenticatedAtom);

  // ---- Auth atom setters (useSetAtom = write-only, no subscribe) ----
  const setIsAuthenticated = useSetAtom(isAuthenticatedAtom);
  const setIsAuthChecking = useSetAtom(isAuthCheckingAtom);
  const setAuthTokens = useSetAtom(authTokensAtom);
  const setUserName = useSetAtom(userNameAtom);
  const setUserPlaylists = useSetAtom(userPlaylistsAtom);
  const setFavoriteTrackIds = useSetAtom(favoriteTrackIdsAtom);
  const setFavoriteAlbumIds = useSetAtom(favoriteAlbumIdsAtom);
  const setFavoritePlaylistUuids = useSetAtom(favoritePlaylistUuidsAtom);
  const setFollowedArtistIds = useSetAtom(followedArtistIdsAtom);
  const setFavoriteMixIds = useSetAtom(favoriteMixIdsAtom);

  // ---- Playback atom setters (for restore from localStorage) ----
  const setCurrentTrack = useSetAtom(currentTrackAtom);
  const setQueue = useSetAtom(queueAtom);
  const setHistory = useSetAtom(historyAtom);
  const setOriginalQueue = useSetAtom(originalQueueAtom);
  const setManualQueue = useSetAtom(manualQueueAtom);
  const setPlaybackSource = useSetAtom(playbackSourceAtom);
  const setContextSource = useSetAtom(contextSourceAtom);

  // ---- Stable playback actions (no subscriptions) ----
  const { playTrack, playNext, playPrevious, pauseTrack, resumeTrack, setVolume, toggleShuffle, seekTo } =
    usePlaybackActions();
  const { addFavoriteTrack, removeFavoriteTrack, favoriteTrackIds } =
    useFavorites();
  const setDrawerOpen = useSetAtom(drawerOpenAtom);
  const { showToast } = useToast();

  // ---- Store for one-time reads (volume, queue, history, etc.) — no subscription ----
  const store = useStore();

  // ---- Navigation ----
  const setCurrentView = useSetAtom(currentViewAtom);
  const deletedPlaylistIds = useAtomValue(deletedPlaylistIdsAtom);
  const deletedPlaylistIdsRef = useRef(deletedPlaylistIds);
  deletedPlaylistIdsRef.current = deletedPlaylistIds;

  // ---- Refs ----
  const volumeSyncedRef = useRef(false);

  // ================================================================
  //  AUTH LOADING (one-time)
  // ================================================================
  useEffect(() => {
    const loadAuth = async () => {
      try {
        const tokens = await invoke<AuthTokens | null>("load_saved_auth");
        if (!tokens) {
          setIsAuthChecking(false);
          return;
        }

        let userId = tokens.user_id;
        if (!userId) {
          try {
            userId = await invoke<number>("get_session_user_id");
          } catch {
            // no user id available
          }
        }

        let activeTokens: AuthTokens = { ...tokens, user_id: userId };
        setAuthTokens(activeTokens);
        setIsAuthenticated(true);
        setIsAuthChecking(false); // show home immediately, playlists load in background

        if (!userId) return;

        // User name (non-blocking)
        invoke<[string, string | null]>("get_user_profile", { userId })
          .then(([name]) => {
            if (name) setUserName(name);
          })
          .catch(() => {});

        // Exclusive mode settings (non-blocking, backend-authoritative)
        invoke<boolean>("get_exclusive_mode")
          .then((v) => store.set(exclusiveModeAtom, v))
          .catch(() => {});
        invoke<boolean>("get_bit_perfect")
          .then((v) => store.set(bitPerfectAtom, v))
          .catch(() => {});
        invoke<string | null>("get_exclusive_device")
          .then((v) => store.set(exclusiveDeviceAtom, v))
          .catch(() => {});
        invoke<ProxySettings>("get_proxy_settings")
          .then((v) => store.set(proxySettingsAtom, v))
          .catch(() => {});

        // Playlists (via folders endpoint)
        try {
          const result = await getPlaylistFolders("root", 0, 50);
          const normalized = normalizePlaylistFolders(result);
          const playlists = normalized.items
            .filter((i): i is Extract<PlaylistOrFolder, { kind: "playlist" }> => i.kind === "playlist")
            .map((i) => i.data);
          setUserPlaylists(playlists);
        } catch (playlistErr: any) {
          console.error("Failed to load playlists:", playlistErr);
          checkNetworkError(playlistErr);

          const isAuthError = (err: unknown): boolean => {
            if (typeof err === "object" && err !== null) {
              const e = err as Record<string, unknown>;
              if (e.status === 401 || e.status === "401") return true;
              if (typeof e.body === "string" && e.body.includes("401"))
                return true;
            }
            return false;
          };

          if (isAuthError(playlistErr) && activeTokens) {
            try {
              const refreshed = await invoke<AuthTokens>("refresh_tidal_auth");
              activeTokens = refreshed;
              setAuthTokens(activeTokens);

              const retryResult = await getPlaylistFolders("root", 0, 50);
              const retryNormalized = normalizePlaylistFolders(retryResult);
              const retryPlaylists = retryNormalized.items
                .filter((i): i is Extract<PlaylistOrFolder, { kind: "playlist" }> => i.kind === "playlist")
                .map((i) => i.data);
              setUserPlaylists(retryPlaylists);
            } catch (refreshErr) {
              console.error("Token refresh failed:", refreshErr);
              setIsAuthenticated(false);
              setAuthTokens(null);
              setUserPlaylists([]);
            }
          } else {
            setUserPlaylists([]);
          }
        }

        // Preload home page (fire-and-forget)
        getHomePage().catch(() => {});
      } catch (err) {
        console.error("Failed to load saved auth:", err);
        setIsAuthChecking(false);
      }
    };

    loadAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ================================================================
  //  NETWORK ERROR TOAST
  // ================================================================
  useEffect(() => {
    const handler = () => {
      const proxyEnabled = store.get(proxySettingsAtom).enabled;
      showToast(
        proxyEnabled
          ? "Network error \u2014 check your proxy settings"
          : "Network error \u2014 check your internet connection",
        "error",
      );
    };
    window.addEventListener("network-error", handler);
    return () => window.removeEventListener("network-error", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ================================================================
  //  PRELOAD frequently accessed data after auth
  // ================================================================
  useEffect(() => {
    if (!isAuthenticated) return;

    const userId = store.get(authTokensAtom)?.user_id;
    if (!userId) return;

    // Favorite IDs — unified endpoint (tracks/albums/artists/playlists in one call)
    // Runs immediately on auth (both saved-token restore AND fresh login).
    getAllFavoriteIds(userId)
      .then((ids) => {
        setFavoriteTrackIds(new Set(ids.tracks));
        setFavoriteAlbumIds(new Set(ids.albums));
        setFollowedArtistIds(new Set(ids.artists));
        setFavoritePlaylistUuids(new Set(ids.playlists));
      })
      .catch((error) => console.error("Failed to load favorite IDs:", error));

    // Mix IDs still separate (v2 endpoint, not in unified response)
    invoke<string[]>("get_favorite_mix_ids")
      .then((ids) => setFavoriteMixIds(new Set(ids)))
      .catch((error) =>
        console.error("Failed to load favorite mix IDs:", error),
      );

    // Non-blocking background preload (2s delay to avoid startup congestion)
    const timer = setTimeout(() => {
      // Preload in parallel (errors are non-fatal)
      Promise.all([
        getFavoriteTracks(userId, 0, 50).catch(() => {}),
        getFavoriteArtists(userId, 0, 20).catch(() => {}),
        getFavoriteAlbums(userId, 0, 20).catch(() => {}),
      ]).then(() => {
        console.log("[Preload] Cache warmed");
      });
    }, 2000);

    return () => clearTimeout(timer);
  }, [isAuthenticated]);

  // ================================================================
  //  DEEP LINK HANDLING (tidal:// URIs)
  // ================================================================
  const deepLinkQueueRef = useRef<string | null>(null);
  const handledUrlRef = useRef<string | null>(null);

  // Register listener on mount — queues URL if not yet authenticated
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    onOpenUrl((urls) => {
      const url = urls[0];
      if (!url) return;
      if (!store.get(isAuthenticatedAtom)) {
        deepLinkQueueRef.current = url;
        return;
      }
      handleDeepLink(url);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After auth, check cold-start URL and drain queue
  useEffect(() => {
    if (!isAuthenticated) return;

    // Cold start: app launched via deep link
    getCurrent()
      .then((urls) => {
        const url = urls?.[0];
        if (url) handleDeepLink(url);
      })
      .catch(() => {});

    // Queued from warm-start before auth
    if (deepLinkQueueRef.current) {
      handleDeepLink(deepLinkQueueRef.current);
      deepLinkQueueRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  function handleDeepLink(url: string) {
    // Deduplicate: getCurrent() and onOpenUrl can both fire for the same cold-start URL
    if (handledUrlRef.current === url) return;
    handledUrlRef.current = url;

    const action = parseTidalUrl(url);
    if (!action) return;

    if (action.kind === "navigate") {
      window.history.pushState(action.view, "");
      startTransition(() => setCurrentView(action.view));
    } else {
      // playTrack: fetch track metadata, then play
      getTrack(action.trackId)
        .then((track) => playTrack(track))
        .catch((err) => console.error("Deep link play failed:", err));
    }
  }

  // ================================================================
  //  PLAYBACK RESTORE + PERSISTENCE (merged into one effect)
  //  1. Restore from backend disk → localStorage fallback
  //  2. After restore completes, subscribe to atom changes for persistence
  //  Merging avoids race: separate effects meant persistence subscriptions
  //  were never set up because the guard ref was still false.
  // ================================================================
  useEffect(() => {
    let cancelled = false;
    let unsub1: (() => void) | null = null;
    let unsub2: (() => void) | null = null;
    let unsub3: (() => void) | null = null;
    let unsub4: (() => void) | null = null;
    let unsub5: (() => void) | null = null;
    let unsub6: (() => void) | null = null;
    let unsub7: (() => void) | null = null;
    let backendTimer: ReturnType<typeof setTimeout> | null = null;
    let latestJson: string | null = null;

    const restoreSnapshot = (raw: string) => {
      const parsed = JSON.parse(raw) as Partial<PlaybackSnapshot>;

      if (parsed.currentTrack && typeof parsed.currentTrack.id === "number") {
        setCurrentTrack(parsed.currentTrack as Track);
      }

      if (Array.isArray(parsed.queue)) {
        setQueue(
          parsed.queue.filter(
            (t): t is Track => !!t && typeof t.id === "number",
          ),
        );
      }

      if (Array.isArray(parsed.history)) {
        setHistory(
          parsed.history.filter(
            (t): t is Track => !!t && typeof t.id === "number",
          ),
        );
      }

      if (Array.isArray(parsed.originalQueue)) {
        setOriginalQueue(
          parsed.originalQueue
            .filter(isValidTrack)
            .map((t) => ensureQid(t as QueuedTrack)),
        );
      } else {
        setOriginalQueue(null);
      }

      if (Array.isArray(parsed.manualQueue)) {
        setManualQueue(
          parsed.manualQueue
            .filter(isValidTrack)
            .map((t) => ensureQid(t as QueuedTrack)),
        );
      }

      if (parsed.playbackSource) {
        setPlaybackSource({
          ...parsed.playbackSource,
          tracks: parsed.playbackSource.tracks
            .filter(isValidTrack)
            .map((t) => ensureQid(t as QueuedTrack)),
        });
      }

      if (parsed.contextSource) {
        setContextSource({
          ...parsed.contextSource,
          tracks: parsed.contextSource.tracks
            .filter(isValidTrack)
            .map((t) => ensureQid(t as QueuedTrack)),
        });
      }

      // Advance QID counter past all restored _qid values to prevent collisions
      const allRestored = [
        ...(parsed.queue || []),
        ...(parsed.history || []),
        ...(parsed.manualQueue || []),
        ...(parsed.originalQueue || []),
        ...(parsed.playbackSource?.tracks || []),
        ...(parsed.contextSource?.tracks || []),
        ...(parsed.currentTrack ? [parsed.currentTrack] : []),
      ]
        .filter(isValidTrack)
        .map((t) => ensureQid(t as QueuedTrack));
      advanceCounterPast(allRestored);
    };

    const restore = async () => {
      try {
        const backendRaw = await loadPlaybackQueue();
        if (backendRaw) {
          restoreSnapshot(backendRaw);
          return;
        }
      } catch {
        // Backend unavailable — fall through to localStorage
      }

      try {
        const raw = localStorage.getItem(PLAYBACK_STATE_KEY);
        if (raw) restoreSnapshot(raw);
      } catch (err) {
        console.error("Failed to restore playback state:", err);
      }
    };

    const setupPersistence = () => {
      const persist = () => {
        const snapshot: PlaybackSnapshot = {
          currentTrack: store.get(currentTrackAtom),
          queue: store.get(queueAtom),
          history: store.get(historyAtom),
          manualQueue: store.get(manualQueueAtom),
          originalQueue: store.get(originalQueueAtom),
          playbackSource: store.get(playbackSourceAtom),
          contextSource: store.get(contextSourceAtom),
        };
        const json = JSON.stringify(snapshot);
        latestJson = json;

        // Immediate localStorage write
        try {
          localStorage.setItem(PLAYBACK_STATE_KEY, json);
        } catch (err) {
          console.error("Failed to persist playback state:", err);
        }

        // Debounced backend disk write (2s) to avoid excessive I/O
        if (backendTimer) clearTimeout(backendTimer);
        backendTimer = setTimeout(() => {
          backendTimer = null;
          latestJson = null;
          savePlaybackQueue(json).catch((err) =>
            console.error("Failed to save playback queue to backend:", err),
          );
        }, 2000);
      };

      unsub1 = store.sub(currentTrackAtom, persist);
      unsub2 = store.sub(queueAtom, persist);
      unsub3 = store.sub(historyAtom, persist);
      unsub4 = store.sub(manualQueueAtom, persist);
      unsub5 = store.sub(originalQueueAtom, persist);
      unsub6 = store.sub(playbackSourceAtom, persist);
      unsub7 = store.sub(contextSourceAtom, persist);
    };

    restore().finally(() => {
      if (!cancelled) setupPersistence();
    });

    return () => {
      cancelled = true;
      unsub1?.();
      unsub2?.();
      unsub3?.();
      unsub4?.();
      unsub5?.();
      unsub6?.();
      unsub7?.();
      if (backendTimer) clearTimeout(backendTimer);
      // Flush pending save on unmount
      if (latestJson) {
        savePlaybackQueue(latestJson).catch((err) =>
          console.error("Failed to flush playback queue on unmount:", err),
        );
      }
    };
  }, [store]);

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
  //  AUTO-PLAY next track when current finishes
  //  Listens for the "track-finished" Tauri event emitted by the GStreamer
  //  bus thread on EOS only (errors emit "audio-error" instead).
  // ================================================================
  useEffect(() => {
    const unlisten = listen("track-finished", () => {
      playNext();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [playNext]);

  // ================================================================
  //  AUDIO ERROR HANDLING
  //  Async GStreamer bus errors (device busy, pipeline failures, etc.)
  // ================================================================
  useEffect(() => {
    const unlisten = listen<{ kind: string; message?: string }>(
      "audio-error",
      (event) => {
        store.set(isPlayingAtom, false);
        const { kind, message } = event.payload;
        if (kind === "device_busy") {
          showToast(
            "Audio device is busy — close other apps using it",
            "error",
          );
        } else {
          const display =
            message && message.length > 80
              ? message.slice(0, 80) + "…"
              : message || "Playback error";
          showToast(display, "error");
        }
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [store, showToast]);

  // ================================================================
  //  RESAMPLING NOTIFICATION — toast when exclusive mode resamples
  // ================================================================
  useEffect(() => {
    const unlisten = listen<{ from: number; to: number }>(
      "audio-resampled",
      (event) => {
        const { from, to } = event.payload;
        const fromKhz = from >= 1000 ? `${from / 1000}kHz` : `${from}Hz`;
        const toKhz = to >= 1000 ? `${to / 1000}kHz` : `${to}Hz`;
        showToast(`DAC doesn't support ${fromKhz} — resampling to ${toKhz}`, "info");
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [showToast]);

  // ================================================================
  //  BIT-DEPTH CHANGE — toast when bit-perfect promotes sample format
  // ================================================================
  useEffect(() => {
    const unlisten = listen<{ from: string; to: string }>(
      "audio-bit-depth-changed",
      (event) => {
        const { from, to } = event.payload;
        showToast(
          `DAC doesn't support ${from} — playing as ${to} (lossless)`,
          "info",
        );
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [showToast]);

  // ================================================================
  //  SCROBBLE AUTH ERROR — toast when a provider's session expires
  // ================================================================
  useEffect(() => {
    const unlisten = listen<string>("scrobble-auth-error", (event) => {
      const provider = event.payload;
      const name =
        provider === "lastfm"
          ? "Last.fm"
          : provider === "listenbrainz"
            ? "ListenBrainz"
            : provider === "librefm"
              ? "Libre.fm"
              : provider;
      showToast(
        `${name} session expired — reconnect in Scrobbling settings`,
        "error",
      );
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [showToast]);

  // ================================================================
  //  SYNC PLAYBACK ERROR HANDLING
  //  Catches invoke failures from playTrack/resumeTrack/playPrevious
  // ================================================================
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      showToast(detail || "Playback failed", "error");
    };
    window.addEventListener("playback-error", handler);
    return () => window.removeEventListener("playback-error", handler);
  }, [showToast]);

  // ================================================================
  //  TRAY & GLOBAL MEDIA KEY EVENTS
  //  Backend emits these from tray menu clicks and global shortcut handler.
  // ================================================================
  useEffect(() => {
    const unlistenToggle = listen("tray:toggle-play", () => {
      if (store.get(isPlayingAtom)) {
        pauseTrack();
      } else {
        resumeTrack();
      }
    });
    const unlistenNext = listen("tray:next-track", () => {
      playNext({ explicit: true });
    });
    const unlistenPrev = listen("tray:prev-track", () => {
      playPrevious();
    });
    const unlistenMprisPlay = listen("mpris:play", () => {
      if (!store.get(isPlayingAtom)) {
        resumeTrack();
      }
    });
    const unlistenMprisPause = listen("mpris:pause", () => {
      if (store.get(isPlayingAtom)) {
        pauseTrack();
      }
    });
    const unlistenMprisStop = listen("mpris:stop", () => {
      invoke("stop_track").catch(() => {});
      store.set(isPlayingAtom, false);
    });
    return () => {
      unlistenToggle.then((fn) => fn());
      unlistenNext.then((fn) => fn());
      unlistenPrev.then((fn) => fn());
      unlistenMprisPlay.then((fn) => fn());
      unlistenMprisPause.then((fn) => fn());
      unlistenMprisStop.then((fn) => fn());
    };
  }, [store, playNext, playPrevious, pauseTrack, resumeTrack]);

  // ================================================================
  //  TRAY TOOLTIP — update with current track info
  // ================================================================
  useEffect(() => {
    const updateTooltip = () => {
      const track = store.get(currentTrackAtom);
      const text = track
        ? `${getTrackDisplayTitle(track)} — ${getTrackArtistDisplay(track)}`
        : "Sone";
      invoke("update_tray_tooltip", { text })
        .then((r) => console.log("[tray tooltip]", text, "→", r))
        .catch((e) => console.error("[tray tooltip] invoke failed:", e));
    };

    // Set tooltip for already-restored track
    updateTooltip();

    const unsub = store.sub(currentTrackAtom, updateTooltip);
    return unsub;
  }, [store]);

  // ================================================================
  //  MPRIS — push metadata & playback status to backend for D-Bus
  // ================================================================
  useEffect(() => {
    const formatQualityText = (info: import("../types").StreamInfo | null): string => {
      if (!info) return "";
      const parts: string[] = [];
      if (info.bitDepth) parts.push(`${info.bitDepth}-BIT`);
      if (info.sampleRate) {
        const khz = info.sampleRate / 1000;
        parts.push(`${info.sampleRate % 1000 ? khz.toFixed(1) : khz}KHZ`);
      }
      if (info.codec) parts.push(info.codec.toUpperCase());
      return parts.join(" ");
    };

    const pushMetadata = () => {
      const track = store.get(currentTrackAtom);
      if (!track) return;
      const streamInfo = store.get(streamInfoAtom);
      invoke("update_mpris_metadata", {
        metadata: {
          trackId: track.id,
          title: getTrackDisplayTitle(track),
          artist: getTrackArtistDiscordDisplay(track),
          album: track.album?.title || "",
          artUrl: getTidalImageUrl(track.album?.cover, 320),
          durationSecs: track.duration,
          url: getTrackShareUrl(track.id),
          qualityText: formatQualityText(streamInfo),
        },
      }).catch(() => {});
      // Re-push playback status — isPlayingAtom may not have changed
      // (was true before, still true after), so its subscriber won't fire
      invoke("update_mpris_playback_status", {
        isPlaying: store.get(isPlayingAtom),
      }).catch(() => {});
    };

    pushMetadata();
    const unsubTrack = store.sub(currentTrackAtom, pushMetadata);
    const unsubStream = store.sub(streamInfoAtom, pushMetadata);
    return () => { unsubTrack(); unsubStream(); };
  }, [store]);

  useEffect(() => {
    const pushStatus = () => {
      const playing = store.get(isPlayingAtom);
      invoke("update_mpris_playback_status", {
        isPlaying: playing,
        positionSecs: getInterpolatedPosition(),
      }).catch(() => {});
    };

    pushStatus();
    const unsub = store.sub(isPlayingAtom, pushStatus);
    return unsub;
  }, [store]);

  useEffect(() => {
    const push = () => {
      invoke("update_mpris_shuffle", { enabled: store.get(shuffleAtom) }).catch(() => {});
    };
    push();
    return store.sub(shuffleAtom, push);
  }, [store]);

  useEffect(() => {
    const push = () => {
      invoke("update_mpris_loop_status", { mode: store.get(repeatAtom) }).catch(() => {});
    };
    push();
    return store.sub(repeatAtom, push);
  }, [store]);

  useEffect(() => {
    const unlistenSeek = listen<number>("mpris:seek", async (event) => {
      try {
        const current = await invoke<number>("get_playback_position");
        const newPos = Math.max(0, current + event.payload);
        await invoke("seek_track", { positionSecs: newPos });
        notifySeek(newPos);
      } catch {}
    });
    const unlistenVolume = listen<number>("mpris:set-volume", (event) => {
      setVolume(Math.max(0, Math.min(1, event.payload)));
    });
    const unlistenShuffle = listen<boolean>("mpris:set-shuffle", (event) => {
      if (store.get(shuffleAtom) !== event.payload) {
        toggleShuffle();
      }
    });
    const unlistenLoop = listen<number>("mpris:set-loop-status", (event) => {
      store.set(repeatAtom, event.payload);
    });
    const unlistenSetPosition = listen<number>("mpris:set-position", async (event) => {
      const pos = Math.max(0, event.payload);
      await seekTo(pos);
    });
    return () => {
      unlistenSeek.then((fn) => fn());
      unlistenVolume.then((fn) => fn());
      unlistenShuffle.then((fn) => fn());
      unlistenLoop.then((fn) => fn());
      unlistenSetPosition.then((fn) => fn());
    };
  }, [store, setVolume, toggleShuffle, seekTo]);

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
            playNext({ explicit: true });
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
              store.set(preMuteVolumeAtom, vol);
              setVolume(0);
            } else {
              setVolume(store.get(preMuteVolumeAtom) || 0.5);
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
          if (store.get(maximizedPlayerAtom)) break;
          e.preventDefault();
          setDrawerOpen(false);
          break;
        case "Slash":
          if (e.shiftKey) {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent("toggle-shortcuts"));
          }
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    store,
    playNext,
    playPrevious,
    pauseTrack,
    resumeTrack,
    setVolume,
    setDrawerOpen,
    favoriteTrackIds,
    addFavoriteTrack,
    removeFavoriteTrack,
  ]);

  // ================================================================
  //  BLOCK MIDDLE-CLICK PASTE (Linux/X11 primary selection)
  //  WebKitGTK processes the paste before mousedown reaches JS,
  //  so we also intercept the paste event triggered by middle-click.
  // ================================================================
  useEffect(() => {
    let middleDown = false;
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1) {
        middleDown = true;
        e.preventDefault();
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (middleDown) {
        e.preventDefault();
      }
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 1) middleDown = false;
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("paste", onPaste, true);
    window.addEventListener("mouseup", onMouseUp, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("paste", onPaste, true);
      window.removeEventListener("mouseup", onMouseUp, true);
    };
  }, []);

  // ================================================================
  //  POPSTATE (browser back/forward navigation)
  // ================================================================
  useEffect(() => {
    if (!window.history.state) {
      window.history.replaceState({ type: "home" }, "");
    }

    const handler = (event: PopStateEvent) => {
      if (!event.state) return;
      // Skip deleted playlist entries — go back further
      if (
        event.state.type === "playlist" &&
        deletedPlaylistIdsRef.current.has(event.state.playlistId)
      ) {
        window.history.back();
        return;
      }
      startTransition(() => setCurrentView(event.state));
    };

    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [setCurrentView]);

  // ================================================================
  //  PLAYBACK POSITION INTERPOLATOR
  //  Single 2s IPC poll, synchronous reads for all consumers.
  // ================================================================
  useEffect(() => {
    initPositionInterpolator(store, isPlayingAtom, currentTrackAtom);
    return () => destroyPositionInterpolator();
  }, [store]);

  return null;
}
