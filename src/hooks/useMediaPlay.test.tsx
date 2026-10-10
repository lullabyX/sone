import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, screen, cleanup } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";
import { useMediaPlay } from "./useMediaPlay";
import { ToastProvider } from "../contexts/ToastContext";
import { allowExplicitAtom, currentTrackAtom } from "../atoms/playback";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve({})),
}));

function setup() {
  const store = createStore();
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>
      <ToastProvider>{children}</ToastProvider>
    </Provider>
  );
  const { result } = renderHook(() => useMediaPlay(), { wrapper });
  return { store, result };
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

describe("useMediaPlay video", () => {
  it("returns false for an explicit video when explicit is off", async () => {
    const { store, result } = setup();
    store.set(allowExplicitAtom, false);
    let res: boolean | undefined;
    await act(async () => {
      res = await result.current({
        type: "video",
        id: 5,
        title: "V",
        explicit: true,
      });
    });
    expect(res).toBe(false);
    expect(store.get(currentTrackAtom)).toBeNull();
    expect(
      screen.getByText("Explicit content is turned off in Settings"),
    ).toBeTruthy();
  });
});
