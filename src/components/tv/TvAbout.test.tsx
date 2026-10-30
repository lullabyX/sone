import { describe, expect, it, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { createStore } from "jotai";
import { getVersion } from "@tauri-apps/api/app";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(() => Promise.resolve("1.2.3")),
}));

import { renderTv, setupTvTest } from "./tvTestUtils";
import { TvAboutSection } from "./TvAbout";
import { updateInfoAtom } from "../../atoms/updates";

setupTvTest();

describe("TvAboutSection", () => {
  it("shows the version", async () => {
    renderTv(<TvAboutSection />);
    expect(await screen.findByText("1.2.3")).toBeTruthy();
    expect(screen.queryByText(/update available/i)).toBeNull();
  });

  it("shows an available update with a QR for the release page", async () => {
    const store = createStore();
    store.set(updateInfoAtom, {
      available: true,
      current: "1.2.3",
      latest: "1.3.0",
      url: "https://github.com/x/releases/tag/v1.3.0",
    });
    renderTv(<TvAboutSection />, { store });
    expect(await screen.findByText(/update available.*1\.3\.0/i)).toBeTruthy();
    expect(screen.getByRole("img", { name: /release page/i })).toBeTruthy();
  });

  it("a version that cannot be read leaves the row empty", async () => {
    vi.mocked(getVersion).mockRejectedValueOnce(new Error("x"));
    renderTv(<TvAboutSection />);
    await act(async () => {});
    expect(screen.getByText("SONE")).toBeTruthy();
    expect(screen.queryByText("1.2.3")).toBeNull();
  });
});
