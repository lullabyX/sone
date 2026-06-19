import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// ScrobbleModal calls invoke("get_scrobble_status") + invoke("get_scrobble_queue_size")
// on open, and openUrl from the opener plugin on link/connect actions. Mock both
// so the modal renders with controlled data and no real IPC happens.
let queueSize = 3;
let statuses: { name: string; connected: boolean; username: string | null }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "get_scrobble_status") return Promise.resolve(statuses);
    if (cmd === "get_scrobble_queue_size") return Promise.resolve(queueSize);
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import ScrobbleModal from "./ScrobbleModal";

beforeEach(() => {
  queueSize = 3;
  statuses = [
    { name: "lastfm", connected: true, username: "rabbi" },
    { name: "librefm", connected: false, username: null },
    { name: "listenbrainz", connected: false, username: null },
  ];
});

// vitest runs with globals:false (see vitest.config.ts), so @testing-library/react
// does NOT auto-register cleanup. Without this, multiple render() calls accumulate
// in the DOM and queries throw "Found multiple elements".
afterEach(() => cleanup());

describe("ScrobbleModal (behavior contract)", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<ScrobbleModal open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders all three providers", async () => {
    render(<ScrobbleModal open onClose={() => {}} />);
    expect(await screen.findByText("Last.fm")).toBeTruthy();
    expect(screen.getByText("Libre.fm")).toBeTruthy();
    expect(screen.getByText("ListenBrainz")).toBeTruthy();
  });

  it("shows the username of a connected provider", async () => {
    render(<ScrobbleModal open onClose={() => {}} />);
    // regex (substring) matcher survives the "Scrobbling as: X" -> "Scrobbling as X" change
    expect(await screen.findByText(/rabbi/)).toBeTruthy();
  });

  it("shows a Disconnect control for a connected provider", async () => {
    render(<ScrobbleModal open onClose={() => {}} />);
    expect(await screen.findByText("Disconnect")).toBeTruthy();
  });

  it("offers Connect for the disconnected providers", async () => {
    render(<ScrobbleModal open onClose={() => {}} />);
    await screen.findByText("Libre.fm");
    // anchored regex so "Disconnect" is NOT matched; expect librefm + listenbrainz
    const connect = screen.getAllByRole("button", { name: /^connect$/i });
    expect(connect.length).toBeGreaterThanOrEqual(2);
  });

  it("renders the ListenBrainz token input", async () => {
    render(<ScrobbleModal open onClose={() => {}} />);
    expect(await screen.findByPlaceholderText(/token/i)).toBeTruthy();
  });

  it("shows pending scrobbles when the queue is non-empty", async () => {
    render(<ScrobbleModal open onClose={() => {}} />);
    expect(await screen.findByText(/pending scrobbles/i)).toBeTruthy();
  });

  it("hides the pending indicator when the queue is empty", async () => {
    queueSize = 0;
    render(<ScrobbleModal open onClose={() => {}} />);
    await screen.findByText("Last.fm");
    expect(screen.queryByText(/pending/i)).toBeNull();
  });
});
