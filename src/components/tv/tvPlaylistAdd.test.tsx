import { act } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getPlaylistRecommendations } from "../../api/tidal";
import { useTvPlaylistAdd } from "./tvPlaylistAdd";
import { playlistRevision } from "./tvPlaylistEdits";
import { mkTrack, mockInvoke, renderTvHook, setupTvTest } from "./tvTestUtils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

setupTvTest();

const recCalls = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([c]) => c === "get_playlist_recommendations").length;

it("an added track drops the playlist's cached recommendations and marks its pages out of date", async () => {
  mockInvoke({
    get_playlist_recommendations: () => ({ items: [mkTrack(1)] }),
    add_tracks_to_playlist: ({ trackIds }: { trackIds: number[] }) => trackIds,
    get_playlist_folders: () => ({
      items: [],
      totalNumberOfItems: 0,
      cursor: null,
    }),
  });
  const { result } = renderTvHook(() => useTvPlaylistAdd(vi.fn()));
  await getPlaylistRecommendations("p", 0, 50);
  await getPlaylistRecommendations("p", 0, 50);
  expect(recCalls()).toBe(1);
  let added = false;
  await act(async () => {
    added = await result.current.addOrOffer(
      { uuid: "p", title: "P" },
      mkTrack(1),
    );
  });
  expect(added).toBe(true);
  expect(playlistRevision("p")).toBe(1);
  await getPlaylistRecommendations("p", 0, 50);
  expect(recCalls()).toBe(2);
});

it("a track already there opens the Already in menu instead", async () => {
  mockInvoke({
    add_tracks_to_playlist: () => [],
    get_playlist_folders: () => ({
      items: [],
      totalNumberOfItems: 0,
      cursor: null,
    }),
  });
  const openMenu = vi.fn();
  const { result } = renderTvHook(() => useTvPlaylistAdd(openMenu));
  let added = true;
  await act(async () => {
    added = await result.current.addOrOffer(
      { uuid: "p", title: "A very long playlist name that gets cut" },
      mkTrack(1),
    );
  });
  expect(added).toBe(false);
  expect(openMenu.mock.lastCall![0]).toMatchObject({
    title: 'Already in "A very long playlist name that…"',
    subtitle: "T1",
  });
});
