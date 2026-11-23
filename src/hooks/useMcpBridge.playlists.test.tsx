import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { ReactNode } from "react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));
const handlers = vi.hoisted(
  () => ({}) as Record<string, (e: { payload: unknown }) => void>,
);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    handlers[name] = cb;
    return Promise.resolve(() => {});
  }),
}));
vi.mock("./usePlaybackActions", () => ({ usePlaybackActions: () => ({}) }));
vi.mock("./usePlaySource", () => ({ usePlaySource: () => vi.fn() }));
vi.mock("../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tidal")>()),
  invalidateCache: vi.fn(),
}));

import { useMcpBridge } from "./useMcpBridge";
import { allPlaylistsAtom } from "../atoms/playlists";
import {
  playlistRevision,
  __resetPlaylistEditsForTests,
} from "../components/tv/tvPlaylistEdits";

let store: ReturnType<typeof createStore>;
const wrapper = ({ children }: { children: ReactNode }) => (
  <Provider store={store}>{children}</Provider>
);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  store = createStore();
  renderHook(() => useMcpBridge(), { wrapper });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  __resetPlaylistEditsForTests();
});

it("tracks added or removed by the MCP server mark the playlist changed", () => {
  handlers["mcp:playlist-tracks-changed"]({
    payload: { uuid: "p", delta: -1 },
  });
  expect(playlistRevision("p")).toBe(1);
  expect(playlistRevision("q")).toBe(0);
});

it("details edited by the MCP server show in the listed playlists, its rows still current", () => {
  store.set(allPlaylistsAtom, [
    { uuid: "p", title: "Old", description: "d0" },
    { uuid: "q", title: "Q" },
  ]);
  handlers["mcp:playlist-updated"]({
    payload: { uuid: "p", title: "New", description: null },
  });
  expect(store.get(allPlaylistsAtom)).toEqual([
    { uuid: "p", title: "New", description: "d0" },
    { uuid: "q", title: "Q" },
  ]);
  handlers["mcp:playlist-updated"]({
    payload: { uuid: "p", title: null, description: "" },
  });
  expect(store.get(allPlaylistsAtom)[0]).toEqual({
    uuid: "p",
    title: "New",
    description: "",
  });
  expect(playlistRevision("p")).toBe(0);
});
