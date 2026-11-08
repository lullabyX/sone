import { fireEvent, screen } from "@testing-library/react";
import { createStore } from "jotai";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { favoriteTrackIdsAtom } from "../../atoms/favorites";
import { isPlayingAtom } from "../../atoms/playback";
import { currentVideoAtom, videoPlayingAtom } from "../../atoms/video";
import type { TidalVideo } from "../../types";
import TvMiniBar from "./TvMiniBar";
import {
  mkTrack,
  mockInvoke,
  renderTv,
  setupTvTest,
  signedIn,
  withQueue,
} from "./tvTestUtils";

const media = vi.hoisted(() => vi.fn());
vi.mock("./useTvMediaCommands", () => ({ useTvMediaCommands: () => media }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

setupTvTest();
beforeEach(() => {
  media.mockReset();
  mockInvoke({});
});

it("shows Pause while a video plays", () => {
  const store = withQueue([], mkTrack(9, { itemType: "video" }));
  store.set(currentVideoAtom, {
    id: 9,
    title: "V",
    duration: 100,
  } as TidalVideo);
  store.set(videoPlayingAtom, true);
  store.set(isPlayingAtom, false);
  renderTv(<TvMiniBar />, { store });
  const pause = screen.getByRole("button", { name: "Pause" });
  expect(pause.hasAttribute("data-tv-focusable")).toBe(true);
  expect(pause.hasAttribute("data-tv-default")).toBe(true);
});

it("opens Now Playing from the track area", () => {
  const { nav } = renderTv(<TvMiniBar />, { store: withQueue([], mkTrack(1)) });
  fireEvent.click(screen.getByRole("button", { name: "Open Now Playing" }));
  expect(nav.openNowPlaying).toHaveBeenCalled();
});

it("sends transport commands", () => {
  renderTv(<TvMiniBar />, { store: withQueue([], mkTrack(1)) });
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(media.mock.calls.map((c) => c[0].kind)).toEqual([
    "previous",
    "toggle",
    "next",
  ]);
});

it("renders nothing without a track", () => {
  const { container } = renderTv(<TvMiniBar />, { store: createStore() });
  expect(container.firstChild).toBeNull();
});

it("loves the playing track and takes it out again", async () => {
  mockInvoke({
    add_favorite_track: () => undefined,
    remove_favorite_track: () => undefined,
  });
  const store = signedIn(7, withQueue([], mkTrack(3)));
  renderTv(<TvMiniBar />, { store });
  fireEvent.click(screen.getByRole("button", { name: "Add to Loved Tracks" }));
  expect(store.get(favoriteTrackIdsAtom).has(3)).toBe(true);
  expect(invoke).toHaveBeenCalledWith("add_favorite_track", {
    userId: 7,
    trackId: 3,
  });
  const remove = await screen.findByRole("button", {
    name: "Remove from Loved Tracks",
  });
  expect(remove.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(remove);
  expect(store.get(favoriteTrackIdsAtom).has(3)).toBe(false);
});
