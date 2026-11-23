import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";

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
    if (cmd === "connect_lastfm")
      return Promise.resolve({
        url: "https://www.last.fm/api/auth?token=t",
        token: "t",
      });
    return Promise.resolve(undefined);
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { openUrl } from "@tauri-apps/plugin-opener";
import { tvModeAtom } from "../../atoms/tv";
import ScrobbleTab from "./ScrobbleTab";

beforeEach(() => {
  queueSize = 3;
  statuses = [
    { name: "lastfm", connected: true, username: "rabbi" },
    { name: "librefm", connected: false, username: null },
    { name: "listenbrainz", connected: false, username: null },
  ];
  vi.mocked(openUrl).mockClear();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

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

describe("ScrobbleTab sign-in", () => {
  // jsdom has no scrollIntoView; TV mode focuses through focusElement.
  const scrollIntoView = Element.prototype.scrollIntoView;
  beforeAll(() => {
    Element.prototype.scrollIntoView = () => {};
  });
  afterAll(() => {
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  beforeEach(() => {
    statuses = [
      { name: "lastfm", connected: false, username: null },
      { name: "librefm", connected: false, username: null },
      { name: "listenbrainz", connected: false, username: null },
    ];
  });

  it("shows a QR instead of opening a browser in TV mode", async () => {
    const store = createStore();
    store.set(tvModeAtom, true);
    render(
      <Provider store={store}>
        <ScrobbleTab />
      </Provider>,
    );
    await screen.findByText("Last.fm");
    fireEvent.click(screen.getAllByRole("button", { name: /^connect$/i })[0]);
    expect(
      await screen.findByRole("img", { name: /last\.fm sign-in/i }),
    ).toBeTruthy();
    expect(openUrl).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /i've authorized/i }),
    ).toBeTruthy();
  });

  it("moves remote focus to I've authorized in TV mode", async () => {
    const store = createStore();
    store.set(tvModeAtom, true);
    render(
      <Provider store={store}>
        <ScrobbleTab />
      </Provider>,
    );
    await screen.findByText("Last.fm");
    fireEvent.click(screen.getAllByRole("button", { name: /^connect$/i })[0]);
    const authorized = await screen.findByRole("button", {
      name: /i've authorized/i,
    });
    await waitFor(() => expect(document.activeElement).toBe(authorized));
  });

  it("still opens the browser on the desktop", async () => {
    render(
      <Provider store={createStore()}>
        <ScrobbleTab />
      </Provider>,
    );
    await screen.findByText("Last.fm");
    fireEvent.click(screen.getAllByRole("button", { name: /^connect$/i })[0]);
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith(
        "https://www.last.fm/api/auth?token=t",
      ),
    );
    expect(screen.queryByRole("img", { name: /sign-in/i })).toBeNull();
  });
});

describe("ScrobbleTab ListenBrainz token page", () => {
  beforeEach(() => {
    statuses = [
      { name: "lastfm", connected: false, username: null },
      { name: "librefm", connected: false, username: null },
      { name: "listenbrainz", connected: false, username: null },
    ];
  });

  it("links listenbrainz.org/settings in the browser on the desktop", async () => {
    render(
      <Provider store={createStore()}>
        <ScrobbleTab />
      </Provider>,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: /listenbrainz\.org\/settings/,
      }),
    );
    expect(openUrl).toHaveBeenCalledWith("https://listenbrainz.org/settings/");
    expect(
      screen.queryByRole("img", { name: "ListenBrainz settings" }),
    ).toBeNull();
  });

  it("shows the page as a QR code in TV mode, with no link to a browser", async () => {
    const store = createStore();
    store.set(tvModeAtom, true);
    render(
      <Provider store={store}>
        <ScrobbleTab />
      </Provider>,
    );
    expect(
      await screen.findByRole("img", { name: "ListenBrainz settings" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /listenbrainz\.org\/settings/ }),
    ).toBeNull();
    expect(screen.getByPlaceholderText("User token")).toBeTruthy();
  });
});
