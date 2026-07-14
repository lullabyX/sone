import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";
import { useSonosBridge } from "./useSonosBridge";
import { ToastProvider } from "../contexts/ToastContext";
import {
  currentTrackAtom,
  isPlayingAtom,
  manualQueueAtom,
  playbackTargetAtom,
  userPausedAtom,
} from "../atoms/playback";
import type { Track } from "../types";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

// Capture Tauri event handlers so tests can fire speaker-side events.
const eventHandlers = vi.hoisted(
  () => new Map<string, (event: { payload: unknown }) => void>(),
);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (event: { payload: unknown }) => void) => {
    eventHandlers.set(name, cb);
    return Promise.resolve(() => eventHandlers.delete(name));
  }),
}));

const track = (id: number): Track =>
  ({
    id,
    title: `Song ${id}`,
    duration: 200,
    album: { title: "Album" },
    artist: { name: "Artist" },
    _qid: `q${id}`,
  }) as unknown as Track;

const SONOS_TARGET = {
  type: "sonos" as const,
  coordinatorUuid: "RINCON_TEST01400",
  coordinatorIp: "192.168.1.10",
  roomName: "Living Room",
};

function setup(remote = true) {
  const store = createStore();
  if (remote) store.set(playbackTargetAtom, SONOS_TARGET);
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>
      <ToastProvider>{children}</ToastProvider>
    </Provider>
  );
  renderHook(() => useSonosBridge(), { wrapper });
  return { store };
}

const fire = (name: string, payload: unknown) =>
  act(() => {
    eventHandlers.get(name)?.({ payload });
  });

describe("useSonosBridge maps speaker events into playback atoms", () => {
  beforeEach(() => {
    localStorage.clear();
    eventHandlers.clear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({});
  });

  it("external pause flips atoms and notifies scrobbler exactly once", async () => {
    const { store } = setup();
    store.set(isPlayingAtom, true);

    await fire("sonos-transport-changed", { state: "PAUSED_PLAYBACK" });
    expect(store.get(isPlayingAtom)).toBe(false);
    expect(store.get(userPausedAtom)).toBe(true);
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "notify_track_paused"),
    ).toHaveLength(1);

    // Echo of the same state (our own command already applied it): no-op.
    await fire("sonos-transport-changed", { state: "PAUSED_PLAYBACK" });
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "notify_track_paused"),
    ).toHaveLength(1);
  });

  it("ignores every event while the target is local", async () => {
    const { store } = setup(false);
    store.set(isPlayingAtom, true);
    await fire("sonos-transport-changed", { state: "PAUSED_PLAYBACK" });
    expect(store.get(isPlayingAtom)).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("natural track end advances SONE's queue onto the speaker", async () => {
    const { store } = setup();
    store.set(currentTrackAtom, track(1));
    store.set(isPlayingAtom, true);
    store.set(manualQueueAtom, [track(2)]);

    await fire("sonos-track-finished", {});
    // Let playNext's async chain settle.
    await act(async () => {
      await Promise.resolve();
    });

    const call = invokeMock.mock.calls.find((c) => c[0] === "sonos_play_track");
    expect(call?.[1]).toMatchObject({ trackId: 2 });
    expect(store.get(currentTrackAtom)?.id).toBe(2);
  });

  it("a foreign track on the speaker detaches to local (after re-verification), queue preserved", async () => {
    vi.useFakeTimers();
    try {
      const { store } = setup();
      store.set(currentTrackAtom, track(1));
      store.set(isPlayingAtom, true);
      store.set(manualQueueAtom, [track(2)]);
      // The re-verification probe reports the foreign track still playing.
      invokeMock.mockImplementation((cmd: string) =>
        Promise.resolve(
          cmd === "sonos_get_now_playing" ? { trackId: 999 } : {},
        ),
      );

      await fire("sonos-track-changed", {
        trackId: 999,
        trackUri: "x-sonos-http:track%2f999.flac",
      });
      // Not detached yet — the mismatch must survive the verification delay
      // (a rapid double-skip produces a benign one-tick mismatch).
      expect(store.get(playbackTargetAtom).type).toBe("sonos");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });

      expect(store.get(playbackTargetAtom).type).toBe("local");
      expect(store.get(isPlayingAtom)).toBe(false);
      expect(store.get(manualQueueAtom)).toHaveLength(1);
      expect(store.get(currentTrackAtom)?.id).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a mismatch that catches up during verification is NOT a takeover (double-skip race)", async () => {
    vi.useFakeTimers();
    try {
      const { store } = setup();
      store.set(currentTrackAtom, track(3));
      // Stale poll of the intermediate track arrives...
      await fire("sonos-track-changed", {
        trackId: 2,
        trackUri: "x-sonos-http:track%2f2.flac",
      });
      // ...but by verification time the speaker reports our current track.
      invokeMock.mockImplementation((cmd: string) =>
        Promise.resolve(cmd === "sonos_get_now_playing" ? { trackId: 3 } : {}),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });
      expect(store.get(playbackTargetAtom).type).toBe("sonos");
    } finally {
      vi.useRealTimers();
    }
  });

  it("mirrored self-advance adopts the queue entry by qid", async () => {
    const { store } = setup();
    store.set(currentTrackAtom, track(1));
    store.set(isPlayingAtom, true);
    store.set(manualQueueAtom, [track(2), track(3)]);

    await fire("sonos-track-advanced", { trackId: 2, qid: "q2" });

    expect(store.get(currentTrackAtom)?.id).toBe(2);
    expect(store.get(manualQueueAtom).map((t) => t.id)).toEqual([3]);
    expect(store.get(playbackTargetAtom).type).toBe("sonos");
    // No play command — the speaker is already playing it.
    expect(invokeMock.mock.calls.map((c) => c[0])).not.toContain(
      "sonos_play_track",
    );
  });

  it("our own track change (id matches current) is not a takeover", async () => {
    const { store } = setup();
    store.set(currentTrackAtom, track(7));
    await fire("sonos-track-changed", {
      trackId: 7,
      trackUri: "x-sonos-http:track%2f7.flac",
    });
    expect(store.get(playbackTargetAtom).type).toBe("sonos");
  });

  it("session ended (device lost) detaches without auto-playing locally", async () => {
    const { store } = setup();
    store.set(currentTrackAtom, track(1));
    store.set(isPlayingAtom, true);

    await fire("sonos-session-ended", { reason: "deviceLost" });

    expect(store.get(playbackTargetAtom).type).toBe("local");
    expect(store.get(isPlayingAtom)).toBe(false);
    // Detach must never start local audio.
    expect(invokeMock.mock.calls.map((c) => c[0])).not.toContain(
      "play_tidal_track",
    );
  });
});
