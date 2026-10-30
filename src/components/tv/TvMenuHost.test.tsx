import { act, fireEvent, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TvMenuHostHandle } from "./TvMenuHost";
import type { TvMenuSpec } from "./tvMenu";
import { renderMenuHost, setupTvTest, stubLayout } from "./tvTestUtils";

setupTvTest();
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
import { invoke } from "@tauri-apps/api/core";
const api = vi.hoisted(() => ({ getAllPlaylists: vi.fn(async () => ({ items: [] })) }));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()), ...api }));
beforeEach(() => vi.mocked(invoke).mockImplementation(() => Promise.resolve(undefined)));

describe("focus and late submenus", () => {
  let ref: RefObject<TvMenuHostHandle | null>;
  let opener: HTMLElement;
  let restore: () => void;
  beforeEach(() => {
    restore = stubLayout();
    opener = document.body.appendChild(Object.assign(document.createElement("button"), { textContent: "opener" }));
    ({ ref } = renderMenuHost());
    opener.focus();
  });
  afterEach(() => { restore(); opener.remove(); });
  const credits = (set: (r: (s: TvMenuSpec) => void) => void): TvMenuSpec =>
    ({ title: "M", items: [{ label: "Credits", submenu: () => new Promise<TvMenuSpec>((r) => set(r)) }] });

  it("runs an entry with focus back on the element that opened the menu", () => {
    let seen: Element | null = null;
    act(() => ref.current!.open({ title: "M", items: [{ label: "Go", onSelect: () => void (seen = document.activeElement) }] }));
    act(() => fireEvent.click(screen.getByRole("menuitem", { name: "Go" })));
    expect(seen).toBe(opener);
  });
  it("drops a submenu that finishes loading after Back", async () => {
    let resolve!: (s: TvMenuSpec) => void;
    act(() => ref.current!.open(credits((r) => (resolve = r))));
    act(() => fireEvent.click(screen.getByRole("menuitem", { name: "Credits" })));
    act(() => ref.current!.back());
    await act(async () => resolve({ title: "Credits list", items: [] }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it("drops a submenu that finishes after another menu opened", async () => {
    let resolve!: (s: TvMenuSpec) => void;
    act(() => ref.current!.open(credits((r) => (resolve = r))));
    act(() => fireEvent.click(screen.getByRole("menuitem", { name: "Credits" })));
    act(() => ref.current!.open({ title: "Other", items: [{ label: "X", onSelect() {} }] }));
    await act(async () => resolve({ title: "Credits list", items: [] }));
    expect(screen.getByRole("menu", { name: "Other" })).toBeTruthy();
    expect(screen.queryByRole("menu", { name: "Credits list" })).toBeNull();
  });
  it("a pending submenu never blocks the menu opened meanwhile", async () => {
    let resolve!: (s: TvMenuSpec) => void;
    const x = vi.fn();
    act(() => ref.current!.open(credits((r) => (resolve = r))));
    act(() => fireEvent.click(screen.getByRole("menuitem", { name: "Credits" })));
    act(() => ref.current!.open({ title: "Other", items: [{ label: "X", onSelect: x }] }));
    act(() => fireEvent.click(screen.getByRole("menuitem", { name: "X" })));
    expect(x).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ title: "Credits list", items: [] }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
