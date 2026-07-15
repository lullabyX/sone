/**
 * Sonos-target behavior of usePlaybackActions: routing of the invoke
 * boundary while casting, and adoptRemoteTrack's reconciliation of
 * speaker-side track changes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";
import { usePlaybackActions } from "./usePlaybackActions";
import { ToastProvider } from "../contexts/ToastContext";
import {
  currentTrackAtom,
  historyAtom,
  isPlayingAtom,
  manualQueueAtom,
  originalQueueAtom,
  playbackTargetAtom,
  queueAtom,
  streamInfoAtom,
  userPausedAtom,
  volumeAtom,
  bitPerfectAtom,
} from "../atoms/playback";
import { sonosPendingResumeSeekAtom, sonosVolumeAtom } from "../atoms/sonos";
import type { Track } from "../types";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

const track = (id = 42, over: Partial<Track> = {}): Track =>
  ({
    id,
    title: `Song ${id}`,
    duration: 200,
    album: { title: "Album" },
    artist: { name: "Artist" },
    _qid: `q${id}`,
    ...over,
  }) as unknown as Track;

const SONOS_TARGET = {
  type: "sonos" as const,
  coordinatorUuid: "RINCON_TEST01400",
  roomName: "Living Room",
};

function setup(target: "local" | "sonos") {
  const store = createStore();
  if (target === "sonos") {
    store.set(playbackTargetAtom, SONOS_TARGET);
  }
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>
      <ToastProvider>{children}</ToastProvider>
    </Provider>
  );
  const { result } = renderHook(() => usePlaybackActions(), { wrapper });
  return { store, result };
}

const invokedCommands = () => invokeMock.mock.calls.map((c) => c[0]);

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
});

describe("playback actions route by playbackTargetAtom", () => {
  it("playTrack targets Sonos: sonos_play_track, no local engine, null streamInfo, scrobble intact", async () => {
    const { store, result } = setup("sonos");
    await act(async () => {
      await result.current.playTrack(track());
    });
    const commands = invokedCommands();
    expect(commands).toContain("sonos_play_track");
    expect(commands).not.toContain("play_tidal_track");
    const call = invokeMock.mock.calls.find((c) => c[0] === "sonos_play_track");
    expect(call?.[1]).toMatchObject({
      trackId: 42,
      start: true,
      meta: { title: "Song 42", album: "Album" },
    });
    expect(store.get(streamInfoAtom)).toBeNull();
    expect(store.get(isPlayingAtom)).toBe(true);
    // The scrobble notify is target-agnostic — SONE always knows the track.
    expect(commands).toContain("notify_track_started");
  });

  it("playTrack targets local by default: play_tidal_track", async () => {
    const { result } = setup("local");
    await act(async () => {
      await result.current.playTrack(track());
    });
    const commands = invokedCommands();
    expect(commands).toContain("play_tidal_track");
    expect(commands).not.toContain("sonos_play_track");
  });

  it("pause/resume route to sonos commands without touching the local pipeline", async () => {
    const { store, result } = setup("sonos");
    store.set(currentTrackAtom, track());
    store.set(isPlayingAtom, true);
    await act(async () => {
      await result.current.pauseTrack();
    });
    expect(invokedCommands()).toContain("sonos_pause");
    expect(invokedCommands()).not.toContain("pause_track");
    expect(store.get(isPlayingAtom)).toBe(false);

    invokeMock.mockClear();
    await act(async () => {
      await result.current.resumeTrack();
    });
    expect(invokedCommands()).toContain("sonos_resume");
    // No finished-check against the (stopped) local pipeline.
    expect(invokedCommands()).not.toContain("is_track_finished");
    expect(invokedCommands()).not.toContain("resume_track");
    expect(store.get(isPlayingAtom)).toBe(true);
  });

  it("seekTo routes to sonos_seek", async () => {
    const { result } = setup("sonos");
    await act(async () => {
      await result.current.seekTo(93);
    });
    const call = invokeMock.mock.calls.find((c) => c[0] === "sonos_seek");
    expect(call?.[1]).toEqual({ positionSecs: 93 });
    expect(invokedCommands()).not.toContain("seek_track");
  });

  it("setVolume maps 0-1 to Sonos group volume 0-100 and leaves local volume alone", async () => {
    vi.useFakeTimers();
    try {
      const { store, result } = setup("sonos");
      store.set(volumeAtom, 0.8);
      await act(async () => {
        await result.current.setVolume(0.35);
        // The remote IPC is throttled (leading+trailing) — let it flush.
        await vi.advanceTimersByTimeAsync(1000);
      });
      const call = invokeMock.mock.calls.find(
        (c) => c[0] === "sonos_set_volume",
      );
      expect(call?.[1]).toEqual({ volume: 35 });
      expect(store.get(sonosVolumeAtom)).toBe(35);
      // Local persisted volume untouched — restores exactly on handoff.
      expect(store.get(volumeAtom)).toBe(0.8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("setVolume works on Sonos even when bit-perfect gates local volume", async () => {
    vi.useFakeTimers();
    try {
      const { store, result } = setup("sonos");
      store.set(bitPerfectAtom, true);
      await act(async () => {
        await result.current.setVolume(0.5);
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(invokedCommands()).toContain("sonos_set_volume");
      expect(store.get(sonosVolumeAtom)).toBe(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drag-speed volume changes collapse into throttled sends with the latest value", async () => {
    vi.useFakeTimers();
    try {
      const { result } = setup("sonos");
      await act(async () => {
        for (let step = 20; step <= 40; step += 2) {
          void result.current.setVolume(step / 100);
        }
        await vi.advanceTimersByTimeAsync(1000);
      });
      const calls = invokeMock.mock.calls.filter(
        (c) => c[0] === "sonos_set_volume",
      );
      // Leading + at most a couple of trailing flushes — not one per step.
      expect(calls.length).toBeLessThanOrEqual(3);
      // The last value sent is the final slider position.
      expect(calls[calls.length - 1]?.[1]).toEqual({ volume: 40 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resume after cast-while-paused starts playback then applies the deferred seek", async () => {
    const { store, result } = setup("sonos");
    store.set(currentTrackAtom, track());
    store.set(sonosPendingResumeSeekAtom, 366);
    await act(async () => {
      await result.current.resumeTrack();
    });
    const commands = invokedCommands();
    expect(commands).toContain("sonos_resume");
    const seek = invokeMock.mock.calls.find((c) => c[0] === "sonos_seek");
    expect(seek?.[1]).toEqual({ positionSecs: 366 });
    // Resume before seek: a STOPPED transport can't be seeked.
    expect(commands.indexOf("sonos_resume")).toBeLessThan(
      commands.indexOf("sonos_seek"),
    );
    expect(store.get(sonosPendingResumeSeekAtom)).toBeNull();
    expect(store.get(isPlayingAtom)).toBe(true);
  });

  it("scrubbing while stopped-paused updates the deferred seek without SOAP", async () => {
    const { store, result } = setup("sonos");
    store.set(sonosPendingResumeSeekAtom, 100);
    await act(async () => {
      await result.current.seekTo(250);
    });
    expect(store.get(sonosPendingResumeSeekAtom)).toBe(250);
    expect(invokedCommands()).not.toContain("sonos_seek");
  });
});

describe("adoptRemoteTrack reconciles speaker-side track changes", () => {
  it("echo of the current track is a no-op success", () => {
    const { store, result } = setup("sonos");
    store.set(currentTrackAtom, track(1));
    let adopted = false;
    act(() => {
      adopted = result.current.adoptRemoteTrack(1, "q1");
    });
    expect(adopted).toBe(true);
    expect(store.get(currentTrackAtom)?.id).toBe(1);
  });

  it("mirrored self-advance: consumes the manual-queue head by qid", () => {
    const { store, result } = setup("sonos");
    store.set(currentTrackAtom, track(1));
    store.set(manualQueueAtom, [track(2), track(3)]);
    act(() => {
      expect(result.current.adoptRemoteTrack(2, "q2")).toBe(true);
    });
    expect(store.get(currentTrackAtom)?.id).toBe(2);
    expect(store.get(manualQueueAtom).map((t) => t.id)).toEqual([3]);
    // Old current pushed to history (via advanceToTrack)
    expect(store.get(historyAtom).map((t) => t.id)).toEqual([1]);
    // A self-advance is a new listen
    expect(invokedCommands()).toContain("notify_track_started");
  });

  it("external forward jump: skipped entries land in history, originalQueue pruned", () => {
    const { store, result } = setup("sonos");
    store.set(currentTrackAtom, track(1));
    store.set(manualQueueAtom, [track(2)]);
    store.set(queueAtom, [track(3), track(4), track(5)]);
    store.set(originalQueueAtom, [track(3), track(4), track(5)]);
    act(() => {
      // Sonos app jumped straight to track 4: 2 (manual) and 3 were skipped.
      expect(result.current.adoptRemoteTrack(4)).toBe(true);
    });
    expect(store.get(currentTrackAtom)?.id).toBe(4);
    expect(store.get(manualQueueAtom)).toEqual([]);
    expect(store.get(queueAtom).map((t) => t.id)).toEqual([5]);
    // history: skipped [2, 3] then old current 1 (advanceToTrack pushes it)
    expect(store.get(historyAtom).map((t) => t.id)).toEqual([2, 3, 1]);
    expect(store.get(originalQueueAtom)?.map((t) => t.id)).toEqual([5]);
  });

  it("external Previous: adopts from history, displaced current goes to manual front", () => {
    const { store, result } = setup("sonos");
    store.set(historyAtom, [track(1), track(2)]);
    store.set(currentTrackAtom, track(3));
    store.set(manualQueueAtom, [track(4)]);
    store.set(userPausedAtom, false);
    act(() => {
      expect(result.current.adoptRemoteTrack(2)).toBe(true);
    });
    expect(store.get(currentTrackAtom)?.id).toBe(2);
    expect(store.get(historyAtom).map((t) => t.id)).toEqual([1]);
    expect(store.get(manualQueueAtom).map((t) => t.id)).toEqual([3, 4]);
    expect(store.get(isPlayingAtom)).toBe(true);
  });

  it("unknown track returns false and mutates nothing", () => {
    const { store, result } = setup("sonos");
    store.set(currentTrackAtom, track(1));
    store.set(queueAtom, [track(2)]);
    let adopted = true;
    act(() => {
      adopted = result.current.adoptRemoteTrack(999);
    });
    expect(adopted).toBe(false);
    expect(store.get(currentTrackAtom)?.id).toBe(1);
    expect(store.get(queueAtom).map((t) => t.id)).toEqual([2]);
  });
});
