import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { Provider, createStore } from "jotai";

const invoke = vi.hoisted(() => vi.fn());
const handlers = vi.hoisted(() => ({}) as Record<string, () => void>);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: () => void) => {
    handlers[name] = cb;
    return Promise.resolve(() => {});
  }),
}));

// getOnInit reads storage when the atom module is evaluated, so a reload needs fresh modules.
async function load() {
  vi.resetModules();
  const { tvModeAtom } = await import("../atoms/tv");
  const { useTvLaunch } = await import("./useTvLaunch");
  const store = createStore();
  function H() {
    useTvLaunch();
    return null;
  }
  return {
    tvModeAtom,
    store,
    mount: () =>
      render(
        <Provider store={store}>
          <H />
        </Provider>,
      ),
  };
}

describe("useTvLaunch", () => {
  beforeEach(() => {
    invoke.mockReset();
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("turns TV mode on for this run without saving it", async () => {
    invoke.mockResolvedValue(true);
    const { tvModeAtom, store, mount } = await load();
    mount();
    await act(async () => {});
    expect(store.get(tvModeAtom)).toBe(true);
    expect(localStorage.getItem("sone.tvMode.v1")).not.toBe("true");
    expect(JSON.parse(sessionStorage.getItem("sone.tvLaunch.v1")!)).toBe("on");
  });

  it("does not re-apply the flag after a reload once the user exited", async () => {
    sessionStorage.setItem("sone.tvLaunch.v1", JSON.stringify("off"));
    invoke.mockResolvedValue(true);
    const { tvModeAtom, store, mount } = await load();
    mount();
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalledWith("get_launch_tv_mode");
    expect(store.get(tvModeAtom)).toBe(false);
  });

  it("keeps TV mode across a reload while not exited", async () => {
    sessionStorage.setItem("sone.tvLaunch.v1", JSON.stringify("on"));
    const { tvModeAtom, store } = await load();
    expect(store.get(tvModeAtom)).toBe(true);
  });

  it("Exit TV mode ends the launch override and the saved preference", async () => {
    invoke.mockResolvedValue(true);
    const { tvModeAtom, store, mount } = await load();
    mount();
    await act(async () => {});
    act(() => store.set(tvModeAtom, false));
    expect(store.get(tvModeAtom)).toBe(false);
    expect(JSON.parse(sessionStorage.getItem("sone.tvLaunch.v1")!)).toBe(
      "off",
    );
  });

  it("a late flag answer does not undo an exit made before it arrived", async () => {
    let resolve!: (v: boolean) => void;
    invoke.mockReturnValue(new Promise<boolean>((r) => (resolve = r)));
    const { tvModeAtom, store, mount } = await load();
    mount();
    act(() => store.set(tvModeAtom, false));
    await act(async () => resolve(true));
    expect(store.get(tvModeAtom)).toBe(false);
  });

  it("`sone --tv` from a second instance switches on for this run only", async () => {
    invoke.mockResolvedValue(false);
    const { tvModeAtom, store, mount } = await load();
    mount();
    await act(async () => {});
    act(() => handlers["tv-mode:enter"]());
    expect(store.get(tvModeAtom)).toBe(true);
    expect(localStorage.getItem("sone.tvMode.v1")).not.toBe("true");
  });

  it("the user-menu toggle still persists", async () => {
    const { tvModeAtom, store } = await load();
    act(() => store.set(tvModeAtom, true));
    expect(localStorage.getItem("sone.tvMode.v1")).toBe("true");
  });
});
