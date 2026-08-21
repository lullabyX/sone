import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadDrawerOpenAtom,
  downloadItemsAtom,
  downloadJobAtom,
  downloadQueueAtom,
} from "../atoms/downloads";
import DownloadQueueDrawer from "./DownloadQueueDrawer";

const { checkTiddl, startDownloadJob, stopDownloadJob, open, listen } = vi.hoisted(() => ({
  checkTiddl: vi.fn(),
  startDownloadJob: vi.fn(),
  stopDownloadJob: vi.fn(),
  open: vi.fn(),
  listen: vi.fn((_name: string, _callback: (event: { payload: Record<string, unknown> }) => void) => Promise.resolve(() => {})),
}));

vi.mock("../api/tidal", () => ({ checkTiddl, startDownloadJob, stopDownloadJob }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

function renderDrawer(queue = false, progress = false) {
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
  if (progress) {
    store.set(downloadJobAtom, { status: "downloading" });
    store.set(downloadItemsAtom, {
      first: { itemInstanceId: "first", title: "First", status: "success" },
      second: { itemInstanceId: "second", title: "Second", status: "downloading" },
      third: { itemInstanceId: "third", title: "Third", status: "discovering" },
    });
  }
  render(<Provider store={store}><DownloadQueueDrawer /></Provider>);
  return store;
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

  it("shows completed and remaining discovered items while downloading", () => {
    renderDrawer(false, true);

    expect(screen.getByText("1 of 3 finished · 2 remaining")).toBeTruthy();
  });

  it("stops a running download and keeps the queue", async () => {
    const store = renderDrawer(true, true);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(stopDownloadJob).toHaveBeenCalledOnce());
    expect(store.get(downloadQueueAtom)).toHaveLength(1);
  });

  it("marks active items as cancelled when the backend confirms the stop", async () => {
    let cancelled: ((event: { payload: Record<string, unknown> }) => void) | undefined;
    listen.mockImplementation((name, callback) => {
      if (name === "download:job-cancelled") cancelled = callback;
      return Promise.resolve(() => {});
    });
    const store = renderDrawer(true, true);

    await waitFor(() => expect(cancelled).toBeDefined());
    act(() => cancelled?.({ payload: {} }));

    expect(store.get(downloadJobAtom).status).toBe("cancelled");
    expect(store.get(downloadItemsAtom).second.status).toBe("cancelled");
    expect(store.get(downloadItemsAtom).third.status).toBe("cancelled");
    expect(store.get(downloadItemsAtom).first.status).toBe("success");
  });

  it("clears completed download history with the queue", () => {
    const store = renderDrawer(true, true);
    act(() => store.set(downloadJobAtom, { status: "complete" }));

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(store.get(downloadQueueAtom)).toEqual([]);
    expect(store.get(downloadItemsAtom)).toEqual({});
    expect(store.get(downloadJobAtom)).toEqual({ status: "idle" });
  });
});
