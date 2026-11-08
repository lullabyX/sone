import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useStore } from "jotai";
import { useContext } from "react";
import { invoke } from "@tauri-apps/api/core";

import { TvScreenContext, useTvNav } from "./TvNavContext";
import { authTokensAtom, isAuthenticatedAtom } from "../../atoms/auth";
import { currentTrackAtom, queueAtom } from "../../atoms/playback";
import { normalizePlaylistFolders } from "../../api/tidal";
import {
  deferred,
  makeTvNav,
  mkTrack,
  mockInvoke,
  pressKey,
  range,
  rawFolderItem,
  rawPlaylistItem,
  renderMenuHost,
  renderTv,
  renderTvHook,
  setupTvTest,
  signedIn,
  stubLayout,
  withQueue,
  type Deferred,
} from "./tvTestUtils";
import type { TvStore } from "./tvTestUtils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  getAllPlaylists: vi.fn(async () => ({ items: [] })),
}));

setupTvTest();

describe("tvTestUtils", () => {
  it("renderTv provides a mock nav and an active screen", () => {
    const seen = vi.fn();
    function Probe() {
      seen(useTvNav(), useContext(TvScreenContext));
      return null;
    }
    renderTv(<Probe />);
    const [nav, screenValue] = seen.mock.lastCall!;
    expect(vi.isMockFunction(nav.playTrack)).toBe(true);
    expect(nav.trackMenu(mkTrack(1)).title).toBe("T1");
    expect(screenValue.active).toBe(true);

    renderTv(<Probe />, { active: false });
    expect(seen.mock.lastCall![1].active).toBe(false);
  });

  it("rerender keeps the store and nav", () => {
    const seen = vi.fn();
    function A() {
      return null;
    }
    function B() {
      seen(useTvNav(), useStore());
      return null;
    }
    const r = renderTv(<A />);
    r.rerender(<B />);
    expect(seen.mock.lastCall![0]).toBe(r.nav);
    expect(seen.mock.lastCall![1]).toBe(r.store);
  });

  it("renderTvHook renders inside the same providers", () => {
    const { result, nav } = renderTvHook(() => useTvNav());
    expect(result.current).toBe(nav);
  });

  it("makeTvNav, range and deferred", async () => {
    const back = vi.fn();
    expect(makeTvNav({ back }).back).toBe(back);
    expect(range(3)).toEqual([0, 1, 2]);
    const d: Deferred<number> = deferred<number>();
    d.resolve(5);
    expect(await d.promise).toBe(5);
  });

  it("makeTvNav's playSource resolves true", async () => {
    expect(
      await makeTvNav().playSource({
        meta: { type: "album", id: 1, name: "A" },
        loaded: [],
      }),
    ).toBe(true);
  });

  it("leaves state behind for the next test to check", () => {
    localStorage.setItem("x", "1");
    document.documentElement.className = "tv-mode";
    vi.mocked(invoke).mockResolvedValueOnce(5);
  });

  it("cleans storage, the root class and invoke after each test", async () => {
    expect(localStorage.getItem("x")).toBeNull();
    expect(document.documentElement.className).toBe("");
    expect(await invoke("x")).toBeUndefined();
  });

  it("stubLayout reads data-box at call time and zeroes hidden elements", () => {
    const original = Element.prototype.getBoundingClientRect;
    const restore = stubLayout();
    render(
      <>
        <div data-testid="x" />
        <div className="hidden">
          <span data-testid="y" />
        </div>
      </>,
    );
    screen.getByTestId("x").setAttribute("data-box", "5,6,7,8");
    const r = screen.getByTestId("x").getBoundingClientRect();
    expect([r.left, r.top, r.width, r.height]).toEqual([5, 6, 7, 8]);
    expect(screen.getByTestId("y").getBoundingClientRect().width).toBe(0);
    restore();
    expect(Element.prototype.getBoundingClientRect).toBe(original);
  });

  it("pressKey dispatches a cancelable event and returns it", () => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "a") e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    try {
      expect(pressKey(document.body, { key: "a" }).defaultPrevented).toBe(true);
    } finally {
      window.removeEventListener("keydown", onKey);
    }
    expect(pressKey(document.body, { key: "a" }, "keyup").type).toBe("keyup");
  });

  it("withQueue sets the queue and the current track", () => {
    const store = withQueue([mkTrack(1), mkTrack(2)]);
    expect(store.get(currentTrackAtom)?.title).toBe("T1");
    const queue = store.get(queueAtom);
    expect(queue).toHaveLength(2);
    expect(queue[0]._qid).toBeTruthy();
    expect(queue[1]._qid).toBeTruthy();
    expect(queue[0]._qid).not.toBe(queue[1]._qid);

    const other = withQueue([], mkTrack(9));
    expect(other.get(currentTrackAtom)?.title).toBe("T9");
    expect(other.get(queueAtom)).toEqual([]);
  });

  it("signedIn sets the auth atoms", () => {
    const store: TvStore = signedIn(7);
    expect(store.get(authTokensAtom)?.user_id).toBe(7);
    expect(store.get(isAuthenticatedAtom)).toBe(true);
  });

  it("mockInvoke resolves handled commands and rejects others", async () => {
    mockInvoke({ a: () => 1 });
    await expect(invoke("a")).resolves.toBe(1);
    await expect(invoke("b")).rejects.toThrow("unmocked b");
  });

  it("renderMenuHost opens a menu through its ref", async () => {
    const { ref, store, onPrompt } = renderMenuHost();
    act(() =>
      ref.current!.open({
        title: "M",
        items: [{ label: "X", onSelect: () => {} }],
      }),
    );
    expect(screen.getByRole("menuitem", { name: "X" })).toBeTruthy();
    expect(store.get(authTokensAtom)?.user_id).toBe(42);
    await expect(onPrompt({ title: "", confirm: "" })).resolves.toBeNull();
  });

  it("raw playlist and folder items normalize", () => {
    expect(
      normalizePlaylistFolders({
        lastModifiedAt: "",
        items: [rawFolderItem("f1", "Road", 3), rawPlaylistItem("p1", "One")],
        totalNumberOfItems: 2,
        cursor: null,
      }).items,
    ).toEqual([
      {
        kind: "folder",
        data: expect.objectContaining({
          id: "f1",
          name: "Road",
          totalNumberOfItems: 3,
        }),
      },
      {
        kind: "playlist",
        data: expect.objectContaining({ uuid: "p1", title: "One" }),
      },
    ]);
  });
});
