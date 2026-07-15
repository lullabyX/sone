import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useOverlayBridge } from "./useOverlayBridge";
import {
  overlayConnectionInfoAtom,
  type OverlayConnectionInfo,
} from "../atoms/overlay";
import { currentTrackAtom, isPlayingAtom } from "../atoms/playback";
import type { Track } from "../types";

const track = {
  id: 1,
  title: "Test Song",
  duration: 200,
  album: { id: 2, title: "Test Album", cover: "aaaa-bbbb" },
} as unknown as Track;

function connInfo(enabled: boolean): OverlayConnectionInfo {
  return {
    enabled,
    url: enabled ? "http://127.0.0.1:5578/overlay" : null,
    port: enabled ? 5578 : null,
    host: "127.0.0.1",
  };
}

function mount(enabled: boolean) {
  invokeMock.mockImplementation((cmd: string) =>
    cmd === "overlay_get_connection_info"
      ? Promise.resolve(connInfo(enabled))
      : Promise.resolve(undefined),
  );
  const store = createStore();
  store.set(overlayConnectionInfoAtom, connInfo(enabled));
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>{children}</Provider>
  );
  renderHook(() => useOverlayBridge(), { wrapper });
  return store;
}

const publishCalls = () =>
  invokeMock.mock.calls.filter(([cmd]) => cmd === "overlay_publish_state");

describe("useOverlayBridge", () => {
  beforeEach(() => {
    cleanup();
    invokeMock.mockReset();
  });

  it("does not publish state or theme while the overlay is disabled", async () => {
    const store = mount(false);
    act(() => {
      store.set(currentTrackAtom, track);
      store.set(isPlayingAtom, true);
    });
    await act(async () => {});
    expect(publishCalls()).toHaveLength(0);
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "overlay_publish_theme"),
    ).toHaveLength(0);
  });

  it("publishes track state when the overlay is enabled", async () => {
    const store = mount(true);
    act(() => {
      store.set(currentTrackAtom, track);
    });
    await waitFor(() => expect(publishCalls().length).toBeGreaterThan(0));
    const calls = publishCalls();
    const [, args] = calls[calls.length - 1];
    expect((args as { track: { title: string } }).track.title).toBe(
      "Test Song",
    );
  });

  it("publishes on playback-seeked even while paused", async () => {
    const store = mount(true);
    act(() => {
      store.set(currentTrackAtom, track);
      store.set(isPlayingAtom, false);
    });
    await act(async () => {});
    invokeMock.mockClear();
    act(() => {
      window.dispatchEvent(new CustomEvent("playback-seeked", { detail: 42 }));
    });
    await waitFor(() => expect(publishCalls()).toHaveLength(1));
    const [, args] = publishCalls()[0];
    expect(
      (args as { track: { positionSeconds: number } }).track.positionSeconds,
    ).toBe(42);
  });

  it("uses imageId for video cover art", async () => {
    const store = mount(true);
    const video = {
      id: 3,
      title: "Video",
      duration: 100,
      itemType: "video",
      imageId: "cccc-dddd",
    } as unknown as Track;
    act(() => {
      store.set(currentTrackAtom, video);
    });
    await waitFor(() => expect(publishCalls().length).toBeGreaterThan(0));
    const calls = publishCalls();
    const [, args] = calls[calls.length - 1];
    expect(
      (args as { track: { coverUrl: string } }).track.coverUrl,
    ).toContain("cccc/dddd");
  });
});
