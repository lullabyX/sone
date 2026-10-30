import { expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { createStore } from "jotai";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(() => Promise.resolve("1.2.3")),
}));

import { renderTv, setupTvTest, stubLayout } from "./tvTestUtils";
import TvSettings from "./TvSettings";
import { updateInfoAtom } from "../../atoms/updates";
import { moveFocus } from "../../lib/spatialNav";

setupTvTest();

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
