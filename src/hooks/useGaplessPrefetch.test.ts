import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { useGaplessPrefetch } from "./useGaplessPrefetch";
import { currentTrackAtom, queueAtom, gaplessAtom } from "../atoms/playback";
import type { Track } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const DEAD = { id: 42, title: "dead", _qid: "q42" } as unknown as Track;
const LIVE = { id: 43, title: "live", _qid: "q43" } as unknown as Track;

function setup(store: ReturnType<typeof createStore>, predict: () => Track) {
  const pendingNextRef = { current: null };
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(Provider, { store }, children);
  return renderHook(
    () => useGaplessPrefetch(predict, pendingNextRef as never),
    {
      wrapper,
    },
  );
}

function attempts() {
  return vi.mocked(invoke).mock.calls.filter((c) => c[0] === "set_next_track");
}

describe("useGaplessPrefetch failure memo", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("does not re-invoke set_next_track for a track that just failed", async () => {
    const store = createStore();
    store.set(gaplessAtom, true);
    store.set(currentTrackAtom, { id: 1 } as unknown as Track);
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_gapless_supported") return true;
      if (cmd === "set_next_track")
        throw { kind: "Api", message: { status: 429, body: "" } };
      return undefined;
    });

    setup(store, () => DEAD);
    await waitFor(() => expect(attempts()).toHaveLength(1));

    // Simulate the background paginator: one queue write per page, spaced
    // wider than the 250ms debounce so each is a distinct refresh.
    for (let i = 0; i < 5; i++) {
      store.set(queueAtom, [DEAD, ...store.get(queueAtom)]);
      await new Promise((r) => setTimeout(r, 300));
    }

    expect(attempts()).toHaveLength(1);
  });

  it("still attempts a DIFFERENT next track while one is memoized", async () => {
    const store = createStore();
    store.set(gaplessAtom, true);
    store.set(currentTrackAtom, { id: 1 } as unknown as Track);
    let next: Track = DEAD;
    vi.mocked(invoke).mockImplementation(
      async (cmd: string, args?: unknown) => {
        if (cmd === "get_gapless_supported") return true;
        if (cmd === "set_next_track") {
          if ((args as { trackId: number }).trackId === DEAD.id)
            throw { kind: "Api", message: { status: 429, body: "" } };
          return {};
        }
        return undefined;
      },
    );

    setup(store, () => next);
    await waitFor(() => expect(attempts()).toHaveLength(1));

    next = LIVE;
    store.set(queueAtom, [LIVE, ...store.get(queueAtom)]);
    await waitFor(() => expect(attempts()).toHaveLength(2));
    expect(attempts()[1][1]).toMatchObject({ trackId: LIVE.id });
  });
});
