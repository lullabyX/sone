import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
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
  withQueue,
} from "./tvTestUtils";
import TvSettings from "./TvSettings";
import type { TvNav } from "./TvNavContext";
import { updateInfoAtom } from "../../atoms/updates";
import { moveFocus } from "../../lib/spatialNav";

setupTvTest();
beforeEach(() => mockInvoke({ get_gapless_supported: () => false }));
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
  fireEvent.click(screen.getByRole("button", { name: /Allow explicit content/ }));
  expect(labels(nav)).toEqual(["Cancel", "Yes, turn off"]);
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
