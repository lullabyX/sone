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

const { checkTiddl, startDownloadJob, stopDownloadJob, invoke, listen } = vi.hoisted(() => ({
  checkTiddl: vi.fn(),
  startDownloadJob: vi.fn(),
  stopDownloadJob: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn((_name: string, _callback: (event: { payload: Record<string, unknown> }) => void) => Promise.resolve(() => {})),
}));

vi.mock("../api/tidal", () => ({ checkTiddl, startDownloadJob, stopDownloadJob }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
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
      resolutionStatus: "ready",
      resolvedItems: [],
    }]);
  }
  if (progress) {
    store.set(downloadJobAtom, { status: "downloading" });
    store.set(downloadItemsAtom, {
      first: { itemInstanceId: "first", title: "First", status: "success" },
      second: { itemInstanceId: "second", title: "Second", status: "downloading", progress: 0.5, bytesDownloaded: 1024, bytesTotal: 2048 },
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

  it("checks tiddl and starts a job in the configured folder", async () => {
    checkTiddl.mockResolvedValueOnce(undefined);
    invoke.mockResolvedValueOnce("/music");
    startDownloadJob.mockResolvedValueOnce(undefined);
    renderDrawer(true);

    await waitFor(() => expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(checkTiddl).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith("get_download_folder");
    await waitFor(() => expect(startDownloadJob).toHaveBeenCalledWith("/music", expect.any(Array)));
  });

  it("requires a configured folder without opening a picker", async () => {
    checkTiddl.mockResolvedValueOnce(undefined);
    invoke.mockResolvedValueOnce(null);
    renderDrawer(true);

    await waitFor(() => expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(await screen.findByText("Choose a download folder in Settings > Downloads before starting a download.")).toBeTruthy();
    expect(startDownloadJob).not.toHaveBeenCalled();
  });

  it("shows a job-start failure returned by Tauri", async () => {
    checkTiddl.mockResolvedValueOnce(undefined);
    invoke.mockResolvedValueOnce("/music");
    startDownloadJob.mockRejectedValueOnce(new Error("tiddl reported that the download job failed."));
    renderDrawer(true);

    await waitFor(() => expect(screen.getByRole("button", { name: "Download" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(await screen.findByText("tiddl reported that the download job failed.")).toBeTruthy();
  });

  it("shows completed and remaining discovered items while downloading", () => {
    renderDrawer(false, true);

    expect(screen.getByText("1 of 3 finished · 2 remaining")).toBeTruthy();
    expect(screen.getByText("downloading · 50%")).toBeTruthy();
    expect(screen.getByText("1 KB / 2 KB")).toBeTruthy();
  });

  it("shows pending items in the download list before starting", () => {
    const store = renderDrawer(true);
    act(() => store.set(downloadItemsAtom, {
      pending: { itemInstanceId: "pending", title: "Queued track", artist: "Artist", status: "pending" },
    }));

    expect(screen.getByText("Queued track")).toBeTruthy();
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.getByText("Artist")).toBeTruthy();
  });

  it("replaces a matching pending item when the downloader discovers it", async () => {
    let discovered: ((event: { payload: Record<string, unknown> }) => void) | undefined;
    listen.mockImplementation((name, callback) => {
      if (name === "download:item-discovered") discovered = callback;
      return Promise.resolve(() => {});
    });
    const store = renderDrawer(true);
    act(() => store.set(downloadItemsAtom, {
      pending: { itemInstanceId: "pending", title: "Queued track", artist: "Artist", status: "pending" },
    }));

    await waitFor(() => expect(discovered).toBeDefined());
    act(() => discovered?.({ payload: { item: { item_instance_id: "helper-id", title: "Queued track", artist: "Artist", type: "track" } } }));

    expect(store.get(downloadItemsAtom)).toEqual({
      "helper-id": { itemInstanceId: "helper-id", title: "Queued track", artist: "Artist", itemType: "track", status: "discovering" },
    });
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
