import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { useContext, useEffect, type ReactNode } from "react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));
vi.mock("../ProxyNoticeBanner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ProxyNoticeBanner")>()),
  default: () => null,
}));

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
import { allPlaylistsAtom } from "../../atoms/playlists";
import { currentVideoAtom, videoExpandedAtom } from "../../atoms/video";
import { DISMISS_PRIORITY, registerDismissable } from "../../lib/dismissStack";
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
