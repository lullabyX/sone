import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { createStore } from "jotai";

const auth = vi.hoisted(() => ({ userName: "Ann", logout: vi.fn() })); // one object: useAuth keeps stable identities
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(() => Promise.resolve("1.2.3")),
}));
vi.mock("../../hooks/useAuth", () => ({ useAuth: () => auth }));

import {
  mkTrack,
  mockInvoke,
  renderTv,
  setupTvTest,
  stubLayout,
  deferred,
  withQueue,
} from "./tvTestUtils";
import TvSettings from "./TvSettings";
import type { TvNav } from "./TvNavContext";
import { videoCoversAtom } from "../../atoms/ui";
import {
  tvOverscanAtom,
  tvTextSizeAtom,
  tvVolumeOnTvAtom,
} from "../../atoms/tv";
import {
  bitPerfectAtom,
  exclusiveModeAtom,
  volumeAtom,
} from "../../atoms/playback";
import { updateInfoAtom } from "../../atoms/updates";
import { moveFocus } from "../../lib/spatialNav";

setupTvTest();
let devices: { id: string; name: string }[] = [];
beforeEach(() => {
  devices = [];
  mockInvoke({
    get_gapless_supported: () => false,
    list_audio_devices: () => devices,
    set_exclusive_device: () => undefined,
  });
});
const labels = (nav: TvNav) =>
  vi.mocked(nav.openMenu).mock.calls[0][0].items.map((i) => i.label);

it("asks before logging out, with Cancel first", () => {
  const { nav } = renderTv(<TvSettings />);
  fireEvent.click(screen.getByRole("button", { name: /Signed in as Ann/ }));
  expect(labels(nav)).toEqual(["Cancel", "Log out"]);
});

it("asks before turning explicit content off while something plays, with Cancel first", () => {
  const store = withQueue([mkTrack(1), mkTrack(2)], mkTrack(1));
  const { nav } = renderTv(<TvSettings />, { store });
  fireEvent.click(
    screen.getByRole("button", { name: /Allow explicit content/ }),
  );
  expect(labels(nav)).toEqual(["Cancel", "Yes, turn off"]);
});

it("groups the content filters under Content", () => {
  renderTv(<TvSettings />);
  const content = screen
    .getByRole("heading", { name: "Content" })
    .closest("section")!;
  expect(
    within(content).getByRole("button", { name: /Allow explicit content/ }),
  ).toBeTruthy();
  expect(
    within(content).getByRole("button", { name: /Allow AI content/ }),
  ).toBeTruthy();
});

it("Down from Log out moves focus into About and on to the release QR", async () => {
  const restore = stubLayout();
  try {
    const store = createStore();
    store.set(updateInfoAtom, {
      available: true,
      current: "1.2.3",
      latest: "1.3.0",
      url: "https://github.com/x/releases/tag/v1.3.0",
    });
    const { container } = renderTv(<TvSettings />, { store });
    await screen.findByText("1.2.3");
    container
      .querySelectorAll<HTMLElement>("[data-tv-focusable]")
      .forEach((el, i) => el.setAttribute("data-box", `0,${i * 20},100,10`));

    act(() => screen.getByRole("button", { name: /signed in/i }).focus());
    act(() => {
      moveFocus(container, "down");
    });
    expect(document.activeElement?.textContent).toMatch(/^SONE/);
    act(() => {
      moveFocus(container, "down");
    });
    expect(document.activeElement?.textContent).toMatch(/update available/i);
    act(() => {
      moveFocus(container, "down");
    });
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Release page QR code",
    );
  } finally {
    restore();
  }
});

it("toggles animated covers", () => {
  const { store } = renderTv(<TvSettings />);
  fireEvent.click(
    screen.getByRole("button", { name: /Animated album covers/ }),
  );
  expect(store.get(videoCoversAtom)).toBe(false);
});

it("switches the text size between Normal and Large", () => {
  const { store } = renderTv(<TvSettings />);
  const row = screen.getByRole("button", { name: /Text size/ });
  expect(row.textContent).toContain("Normal");
  fireEvent.click(row);
  expect(store.get(tvTextSizeAtom)).toBe("large");
  expect(row.textContent).toContain("Large");
  fireEvent.click(row);
  expect(store.get(tvTextSizeAtom)).toBe("normal");
});

it("calibrates the screen margin with the arrows, OK keeps it", () => {
  const { store } = renderTv(<TvSettings />);
  const row = screen.getByRole("button", { name: /Screen margin/ });
  expect(row.textContent).toContain("Off");
  fireEvent.click(row);
  const frame = screen.getByLabelText(/^Screen margin:/);
  expect(document.activeElement).toBe(frame);
  for (const key of ["ArrowLeft", "ArrowLeft", "ArrowDown"]) {
    fireEvent.keyDown(frame, { key });
  }
  // Live while calibrating: the interface already uses it.
  expect(store.get(tvOverscanAtom)).toEqual({ x: 1, y: 0.5 });
  fireEvent.keyDown(frame, { key: "Enter" });
  expect(screen.queryByLabelText(/^Screen margin:/)).toBeNull();
  expect(store.get(tvOverscanAtom)).toEqual({ x: 1, y: 0.5 });
  expect(row.textContent).toContain("1 % × 0.5 %");
});

it("Back leaves calibration with the old margin, which stays within 0–10 %", () => {
  const store = createStore();
  store.set(tvOverscanAtom, { x: 9.5, y: 0 });
  renderTv(<TvSettings />, { store });
  fireEvent.click(screen.getByRole("button", { name: /Screen margin/ }));
  const frame = screen.getByLabelText(/^Screen margin:/);
  for (const key of ["ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowUp"]) {
    fireEvent.keyDown(frame, { key });
  }
  expect(store.get(tvOverscanAtom)).toEqual({ x: 10, y: 0 });
  fireEvent.keyDown(frame, { key: "BrowserBack" });
  expect(screen.queryByLabelText(/^Screen margin:/)).toBeNull();
  expect(store.get(tvOverscanAtom)).toEqual({ x: 9.5, y: 0 });
});

it("hands the volume to the TV: SONE goes to 100 % and says so", async () => {
  mockInvoke({
    get_gapless_supported: () => false,
    set_volume: () => undefined,
  });
  const store = createStore();
  store.set(volumeAtom, 0.3);
  renderTv(<TvSettings />, { store });
  const row = screen.getByRole("button", { name: /^Volume/ });
  expect(row.textContent).toContain("SONE");
  fireEvent.click(row);
  expect(store.get(tvVolumeOnTvAtom)).toBe(true);
  expect(
    await screen.findByText(
      "Volume is now set on your TV; SONE plays at 100 %",
    ),
  ).toBeTruthy();
  expect(store.get(volumeAtom)).toBe(1);
  expect(row.textContent).toContain("TV");
  fireEvent.click(row);
  expect(store.get(tvVolumeOnTvAtom)).toBe(false);
});

it("says when no device is found and looks again", async () => {
  const store = createStore();
  store.set(exclusiveModeAtom, true);
  renderTv(<TvSettings />, { store });
  const row = await screen.findByRole("button", {
    name: /No output devices found/,
  });
  devices = [{ id: "hw:1", name: "DAC" }];
  fireEvent.click(row);
  expect(await screen.findByText("DAC")).toBeTruthy();
});

it("a failed listing shows the same row", async () => {
  mockInvoke({ get_gapless_supported: () => false });
  const store = createStore();
  store.set(exclusiveModeAtom, true);
  renderTv(<TvSettings />, { store });
  expect(await screen.findByText("No output devices found")).toBeTruthy();
});

// The look-again can land before the screen's first frame, when its own
// first-focus check runs: frames are held until then.
it("moves focus to the first device the look-again finds", async () => {
  const restore = stubLayout();
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
  });
  try {
    const store = createStore();
    store.set(exclusiveModeAtom, true);
    renderTv(<TvSettings />, { store });
    const row = await screen.findByRole("button", {
      name: /No output devices found/,
    });
    act(() => row.focus());
    devices = [{ id: "hw:1", name: "DAC" }];
    fireEvent.click(row);
    const dac = await screen.findByRole("button", { name: /^DAC/ });
    act(() => vi.advanceTimersByTime(50));
    expect(document.activeElement).toBe(dac);
  } finally {
    restore();
  }
});

it("shows no device rows while the list loads", async () => {
  const list = deferred<{ id: string; name: string }[]>();
  mockInvoke({
    get_gapless_supported: () => false,
    list_audio_devices: () => list.promise,
  });
  const store = createStore();
  store.set(exclusiveModeAtom, true);
  renderTv(<TvSettings />, { store });
  await act(async () => {});
  expect(screen.queryByText("No output devices found")).toBeNull();
  expect(screen.queryByText("Output device")).toBeNull();
  await act(async () => list.resolve([]));
  expect(screen.getByText("No output devices found")).toBeTruthy();
});

it("shows no empty-device row while exclusive output is off", async () => {
  renderTv(<TvSettings />);
  await act(async () => {});
  expect(screen.queryByText("No output devices found")).toBeNull();
});

it("explains a GStreamer without gapless support without naming a version", () => {
  renderTv(<TvSettings />);
  expect(
    screen.getByRole("button", { name: /Gapless playback/ }).textContent,
  ).toContain("Not available with this GStreamer installation");
});

it.each([
  [false, "Bit-perfect on — takes effect next track"],
  [true, "Bit-perfect off — takes effect next track"],
])("says only when bit-perfect takes effect (on: %s)", async (on, toast) => {
  mockInvoke({
    get_gapless_supported: () => false,
    list_audio_devices: () => [],
    set_volume: () => undefined,
    set_volume_normalization: () => undefined,
    set_bit_perfect: () => undefined,
  });
  const store = createStore();
  store.set(exclusiveModeAtom, true);
  store.set(bitPerfectAtom, on);
  renderTv(<TvSettings />, { store });
  fireEvent.click(screen.getByRole("button", { name: /^Bit-perfect/ }));
  expect(await screen.findByText(toast)).toBeTruthy();
});
