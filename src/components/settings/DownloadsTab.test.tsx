import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn((...args: unknown[]) => {
  const command = args[0];
  if (command === "get_download_folder") return Promise.resolve("/music");
  if (command === "get_download_quality") return Promise.resolve("max");
  if (command === "get_download_album_cover") return Promise.resolve(true);
  return Promise.resolve(undefined);
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import DownloadsTab from "./DownloadsTab";

beforeEach(() => invokeMock.mockClear());
afterEach(() => cleanup());

describe("DownloadsTab", () => {
  it("loads the maximum download quality and saves a selected tier", async () => {
    render(<DownloadsTab />);

    const quality = await screen.findByLabelText("Download audio quality");
    expect((quality as HTMLSelectElement).value).toBe("max");

    fireEvent.change(quality, { target: { value: "high" } });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_download_quality", {
        quality: "high",
      });
    });
  });
});
