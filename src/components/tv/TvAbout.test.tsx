import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
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

  it("every About line can take focus, so the remote scrolls it into view", async () => {
    const store = createStore();
    store.set(updateInfoAtom, {
      available: true,
      current: "1.2.3",
      latest: "1.3.0",
      url: "https://github.com/x/releases/tag/v1.3.0",
    });
    renderTv(<TvAboutSection />, { store });
    await screen.findByText("1.2.3");
    const version = screen.getByRole("button", { name: /sone.*1\.2\.3/i });
    const update = screen.getByRole("button", { name: /update available/i });
    const qr = screen.getByRole("group", { name: /release page qr code/i });
    for (const el of [version, update, qr]) {
      expect(el.hasAttribute("data-tv-focusable")).toBe(true);
    }
    expect(qr.tabIndex).toBe(0);
  });

  it("opens About SONE with QR links to the project and to report a problem", async () => {
    const { nav } = renderTv(<TvAboutSection />);
    await screen.findByText("1.2.3");
    fireEvent.click(screen.getByRole("button", { name: /sone.*1\.2\.3/i }));
    const spec = vi.mocked(nav.openMenu).mock.lastCall![0];
    expect(spec).toMatchObject({
      title: "About SONE",
      subtitle: "Version 1.2.3",
    });
    expect(spec.items.map((i) => i.label)).toEqual([
      "Project page",
      "Report a problem",
    ]);
    const [project, report] = await Promise.all(
      spec.items.map((i) => i.submenu!()),
    );
    expect(project.qr).toBe("https://github.com/lullabyX/sone");
    expect(report.qr).toBe(
      "https://github.com/lullabyX/sone/issues/new/choose",
    );
  });

  it("a version that cannot be read leaves the row empty", async () => {
    vi.mocked(getVersion).mockRejectedValueOnce(new Error("x"));
    renderTv(<TvAboutSection />);
    await act(async () => {});
    expect(screen.getByText("SONE")).toBeTruthy();
    expect(screen.queryByText("1.2.3")).toBeNull();
  });
});
