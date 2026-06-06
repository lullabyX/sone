import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";

// VolumeSlider -> usePlaybackActions -> invoke("set_volume"). Mock the Tauri
// bridge so setVolume's store.set still runs but the IPC call is a no-op.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import VolumeSlider from "./VolumeSlider";
import { volumeAtom, bitPerfectAtom } from "../atoms/playback";
// usePlaybackActions (used by VolumeSlider) calls useToast(), which throws
// outside a ToastProvider — so the rendered tree must be wrapped in it.
import { ToastProvider } from "../contexts/ToastContext";

function setup(initial: { volume?: number; bitPerfect?: boolean } = {}) {
  const store = createStore();
  store.set(volumeAtom, initial.volume ?? 0.5);
  store.set(bitPerfectAtom, initial.bitPerfect ?? false);
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>
      <ToastProvider>{children}</ToastProvider>
    </Provider>
  );
  const { container } = render(<VolumeSlider />, { wrapper });
  // Outer container div is where the wheel listener lives.
  const el = container.firstChild as Element;
  return { store, el };
}

describe("VolumeSlider scroll-to-adjust", () => {
  it("raises volume by 0.05 on scroll up", () => {
    const { store, el } = setup({ volume: 0.5 });
    fireEvent.wheel(el, { deltaY: -100 });
    expect(store.get(volumeAtom)).toBeCloseTo(0.55, 5);
  });

  it("lowers volume by 0.05 on scroll down", () => {
    const { store, el } = setup({ volume: 0.5 });
    fireEvent.wheel(el, { deltaY: 100 });
    expect(store.get(volumeAtom)).toBeCloseTo(0.45, 5);
  });

  it("clamps at 1 when scrolling up near the top", () => {
    const { store, el } = setup({ volume: 0.98 });
    fireEvent.wheel(el, { deltaY: -100 });
    expect(store.get(volumeAtom)).toBe(1);
  });

  it("clamps at 0 when scrolling down near the bottom", () => {
    const { store, el } = setup({ volume: 0.02 });
    fireEvent.wheel(el, { deltaY: 100 });
    expect(store.get(volumeAtom)).toBe(0);
  });

  it("ignores scroll while bit-perfect is active", () => {
    const { store, el } = setup({ volume: 0.5, bitPerfect: true });
    fireEvent.wheel(el, { deltaY: -100 });
    expect(store.get(volumeAtom)).toBe(0.5);
  });

  it("reads the latest volume across successive scrolls (no stale closure)", () => {
    const { store, el } = setup({ volume: 0.5 });
    fireEvent.wheel(el, { deltaY: -100 });
    fireEvent.wheel(el, { deltaY: -100 });
    expect(store.get(volumeAtom)).toBeCloseTo(0.6, 5);
  });

  it("prevents default page scroll when adjusting volume", () => {
    const { el } = setup({ volume: 0.5 });
    expect(fireEvent.wheel(el, { deltaY: -100 })).toBe(false);
  });

  it("does not prevent default while bit-perfect is active", () => {
    const { el } = setup({ volume: 0.5, bitPerfect: true });
    expect(fireEvent.wheel(el, { deltaY: -100 })).toBe(true);
  });
});
