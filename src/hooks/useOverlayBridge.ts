import { useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";

import { currentTrackAtom, isPlayingAtom, streamInfoAtom } from "../atoms/playback";
import { themeAtom } from "../atoms/theme";
import { getTrackArtistDisplay, formatStreamQuality } from "../utils/itemHelpers";
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

  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const currentTrackRef = useRef(currentTrack);
  currentTrackRef.current = currentTrack;

  const streamInfoRef = useRef(streamInfo);
  streamInfoRef.current = streamInfo;

  const publish = (positionSeconds: number) => {
    const track = currentTrackRef.current;
    const playing = isPlayingRef.current;
    const trackState = track
      ? {
          title: track.title ?? "",
          artist: getTrackArtistDisplay(track),
          album: track.album?.title ?? null,
          coverUrl: getTidalImageUrl(track.album?.cover, 640),
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

  // Push state immediately on track/isPlaying/streamInfo change
  useEffect(() => {
    publish(getInterpolatedPosition());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrack, isPlaying, streamInfo]);

  // Push position every second while playing
  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => {
      publish(getInterpolatedPosition());
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  // Push theme CSS whenever the theme changes.
  // Derive the full token set from the seed so we don't rely on DOM timing.
  useEffect(() => {
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
  }, [theme]);
}
