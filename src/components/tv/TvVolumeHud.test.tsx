import { act, screen } from "@testing-library/react";
import { createStore } from "jotai";
import { expect, it, vi } from "vitest";
import { volumeAtom } from "../../atoms/playback";
import { tvVolumeLockedPingAtom } from "../../atoms/tv";
import TvVolumeHud from "./TvVolumeHud";
import { renderTv, setupTvTest } from "./tvTestUtils";

setupTvTest();

it("stays hidden at mount and shows each later change for 2 s", () => {
  vi.useFakeTimers();
  const store = createStore();
  store.set(volumeAtom, 0.5);
  renderTv(<TvVolumeHud />, { store });
  expect(screen.queryByRole("status")).toBeNull();
  act(() => store.set(volumeAtom, 0.55));
  expect(screen.getByRole("status").textContent).toContain("55%");
  act(() => vi.advanceTimersByTime(1500));
  act(() => store.set(volumeAtom, 0.6));
  act(() => vi.advanceTimersByTime(1500));
  expect(screen.getByRole("status").textContent).toContain("60%");
  act(() => vi.advanceTimersByTime(600));
  expect(screen.queryByRole("status")).toBeNull();
});

it("shows mute as muted", () => {
  const { store } = renderTv(<TvVolumeHud />);
  act(() => store.set(volumeAtom, 0));
  expect(screen.getByRole("status").hasAttribute("data-muted")).toBe(true);
});

it("explains a locked volume", () => {
  const { store } = renderTv(<TvVolumeHud />);
  act(() => store.set(tvVolumeLockedPingAtom, 1));
  expect(screen.getByRole("status").textContent).toContain(
    "Volume fixed · bit-perfect output",
  );
});

it("never takes focus", () => {
  const { store } = renderTv(<TvVolumeHud />);
  act(() => store.set(volumeAtom, 0.3));
  const status = screen.getByRole("status");
  expect(
    status.querySelector("button, [tabindex], [data-tv-focusable]"),
  ).toBeNull();
  expect(status.closest("[data-tv-modal]")).toBeNull();
  expect(status.parentElement!.className).toContain("pointer-events-none");
});
