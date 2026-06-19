import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// ScrobbleTab calls invoke("get_scrobble_status") + invoke("get_scrobble_queue_size")
// on mount, and openUrl on connect actions. Mock both. (vitest globals default to
// off — only jsdom is configured — so cleanup is registered manually below.)
let queueSize = 3;
let statuses: { name: string; connected: boolean; username: string | null }[] =
  [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "get_scrobble_status") return Promise.resolve(statuses);
    if (cmd === "get_scrobble_queue_size") return Promise.resolve(queueSize);
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import ScrobbleTab from "./ScrobbleTab";

beforeEach(() => {
  queueSize = 3;
  statuses = [
    { name: "lastfm", connected: true, username: "rabbi" },
    { name: "librefm", connected: false, username: null },
    { name: "listenbrainz", connected: false, username: null },
  ];
});
afterEach(() => cleanup());

describe("ScrobbleTab (behavior contract)", () => {
  it("renders all three providers", async () => {
    render(<ScrobbleTab />);
    expect(await screen.findByText("Last.fm")).toBeTruthy();
    expect(screen.getByText("Libre.fm")).toBeTruthy();
    expect(screen.getByText("ListenBrainz")).toBeTruthy();
  });

  it("shows the username of a connected provider", async () => {
    render(<ScrobbleTab />);
    expect(await screen.findByText(/rabbi/)).toBeTruthy();
  });

  it("shows a Disconnect control for a connected provider", async () => {
    render(<ScrobbleTab />);
    expect(await screen.findByText("Disconnect")).toBeTruthy();
  });

  it("offers Connect for the disconnected providers", async () => {
    render(<ScrobbleTab />);
    await screen.findByText("Libre.fm");
    const connect = screen.getAllByRole("button", { name: /^connect$/i });
    expect(connect.length).toBeGreaterThanOrEqual(2);
  });

  it("renders the ListenBrainz token input", async () => {
    render(<ScrobbleTab />);
    expect(await screen.findByPlaceholderText(/token/i)).toBeTruthy();
  });

  it("shows pending scrobbles when the queue is non-empty", async () => {
    render(<ScrobbleTab />);
    expect(await screen.findByText(/pending scrobbles/i)).toBeTruthy();
  });

  it("hides the pending indicator when the queue is empty", async () => {
    queueSize = 0;
    render(<ScrobbleTab />);
    await screen.findByText("Last.fm");
    expect(screen.queryByText(/pending/i)).toBeNull();
  });
});
