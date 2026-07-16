import { useEffect, useRef } from "react";
import { useAtom, useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";

import {
  currentTrackAtom,
  isPlayingAtom,
  streamInfoAtom,
} from "../atoms/playback";
import { themeAtom } from "../atoms/theme";
import {
  overlayConnectionInfoAtom,
  type OverlayConnectionInfo,
} from "../atoms/overlay";
import {
  getTrackArtistDisplay,
  formatStreamQuality,
  trackCoverId,
} from "../utils/itemHelpers";
import { getTidalImageUrl } from "../types";
import { getInterpolatedPosition } from "../lib/playbackPosition";
import { deriveTheme, themeToCssVars } from "../lib/theme";

// CSS variable names used by the overlay — subset of all --th-* vars
const OVERLAY_VARS = [
  "--th-bg-base",
  "--th-bg-elevated",
  "--th-bg-inset",
  "--th-accent",
  "--th-accent-hover",
  "--th-on-accent",
  "--th-text-primary",
  "--th-text-secondary",
  "--th-text-muted",
  "--th-text-faint",
  "--th-border-subtle",
  "--th-slider-fill",
  "--th-slider-track",
];

export function useOverlayBridge() {
  const currentTrack = useAtomValue(currentTrackAtom);
  const isPlaying = useAtomValue(isPlayingAtom);
  const streamInfo = useAtomValue(streamInfoAtom);
  const theme = useAtomValue(themeAtom);
  const [info, setInfo] = useAtom(overlayConnectionInfoAtom);

  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const currentTrackRef = useRef(currentTrack);
  currentTrackRef.current = currentTrack;

  const streamInfoRef = useRef(streamInfo);
  streamInfoRef.current = streamInfo;

  const enabledRef = useRef(info.enabled);
  enabledRef.current = info.enabled;

  // Populate the connection-info atom at startup so publishing is gated
  // correctly before the settings tab is ever opened.
  useEffect(() => {
    invoke<OverlayConnectionInfo>("overlay_get_connection_info")
      .then(setInfo)
      .catch(() => {});
  }, [setInfo]);

  const publish = (positionSeconds: number) => {
    if (!enabledRef.current) return;
    const track = currentTrackRef.current;
    const playing = isPlayingRef.current;
    const trackState = track
      ? {
          title: track.title ?? "",
          artist: getTrackArtistDisplay(track),
          album: track.album?.title ?? null,
          coverUrl: getTidalImageUrl(trackCoverId(track), 640),
          isPlaying: playing,
          positionSeconds,
          durationSeconds: track.duration ?? 0,
          quality: formatStreamQuality(streamInfoRef.current),
        }
      : null;

    invoke("overlay_publish_state", { track: trackState }).catch((e) => {
      console.warn("overlay_publish_state failed:", e);
    });
  };

  // Push state immediately on track/isPlaying/streamInfo change — and when
  // the overlay is switched on, so it starts from fresh data.
  useEffect(() => {
    publish(getInterpolatedPosition());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack, isPlaying, streamInfo, info.enabled]);

  // Push position every second while playing
  useEffect(() => {
    if (!isPlaying || !info.enabled) return;
    const id = setInterval(() => {
      publish(getInterpolatedPosition());
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, info.enabled]);

  // Seeks don't touch any atom this hook watches — without this a paused
  // seek leaves the overlay stale until resume.
  useEffect(() => {
    const onSeek = (e: Event) => {
      const detail = (e as CustomEvent<number>).detail;
      publish(typeof detail === "number" ? detail : getInterpolatedPosition());
    };
    window.addEventListener("playback-seeked", onSeek);
    return () => window.removeEventListener("playback-seeked", onSeek);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push theme CSS whenever the theme changes or the overlay is switched on.
  // Derive the full token set from the seed so we don't rely on DOM timing.
  useEffect(() => {
    if (!info.enabled) return;
    const derived = deriveTheme(theme.accent, theme.bgBase);
    const vars = themeToCssVars(derived);
    const lines = OVERLAY_VARS.flatMap((v) => {
      const val = vars[v];
      return val ? [`  ${v}: ${val};`] : [];
    });
    const css = `:root {\n${lines.join("\n")}\n}`;
    invoke("overlay_publish_theme", { css }).catch((e) => {
      console.warn("overlay_publish_theme failed:", e);
    });
  }, [theme, info.enabled]);
}
