import { beforeEach, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { isPlayingAtom } from "../atoms/playback";
import { tvModeAtom } from "../atoms/tv";
import { maximizedPlayerAtom } from "../atoms/ui";
import {
  currentVideoAtom,
  videoExpandedAtom,
  videoFullscreenAtom,
  videoPlayingAtom,
} from "../atoms/video";
import type { TidalVideo } from "../types";
import { mockInvoke, setupTvTest } from "../components/tv/tvTestUtils";
import { useIdleInhibit } from "./useIdleInhibit";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
setupTvTest();
beforeEach(() => mockInvoke({ set_idle_inhibit: () => undefined }));

function Host() {
  useIdleInhibit();
  return null;
}

let store: ReturnType<typeof createStore>;
const mount = () => {
  store = createStore();
  render(
    <Provider store={store}>
      <Host />
    </Provider>,
  );
};

const last = () => {
  const calls = vi
    .mocked(invoke)
    .mock.calls.filter((c) => c[0] === "set_idle_inhibit");
  const { sleep, screen } = calls[calls.length - 1][1] as {
    sleep: boolean;
    screen: boolean;
  };
  return { sleep, screen };
};

const playVideo = () => {
  store.set(currentVideoAtom, { id: 1 } as TidalVideo);
  store.set(videoPlayingAtom, true);
};

it("holds nothing when nothing plays", () => {
  mount();
  expect(last()).toEqual({ sleep: false, screen: false });
});

it("keeps the computer awake but lets the screen off while playing in a window", () => {
  mount();
  act(() => store.set(isPlayingAtom, true));
  expect(last()).toEqual({ sleep: true, screen: false });
});

it("keeps the screen on while playing in the fullscreen player", () => {
  mount();
  act(() => {
    store.set(maximizedPlayerAtom, true);
    store.set(isPlayingAtom, true);
  });
  expect(last()).toEqual({ sleep: true, screen: true });
});

it("keeps the screen on while playing in TV mode", () => {
  mount();
  act(() => {
    store.set(tvModeAtom, true);
    store.set(isPlayingAtom, true);
  });
  expect(last()).toEqual({ sleep: true, screen: true });
});

it("releases both when paused in the fullscreen player or TV mode", () => {
  mount();
  act(() => {
    store.set(maximizedPlayerAtom, true);
    store.set(tvModeAtom, true);
    store.set(isPlayingAtom, true);
  });
  act(() => store.set(isPlayingAtom, false));
  expect(last()).toEqual({ sleep: false, screen: false });
});

it("keeps the screen on while a video plays on screen", () => {
  mount();
  act(() => {
    playVideo();
    store.set(videoExpandedAtom, true);
  });
  expect(last()).toEqual({ sleep: true, screen: true });
  act(() => {
    store.set(videoExpandedAtom, false);
    store.set(videoFullscreenAtom, true);
  });
  expect(last()).toEqual({ sleep: true, screen: true });
});

it("a video minimized to the player bar keeps only the computer awake", () => {
  mount();
  act(() => playVideo());
  expect(last()).toEqual({ sleep: true, screen: false });
});

it("a stale videoPlaying after the video closed holds nothing", () => {
  mount();
  act(() => {
    store.set(videoPlayingAtom, true);
    store.set(videoExpandedAtom, true);
  });
  expect(last()).toEqual({ sleep: false, screen: false });
});

it("each call outranks the one before it", () => {
  mount();
  act(() => store.set(isPlayingAtom, true));
  act(() => store.set(isPlayingAtom, false));
  const seqs = vi
    .mocked(invoke)
    .mock.calls.filter((c) => c[0] === "set_idle_inhibit")
    .map((c) => (c[1] as { seq: number }).seq);
  expect(seqs.length).toBeGreaterThanOrEqual(3);
  for (let i = 1; i < seqs.length; i++)
    expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
});
