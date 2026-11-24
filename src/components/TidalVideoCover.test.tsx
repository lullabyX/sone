import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";
import { videoCoversAtom } from "../atoms/ui";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import TidalVideoCover from "./TidalVideoCover";
import { _resetVideoCoverCache } from "../lib/videoCoverCache";

let blobN = 0;
beforeEach(() => {
  _resetVideoCoverCache();
  invoke.mockReset();
  invoke.mockResolvedValue(new ArrayBuffer(8));
  URL.createObjectURL = vi.fn(() => `blob:test-${++blobN}`);
  URL.revokeObjectURL = vi.fn();
});

function renderWith(
  enabled: boolean,
  props: { cover?: string; videoCover?: string },
  size: number | "origin" = 1280,
) {
  const store = createStore();
  store.set(videoCoversAtom, enabled);
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>{children}</Provider>
  );
  return render(<TidalVideoCover size={size} alt="cover" {...props} />, {
    wrapper,
  });
}

function videoCalls() {
  return invoke.mock.calls.filter((c) => c[0] === "get_video_cover_bytes");
}

describe("TidalVideoCover", () => {
  it("plays the displayed-resolution video from an in-memory blob", async () => {
    const { container } = renderWith(true, {
      cover: "c-1",
      videoCover: "11-22",
    });
    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toMatch(
        /^blob:test-/,
      ),
    );
    expect(videoCalls()).toEqual([
      [
        "get_video_cover_bytes",
        { url: "https://resources.tidal.com/videos/11/22/1280x1280.mp4" },
      ],
    ]);
  });

  it("fetches the origin url when size is 'origin'", async () => {
    renderWith(true, { cover: "c-1", videoCover: "11-22" }, "origin");
    await waitFor(() =>
      expect(videoCalls()[0]?.[1]).toEqual({
        url: "https://resources.tidal.com/videos/11/22/origin.mp4",
      }),
    );
  });

  it("keeps showing the static art when the video fetch fails", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_video_cover_bytes"
        ? Promise.reject(new Error("offline"))
        : Promise.resolve(new ArrayBuffer(0)),
    );
    const { container } = renderWith(true, {
      cover: "c-1",
      videoCover: "11-22",
    });
    await waitFor(() => expect(videoCalls().length).toBe(1));
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")).not.toBeNull();
  });

  function setTimes(el: HTMLVideoElement, currentTime: number, duration = 10) {
    Object.defineProperty(el, "currentTime", {
      value: currentTime,
      configurable: true,
    });
    Object.defineProperty(el, "duration", {
      value: duration,
      configurable: true,
    });
  }

  async function mounted() {
    const r = renderWith(true, { cover: "c-1", videoCover: "11-22" });
    await waitFor(() =>
      expect(r.container.querySelectorAll("video")).toHaveLength(1),
    );
    return r;
  }

  it("loops by handing off to a copy loaded near the end, not the native loop", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    const { container } = await mounted();
    const active = container.querySelector("video")!;
    expect(active.hasAttribute("loop")).toBe(false);

    setTimes(active, 5);
    fireEvent.timeUpdate(active);
    expect(container.querySelectorAll("video")).toHaveLength(1);
    setTimes(active, 8.5);
    fireEvent.timeUpdate(active);
    const [standby] = container.querySelectorAll("video");
    expect(standby).not.toBe(active);
    expect(standby.hasAttribute("autoplay")).toBe(false);
    expect(standby.style.opacity).toBe("0");

    fireEvent.ended(active);
    expect(play.mock.contexts).toEqual([standby]);
    // Not swapped until the standby has actually advanced.
    await new Promise((r) => setTimeout(r, 50));
    expect(active.isConnected).toBe(true);
    setTimes(standby, 0.1);

    await waitFor(() => expect(active.isConnected).toBe(false));
    expect([...container.querySelectorAll("video")]).toEqual([standby]);
    expect(standby.style.opacity).not.toBe("0");
    play.mockRestore();
  });

  it("releases a video's decoder when it unmounts", async () => {
    const load = vi
      .spyOn(HTMLMediaElement.prototype, "load")
      .mockImplementation(() => {});
    const { container, unmount } = await mounted();
    const video = container.querySelector("video")!;
    unmount();
    expect(video.hasAttribute("src")).toBe(false);
    expect(load.mock.contexts).toContain(video);
    load.mockRestore();
  });

  it("fades the video in only once playback is past its first frames", async () => {
    const { container } = await mounted();
    const active = container.querySelector("video")!;
    const layer = active.parentElement!;
    fireEvent.playing(active);
    setTimes(active, 0);
    fireEvent.timeUpdate(active);
    expect(layer.className).toContain("opacity-0");
    setTimes(active, 0.2);
    fireEvent.timeUpdate(active);
    expect(layer.className).toContain("opacity-100");
  });

  it("falls back to the static art when the video keeps failing to load", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    const { container } = await mounted();
    const active = container.querySelector("video")!;
    for (let i = 0; i < 10; i++) fireEvent.error(active);
    expect(play).toHaveBeenCalledTimes(10);
    expect(container.querySelector("video")).not.toBeNull();
    fireEvent.error(active);
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")).not.toBeNull();
    play.mockRestore();
  });

  it("renders no <video> and fetches nothing when the setting is disabled", () => {
    const { container } = renderWith(false, {
      cover: "c-1",
      videoCover: "11-22",
    });
    expect(container.querySelector("video")).toBeNull();
    expect(videoCalls()).toEqual([]);
  });

  it("renders no <video> when there is no videoCover", () => {
    const { container } = renderWith(true, { cover: "c-1" });
    expect(container.querySelector("video")).toBeNull();
    expect(videoCalls()).toEqual([]);
  });
});
