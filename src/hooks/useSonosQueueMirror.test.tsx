import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";
import { useSonosQueueMirror } from "./useSonosQueueMirror";
import {
  currentTrackAtom,
  manualQueueAtom,
  playbackTargetAtom,
  queueAtom,
  repeatAtom,
} from "../atoms/playback";
import type { Track } from "../types";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const track = (id: number): Track =>
  ({
    id,
    title: `Song ${id}`,
    album: { title: "Album" },
    artist: { name: "Artist" },
    _qid: `q${id}`,
  }) as unknown as Track;

function setup(remote = true) {
  const store = createStore();
  store.set(currentTrackAtom, track(1));
  if (remote) {
    store.set(playbackTargetAtom, {
      type: "sonos",
      coordinatorUuid: "RINCON_TEST",
      roomName: "Office",
    });
  }
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>{children}</Provider>
  );
  renderHook(() => useSonosQueueMirror(), { wrapper });
  return { store };
}

const syncCalls = () =>
  invokeMock.mock.calls.filter((c) => c[0] === "sonos_sync_queue_tail");

describe("useSonosQueueMirror", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({});
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mirrors manual + context queue as the tail, in play order", async () => {
    const { store } = setup();
    await act(async () => {
      store.set(manualQueueAtom, [track(2)]);
      store.set(queueAtom, [track(3), track(4)]);
      await vi.advanceTimersByTimeAsync(2000);
    });
    const calls = syncCalls();
    const last = calls[calls.length - 1];
    expect(last?.[1].tracks.map((t: { trackId: number }) => t.trackId)).toEqual(
      [2, 3, 4],
    );
    expect(last?.[1].tracks[0]).toMatchObject({
      qid: "q2",
      meta: { title: "Song 2", album: "Album" },
    });
  });

  it("repeat-one mirrors an EMPTY tail so the speaker never self-advances", async () => {
    const { store } = setup();
    await act(async () => {
      store.set(queueAtom, [track(3)]);
      store.set(repeatAtom, 2);
      await vi.advanceTimersByTimeAsync(2000);
    });
    const calls = syncCalls();
    const last = calls[calls.length - 1];
    expect(last?.[1].tracks).toEqual([]);
  });

  it("does not sync while the target is local", async () => {
    const { store } = setup(false);
    await act(async () => {
      store.set(queueAtom, [track(3)]);
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(syncCalls()).toHaveLength(0);
  });
});
