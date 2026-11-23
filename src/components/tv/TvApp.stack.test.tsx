import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { useContext, useEffect, type ReactNode } from "react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));
vi.mock("../../lib/refreshApp", () => ({ refreshApp: vi.fn(async () => {}) }));

// Every screen is a probe: its name, whether it is the active one, and
// buttons that drive the TV navigation from inside it.
const { probe, screenOf } = vi.hoisted(() => {
  const probe = { render: null as null | ((name: string) => ReactNode) };
  const screenOf =
    (name: (props: Record<string, unknown>) => string) => () => ({
      default: (props: Record<string, unknown>) => probe.render!(name(props)),
    });
  return { probe, screenOf };
});
vi.mock(
  "./TvHome",
  screenOf(() => "home"),
);
vi.mock(
  "./TvSearch",
  screenOf(() => "search"),
);
vi.mock(
  "./TvCollection",
  screenOf(() => "collection"),
);
vi.mock(
  "./TvSettings",
  screenOf(() => "settings"),
);
vi.mock(
  "./TvPageScreen",
  screenOf(() => "page"),
);
vi.mock(
  "./TvFeedScreen",
  screenOf(() => "feed"),
);
vi.mock(
  "./TvProfileScreen",
  screenOf(() => "profile"),
);
vi.mock(
  "./TvListScreen",
  screenOf(() => "list"),
);
vi.mock(
  "./TvSearchResultsScreen",
  screenOf(() => "searchResults"),
);
vi.mock(
  "./TvNowPlaying",
  screenOf(() => "nowPlaying"),
);
vi.mock(
  "./TvArtistScreen",
  screenOf((p) => `artist:${(p.view as { id: number }).id}`),
);
vi.mock(
  "./TvTrackListScreen",
  screenOf((p) => {
    const v = p.view as { type: string; uuid?: string; id?: number };
    return v.type === "playlist" ? `playlist:${v.uuid}` : `${v.type}:${v.id}`;
  }),
);

import { invoke } from "@tauri-apps/api/core";
import { refreshApp } from "../../lib/refreshApp";
import { allPlaylistsAtom } from "../../atoms/playlists";
import { currentVideoAtom, videoExpandedAtom } from "../../atoms/video";
import { DISMISS_PRIORITY, registerDismissable } from "../../lib/dismissStack";
import { useShortcuts } from "../../hooks/useShortcuts";
import { DEFAULT_BINDINGS, shortcutsAtom } from "../../lib/shortcuts";
import type { Playlist } from "../../types";
import TvApp from "./TvApp";
import { TvScreenContext, useTvNav, type TvNav } from "./TvNavContext";
import { queuePlaylistEdit } from "./tvPlaylistEdits";
import {
  deferred,
  pressKey,
  renderTv,
  setupTvTest,
  signedIn,
  stubLayout,
} from "./tvTestUtils";

setupTvTest();

const seen: { nav: TvNav | null } = { nav: null };

function Probe({ name }: { name: string }) {
  const nav = useTvNav();
  useEffect(() => {
    seen.nav = nav;
  }, [nav]);
  const { active } = useContext(TvScreenContext);
  return (
    <section data-testid={name} data-active={active || undefined}>
      <button
        data-tv-focusable
        onClick={() => nav.push({ type: "playlist", uuid: "p" })}
      >
        {name}: open P
      </button>
      <button
        data-tv-focusable
        onClick={() => nav.push({ type: "album", id: 9 })}
      >
        {name}: open album
      </button>
      <button data-tv-focusable onClick={() => nav.openNowPlaying()}>
        {name}: now playing
      </button>
    </section>
  );
}
probe.render = (name) => <Probe name={name} />;

const activeScreen = () =>
  document.querySelector("[data-active]")?.getAttribute("data-testid");
const press = (label: string) =>
  fireEvent.click(screen.getByRole("button", { name: label }));
const back = () => act(() => fireEvent.keyDown(window, { key: "Escape" }));
const boxes = (layout: Record<string, string>) => {
  for (const [name, box] of Object.entries(layout)) {
    screen.getByRole("button", { name }).setAttribute("data-box", box);
  }
};

/** The desktop shortcuts, mounted beside TV mode as in the app. */
function Shortcuts({ on }: { on: Parameters<typeof useShortcuts>[0] }) {
  useShortcuts(on);
  return null;
}
const bare = (code: string) => ({ code, mod: false, shift: false, alt: false });

describe("opening a page that is already open", () => {
  it("Playing from goes back to the open playlist; Back then reopens Now Playing", () => {
    renderTv(<TvApp />, { store: signedIn(42) });
    press("home: open P");
    press("playlist:p: open album");
    press("album:9: now playing");
    expect(activeScreen()).toBe("nowPlaying");
    press("nowPlaying: open P");
    expect(screen.getAllByTestId("playlist:p")).toHaveLength(1);
    expect(screen.queryByTestId("album:9")).toBeNull();
    expect(activeScreen()).toBe("playlist:p");
    back();
    expect(activeScreen()).toBe("nowPlaying");
    back();
    expect(activeScreen()).toBe("home");
    expect(screen.queryByTestId("playlist:p")).toBeNull();
  });

  it("from a screen above it, goes back to it with the focus it had, and Back continues below it", () => {
    renderTv(<TvApp />, { store: signedIn(42) });
    press("home: open P");
    const opener = screen.getByRole("button", {
      name: "playlist:p: open album",
    });
    act(() => opener.focus());
    press("playlist:p: open album");
    press("album:9: open P");
    expect(screen.getAllByTestId("playlist:p")).toHaveLength(1);
    expect(screen.queryByTestId("album:9")).toBeNull();
    expect(document.activeElement).toBe(opener);
    back();
    expect(activeScreen()).toBe("home");
  });

  it("right under Now Playing, closes the layer as Back would; Back then leaves the page", () => {
    renderTv(<TvApp />, { store: signedIn(42) });
    press("home: open P");
    const opener = screen.getByRole("button", {
      name: "playlist:p: now playing",
    });
    act(() => opener.focus());
    press("playlist:p: now playing");
    press("nowPlaying: open P");
    expect(screen.getAllByTestId("playlist:p")).toHaveLength(1);
    expect(activeScreen()).toBe("playlist:p");
    expect(document.activeElement).toBe(opener);
    back();
    expect(activeScreen()).toBe("home");
    back();
    expect(activeScreen()).toBe("home");
  });

  it("right under Now Playing it was opened from, keeps the way back to Now Playing", () => {
    renderTv(<TvApp />, { store: signedIn(42) });
    press("home: now playing");
    press("nowPlaying: open P");
    press("playlist:p: now playing");
    press("nowPlaying: open P");
    expect(activeScreen()).toBe("playlist:p");
    back();
    expect(activeScreen()).toBe("nowPlaying");
    back();
    expect(activeScreen()).toBe("home");
  });

  it("on top, from inside it, changes nothing", () => {
    renderTv(<TvApp />, { store: signedIn(42) });
    press("home: open P");
    const before = screen.getByTestId("playlist:p");
    press("playlist:p: open P");
    expect(screen.getByTestId("playlist:p")).toBe(before);
    back();
    expect(activeScreen()).toBe("home");
  });
});

describe("deleting a playlist", () => {
  const own = () => {
    const store = signedIn(42);
    store.set(allPlaylistsAtom, [
      { uuid: "p", title: "P", creator: { id: 42 } } as Playlist,
    ]);
    return store;
  };
  const deleteP = async () => {
    const menu = seen.nav!.mediaMenu({
      type: "playlist",
      uuid: "p",
      title: "P",
    });
    const confirm = await menu.items.find((i) => i.label === "Delete playlist")!
      .submenu!();
    await act(async () => {
      await confirm.items.find((i) => i.label === "Delete")!.onSelect!();
    });
  };

  it("closes its page below the current one, so Back skips it", async () => {
    renderTv(<TvApp />, { store: own() });
    press("home: open P");
    press("playlist:p: open album");
    await deleteP();
    expect(screen.queryByTestId("playlist:p")).toBeNull();
    expect(activeScreen()).toBe("album:9");
    back();
    expect(activeScreen()).toBe("home");
  });

  it("waits for the playlist's queued writes before deleting it", async () => {
    const store = own();
    const write = deferred();
    void queuePlaylistEdit("p", () => write.promise);
    renderTv(<TvApp />, { store });
    press("home: open P");
    const menu = seen.nav!.mediaMenu({
      type: "playlist",
      uuid: "p",
      title: "P",
    });
    const confirm = await menu.items.find((i) => i.label === "Delete playlist")!
      .submenu!();
    let done: unknown;
    await act(async () => {
      done = confirm.items.find((i) => i.label === "Delete")!.onSelect!();
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "delete_playlist",
      expect.anything(),
    );
    await act(async () => {
      write.resolve();
      await done;
    });
    expect(invoke).toHaveBeenCalledWith("delete_playlist", expect.anything());
    expect(screen.queryByTestId("playlist:p")).toBeNull();
  });

  it("closes its page on top as Back would", async () => {
    renderTv(<TvApp />, { store: own() });
    press("home: open album");
    press("album:9: open P");
    await deleteP();
    expect(screen.queryByTestId("playlist:p")).toBeNull();
    expect(activeScreen()).toBe("album:9");
  });
});

describe("the layers and the rail", () => {
  let restoreLayout = () => {};
  let off = () => {};
  beforeEach(() => {
    // Menu entries stack downwards, so Down has somewhere to go.
    const unstubbed = stubLayout();
    const stubbed = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const r = stubbed.call(this);
      if (this.getAttribute("role") !== "menuitem" || r.height === 0) return r;
      const top = Array.from(this.parentElement!.children).indexOf(this) * 20;
      return { ...r, y: top, top, bottom: top + r.height } as DOMRect;
    };
    restoreLayout = unstubbed;
  });
  afterEach(() => {
    restoreLayout();
    off();
    document.querySelector("#video")?.remove();
    document.querySelector("#sheet")?.remove();
  });

  it("the rail's Refresh app clears the cache and reloads", () => {
    renderTv(<TvApp />, { store: signedIn(42) });
    press("Refresh app");
    expect(refreshApp).toHaveBeenCalledTimes(1);
  });

  it("a rail detour returns to the page it left, with its focus", () => {
    renderTv(<TvApp />, { store: signedIn(42) });
    press("My Collection");
    press("collection: open P");
    expect(activeScreen()).toBe("playlist:p");
    const row = screen.getByRole("button", { name: "playlist:p: open album" });
    act(() => row.focus());
    press("Settings");
    expect(activeScreen()).toBe("settings");
    back();
    expect(activeScreen()).toBe("playlist:p");
    expect(document.activeElement).toBe(row);
    back();
    expect(activeScreen()).toBe("collection");
    // Picking Home from the rail goes back to it, not on top.
    press("Settings");
    press("Home");
    expect(activeScreen()).toBe("home");
    back();
    expect(activeScreen()).toBe("home");
  });

  it("Back on a top-level screen goes Home; Back on Home opens the rail", () => {
    renderTv(<TvApp />, { store: signedIn(42) });
    expect(activeScreen()).toBe("home");
    press("Settings");
    expect(activeScreen()).toBe("settings");
    back();
    expect(activeScreen()).toBe("home");
    back();
    expect(activeScreen()).toBe("home");
    expect(document.activeElement?.closest("nav")).not.toBeNull();
    // Back on the rail closes it, back to the screen.
    back();
    expect(activeScreen()).toBe("home");
    expect(document.activeElement?.closest("nav")).toBeNull();
    expect(
      document.activeElement?.closest("[data-testid='home']"),
    ).not.toBeNull();
  });

  it("in More settings, the arrows stay in a confirmation open over the sheet", () => {
    renderTv(<TvApp />, { store: signedIn(42) });
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="sheet" data-tv-modal data-tv-native><button data-box="0,100,50,10">Explicit</button>
        <div role="dialog" aria-modal="true"><button id="no" data-box="0,0,50,10">Not now</button>
        <button data-box="60,0,50,10">Yes, turn off</button></div></div>`,
    );
    const no = document.querySelector<HTMLElement>("#no")!;
    act(() => no.focus());
    pressKey(no, { key: "ArrowDown" });
    expect(document.activeElement).toBe(no);
    pressKey(no, { key: "ArrowRight" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Yes, turn off" }),
    );
  });
  it("Enter on a multi-line settings field edits it in a multi-line prompt", () => {
    renderTv(<TvApp />, { store: signedIn(42) });
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="sheet" data-tv-modal data-tv-native><textarea id="notes" aria-label="Notes">a\nb</textarea></div>`,
    );
    const notes = document.querySelector<HTMLElement>("#notes")!;
    act(() => notes.focus());
    pressKey(notes, { key: "Enter" });
    expect(
      document.querySelector<HTMLTextAreaElement>("[data-tv-prompt] textarea")
        ?.value,
    ).toBe("a\nb");
  });
  const menu = {
    title: "M",
    items: [
      { label: "One", onSelect: () => {} },
      { label: "Two", onSelect: () => {} },
    ],
  };
  const fullScreenVideo = (store: ReturnType<typeof signedIn>) => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="video" role="dialog"><video></video><button title="Previous">prev</button><button>play</button></div>`,
    );
    act(() => {
      store.set(currentVideoAtom, { id: 5 } as never);
      store.set(videoExpandedAtom, true);
    });
  };

  it("a menu open when a video goes full screen keeps the arrows and Back; the video stays", () => {
    const store = signedIn(42);
    renderTv(<TvApp />, { store });
    act(() => seen.nav!.openMenu(menu));
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "One" }),
    );
    fullScreenVideo(store);
    const videoClose = vi.fn();
    off = registerDismissable(DISMISS_PRIORITY.overlay, videoClose);
    pressKey(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Two" }),
    );
    pressKey(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(store.get(videoExpandedAtom)).toBe(true);
    expect(videoClose).not.toHaveBeenCalled();
  });

  it("Up and Down scroll a read-only menu (the Signal path)", () => {
    renderTv(<TvApp />, { store: signedIn(42) });
    act(() =>
      seen.nav!.openMenu({
        title: "Signal path",
        items: [
          { label: "DECODE", info: true, path: { kind: "stage" } },
          { label: "DAC", info: true, path: { kind: "stage" } },
        ],
      }),
    );
    const panel = screen.getByRole("menu");
    expect(document.activeElement).toBe(panel);
    let top = 0;
    Object.defineProperty(panel, "clientHeight", { value: 500 });
    Object.defineProperty(panel, "scrollTop", {
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, v);
      },
    });
    pressKey(panel, { key: "ArrowDown" });
    expect(top).toBe(200);
    pressKey(panel, { key: "ArrowUp" });
    expect(top).toBe(0);
    pressKey(panel, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("the search shortcut does nothing under a menu or a full-screen video", () => {
    const store = signedIn(42);
    renderTv(<TvApp />, { store });
    act(() => seen.nav!.openMenu(menu));
    act(() => window.dispatchEvent(new Event("focus-search")));
    expect(activeScreen()).toBe("home");
    expect(screen.getByRole("menu")).toBeTruthy();
    pressKey(document.activeElement!, { key: "Escape" });
    fullScreenVideo(store);
    act(() => window.dispatchEvent(new Event("focus-search")));
    expect(screen.queryByTestId("search")).toBeNull();
  });

  it("Ctrl+K pressed under a menu or a full-screen video does not open Search", () => {
    const store = signedIn(42);
    const focusSearch = vi.fn(() =>
      window.dispatchEvent(new CustomEvent("focus-search")),
    );
    renderTv(<Shortcuts on={{ focusSearch }} />, { store });
    renderTv(<TvApp />, { store });
    const ctrlK = (target: EventTarget) => {
      pressKey(target, { key: "Control", code: "ControlLeft", ctrlKey: true });
      pressKey(target, { key: "k", code: "KeyK", ctrlKey: true });
    };
    act(() => seen.nav!.openMenu(menu));
    ctrlK(document.activeElement!);
    expect(focusSearch).toHaveBeenCalledTimes(1);
    expect(activeScreen()).toBe("home");
    expect(screen.getByRole("menu")).toBeTruthy();
    pressKey(document.activeElement!, { key: "Escape" });
    fullScreenVideo(store);
    ctrlK(document.body);
    expect(focusSearch).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("search")).toBeNull();
    expect(activeScreen()).toBe("home");
  });

  it("desktop shortcuts bound to bare keys stay off the remote's arrows and Enter", () => {
    const store = signedIn(42);
    store.set(shortcutsAtom, {
      ...DEFAULT_BINDINGS,
      volumeDown: bare("ArrowDown"),
      nextTrack: bare("Enter"),
    });
    const on = { volumeDown: vi.fn(), nextTrack: vi.fn() };
    renderTv(<Shortcuts on={on} />, { store });
    renderTv(<TvApp />, { store });
    boxes({
      "home: open P": "100,100,100,50",
      "home: open album": "100,200,100,50",
      "home: now playing": "100,300,100,50",
    });
    const openP = screen.getByRole("button", { name: "home: open P" });
    const openAlbum = screen.getByRole("button", { name: "home: open album" });
    act(() => openP.focus());
    pressKey(openP, { key: "ArrowDown", code: "ArrowDown" });
    expect(document.activeElement).toBe(openAlbum);
    // Enter on an item without a menu is the browser's own click, which
    // jsdom leaves out: it happens only if nothing prevented the keydown.
    const enter = pressKey(openAlbum, { key: "Enter", code: "Enter" });
    expect(enter.defaultPrevented).toBe(false);
    fireEvent.click(openAlbum);
    pressKey(openAlbum, { key: "Enter", code: "Enter" }, "keyup");
    expect(activeScreen()).toBe("album:9");
    act(() => (document.activeElement as HTMLElement).blur());
    pressKey(document.body, { key: "ArrowDown", code: "ArrowDown" });
    expect(on.volumeDown).not.toHaveBeenCalled();
    expect(on.nextTrack).not.toHaveBeenCalled();
  });

  it("Up from Home's top row reaches the proxy notice; Down comes back", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "get_proxy_status"
        ? { state: "blocked", reason: "r" }
        : undefined,
    );
    renderTv(<TvApp />, { store: signedIn(42) });
    await screen.findByRole("button", { name: "Turn off proxy" });
    boxes({
      "home: open P": "100,200,100,50",
      "home: open album": "250,200,100,50",
      "home: now playing": "400,200,100,50",
      "Network settings": "1000,20,150,50",
      "Turn off proxy": "1170,20,150,50",
      Dismiss: "1340,20,50,50",
    });
    const openAlbum = screen.getByRole("button", { name: "home: open album" });
    act(() => openAlbum.focus());
    pressKey(openAlbum, { key: "ArrowUp" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Network settings" }),
    );
    pressKey(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Turn off proxy" }),
    );
    pressKey(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(openAlbum);
  });

  it("dismissing the proxy notice puts focus back on the screen", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "get_proxy_status"
        ? { state: "blocked", reason: "r" }
        : undefined,
    );
    renderTv(<TvApp />, { store: signedIn(42) });
    const dismiss = await screen.findByRole("button", { name: "Dismiss" });
    const openAlbum = screen.getByRole("button", { name: "home: open album" });
    act(() => openAlbum.focus());
    act(() => dismiss.focus());
    fireEvent.click(dismiss);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(openAlbum);
  });

  it("the rail's Now Playing moves focus into the open layer", () => {
    renderTv(<TvApp />, { store: signedIn(42) });
    press("home: now playing");
    const rail = screen.getByRole("button", { name: "Now Playing" });
    act(() => rail.focus());
    fireEvent.click(rail);
    expect(activeScreen()).toBe("nowPlaying");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "nowPlaying: open P" }),
    );
  });
});
