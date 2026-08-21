import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadDrawerOpenAtom,
  downloadQueueAtom,
} from "../atoms/downloads";
import DownloadQueueDrawer from "./DownloadQueueDrawer";

const { checkTiddl, startDownloadJob, open, listen } = vi.hoisted(() => ({
  checkTiddl: vi.fn(),
  startDownloadJob: vi.fn(),
  open: vi.fn(),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../api/tidal", () => ({ checkTiddl, startDownloadJob }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

function renderDrawer(queue = false) {
  const store = createStore();
  store.set(downloadDrawerOpenAtom, true);
  if (queue) {
    store.set(downloadQueueAtom, [{
      id: "entry",
      sourceType: "track",
      url: "https://tidal.com/track/1",
      title: "Track",
      output: "{item.artist}/{item.title}",
      previewStatus: "ready",
      previewItems: [],
    }]);
  }
  render(<Provider store={store}><DownloadQueueDrawer /></Provider>);
}

describe("DownloadQueueDrawer", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("disables download for an empty queue", () => {
    renderDrawer();
    expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(true);
  });

  it("checks tiddl before opening the folder picker and starting a job", async () => {
    checkTiddl.mockResolvedValueOnce(undefined);
    open.mockResolvedValueOnce("/music");
    startDownloadJob.mockResolvedValueOnce(undefined);
    renderDrawer(true);

    await waitFor(() => expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(checkTiddl).toHaveBeenCalledOnce());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    await waitFor(() => expect(startDownloadJob).toHaveBeenCalledWith("/music", expect.any(Array)));
  });

  it("shows a job-start failure returned by Tauri", async () => {
    checkTiddl.mockResolvedValueOnce(undefined);
    open.mockResolvedValueOnce("/music");
    startDownloadJob.mockRejectedValueOnce(new Error("tiddl reported that the download job failed."));
    renderDrawer(true);

    await waitFor(() => expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(await screen.findByText("tiddl reported that the download job failed.")).toBeTruthy();
  });
});
