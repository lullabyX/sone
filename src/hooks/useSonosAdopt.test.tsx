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
  userPausedAtom,
} from "../atoms/playback";
import type { Track } from "../types";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

const track = (id: number, qid = `q${id}`): Track =>
  ({
    id,
    title: `Song ${id}`,
    duration: 200,
    album: { title: "Album" },
    artist: { name: "Artist" },
    _qid: qid,
  }) as unknown as Track;

function setup() {
  const store = createStore();
  store.set(playbackTargetAtom, {
    type: "sonos",
    coordinatorUuid: "RINCON_TEST",
    coordinatorIp: "192.168.1.10",
    roomName: "Office",
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>
      <ToastProvider>{children}</ToastProvider>
    </Provider>
  );
  const { result } = renderHook(() => usePlaybackActions(), { wrapper });
  return { store, result };
}

describe("adoptRemoteTrack reconciles speaker-side track changes", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({});
  });

  it("echo of the current track is a no-op success", () => {
    const { store, result } = setup();
    store.set(currentTrackAtom, track(1));
    let adopted = false;
    act(() => {
      adopted = result.current.adoptRemoteTrack(1, "q1");
    });
    expect(adopted).toBe(true);
    expect(store.get(currentTrackAtom)?.id).toBe(1);
  });

  it("mirrored self-advance: consumes the manual-queue head by qid", () => {
    const { store, result } = setup();
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
    expect(invokeMock.mock.calls.map((c) => c[0])).toContain(
      "notify_track_started",
    );
  });

  it("external forward jump: skipped entries land in history, originalQueue pruned", () => {
    const { store, result } = setup();
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
    const { store, result } = setup();
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
    const { store, result } = setup();
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
