import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";
import { videoCoversAtom } from "../atoms/ui";

// TidalImage proxies image bytes via Tauri — stub the bridge.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
}));

import TidalVideoCover from "./TidalVideoCover";

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

describe("TidalVideoCover", () => {
  it("renders a direct-streaming <video> with the CDN url when enabled and a videoCover exists", () => {
    const { container } = renderWith(true, {
      cover: "c-1",
      videoCover: "11-22",
    });
    expect(container.querySelector("video")?.getAttribute("src")).toBe(
      "https://resources.tidal.com/videos/11/22/1280x1280.mp4",
    );
    expect(container.querySelector("video")?.getAttribute("poster")).toBe(
      "https://resources.tidal.com/images/c/1/1280x1280.jpg",
    );
  });

  it("uses the origin url when size is 'origin'", () => {
    const { container } = renderWith(
      true,
      { cover: "c-1", videoCover: "11-22" },
      "origin",
    );
    expect(container.querySelector("video")?.getAttribute("src")).toBe(
      "https://resources.tidal.com/videos/11/22/origin.mp4",
    );
  });

  it("renders no <video> when the setting is disabled", () => {
    const { container } = renderWith(false, {
      cover: "c-1",
      videoCover: "11-22",
    });
    expect(container.querySelector("video")).toBeNull();
  });

  it("renders no <video> when there is no videoCover", () => {
    const { container } = renderWith(true, { cover: "c-1" });
    expect(container.querySelector("video")).toBeNull();
  });
});
