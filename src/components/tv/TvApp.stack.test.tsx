import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { useContext, useEffect, type ReactNode } from "react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("../ProxyNoticeBanner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ProxyNoticeBanner")>()),
  default: () => null,
}));

// Every screen is a probe: its name, whether it is the active one, and
// buttons that drive the TV navigation from inside it.
const { probe, screenOf } = vi.hoisted(() => {
  const probe = { render: null as null | ((name: string) => ReactNode) };
  const screenOf = (name: (props: Record<string, unknown>) => string) => () => ({
    default: (props: Record<string, unknown>) => probe.render!(name(props)),
  });
  return { probe, screenOf };
});
vi.mock("./TvHome", screenOf(() => "home"));
vi.mock("./TvSearch", screenOf(() => "search"));
vi.mock("./TvCollection", screenOf(() => "collection"));
vi.mock("./TvSettings", screenOf(() => "settings"));
vi.mock("./TvPageScreen", screenOf(() => "page"));
vi.mock("./TvFeedScreen", screenOf(() => "feed"));
vi.mock("./TvProfileScreen", screenOf(() => "profile"));
vi.mock("./TvListScreen", screenOf(() => "list"));
vi.mock("./TvSearchResultsScreen", screenOf(() => "searchResults"));
vi.mock("./TvNowPlaying", screenOf(() => "nowPlaying"));
vi.mock("./TvArtistScreen", screenOf((p) => `artist:${(p.view as { id: number }).id}`));
vi.mock(
  "./TvTrackListScreen",
  screenOf((p) => {
    const v = p.view as { type: string; uuid?: string; id?: number };
    return v.type === "playlist" ? `playlist:${v.uuid}` : `${v.type}:${v.id}`;
  }),
);

import { allPlaylistsAtom } from "../../atoms/playlists";
import type { Playlist } from "../../types";
import TvApp from "./TvApp";
import { TvScreenContext, useTvNav, type TvNav } from "./TvNavContext";
import { renderTv, setupTvTest, signedIn } from "./tvTestUtils";

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
      <button data-tv-focusable onClick={() => nav.push({ type: "playlist", uuid: "p" })}>
        {name}: open P
      </button>
      <button data-tv-focusable onClick={() => nav.push({ type: "album", id: 9 })}>
        {name}: open album
      </button>
      <button data-tv-focusable onClick={() => nav.openNowPlaying()}>
        {name}: now playing
      </button>
    </section>
  );
}
probe.render = (name) => <Probe name={name} />;

const activeScreen = () => document.querySelector("[data-active]")?.getAttribute("data-testid");
const press = (label: string) => fireEvent.click(screen.getByRole("button", { name: label }));
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
    const opener = screen.getByRole("button", { name: "playlist:p: open album" });
    act(() => opener.focus());
    press("playlist:p: open album");
    press("album:9: open P");
    expect(screen.getAllByTestId("playlist:p")).toHaveLength(1);
    expect(screen.queryByTestId("album:9")).toBeNull();
    expect(document.activeElement).toBe(opener);
    back();
    expect(activeScreen()).toBe("home");
  });

  it("on top, from Now Playing, closes the layer onto it; Back reopens Now Playing", () => {
    renderTv(<TvApp />, { store: signedIn(42) });
    press("home: open P");
    press("playlist:p: now playing");
    press("nowPlaying: open P");
    expect(screen.getAllByTestId("playlist:p")).toHaveLength(1);
    expect(activeScreen()).toBe("playlist:p");
    back();
    expect(activeScreen()).toBe("nowPlaying");
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
    store.set(allPlaylistsAtom, [{ uuid: "p", title: "P", creator: { id: 42 } } as Playlist]);
    return store;
  };
  const deleteP = async () => {
    const menu = seen.nav!.mediaMenu({ type: "playlist", uuid: "p", title: "P" });
    const confirm = await menu.items.find((i) => i.label === "Delete playlist")!.submenu!();
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

  it("closes its page on top as Back would", async () => {
    renderTv(<TvApp />, { store: own() });
    press("home: open album");
    press("album:9: open P");
    await deleteP();
    expect(screen.queryByTestId("playlist:p")).toBeNull();
    expect(activeScreen()).toBe("album:9");
  });
});
