import { expect, it, vi } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { createStore } from "jotai";
import { favoriteTrackIdsAtom } from "../../atoms/favorites";
import { allowExplicitAtom } from "../../atoms/playback";
import { TvGrid, TvRow, TvTile, TvTrackRow } from "./TvParts";
import { armMarquee, marqueeShift } from "./tvMarquee";
import { sectionEntries } from "./tvItems";
import { menuForElement } from "./tvMenu";
import { mkTrack, renderTv, setupTvTest } from "./tvTestUtils";

setupTvTest();

it("greys a filtered track card and shows its badge", () => {
  const { container, store } = renderTv(
    <TvRow
      title="R"
      entries={
        sectionEntries([mkTrack(1, { explicit: true })], "TRACK_LIST").entries
      }
    />,
  );
  act(() => store.set(allowExplicitAtom, false));
  const card = container.querySelector("[data-tv-dimmed]") as HTMLElement;
  expect(card).not.toBeNull();
  expect(within(card).getByText("E")).toBeTruthy();
});

it("badges an explicit album card only where asked", () => {
  const entries = sectionEntries(
    [{ id: 5, title: "Loud", cover: "c", explicit: true }],
    "ALBUM_LIST",
  ).entries;
  const r = renderTv(<TvRow title="R" entries={entries} />);
  expect(
    within(screen.getByText("Loud").closest("button")!).queryByText("E"),
  ).toBeNull();
  r.rerender(<TvRow title="R" entries={entries} showExplicit />);
  expect(
    within(screen.getByText("Loud").closest("button")!).getByText("E"),
  ).toBeTruthy();
});

it("indexes a row by position and shows its number", () => {
  renderTv(
    <TvTrackRow
      track={mkTrack(1)}
      index={0}
      position={12}
      number={3}
      onSelect={() => {}}
    />,
  );
  const row = screen.getByText("T1").closest("button")!;
  expect(row.closest(".tv-track-row")!.getAttribute("data-tv-index")).toBe(
    "12",
  );
  expect(within(row).getByText("3")).toBeTruthy();
});

it("puts a heart on each row: Loved Tracks for a track, the collection for a video", () => {
  const store = createStore();
  store.set(favoriteTrackIdsAtom, new Set([1]));
  renderTv(
    <>
      <TvTrackRow track={mkTrack(1)} index={0} onSelect={() => {}} />
      <TvTrackRow track={mkTrack(2)} index={1} onSelect={() => {}} />
      <TvTrackRow
        track={mkTrack(3, { itemType: "video" })}
        index={2}
        onSelect={() => {}}
      />
    </>,
    { store },
  );
  const loved = screen.getByRole("button", {
    name: "Remove from Loved Tracks",
  });
  expect(loved.getAttribute("aria-pressed")).toBe("true");
  expect(loved.hasAttribute("data-tv-focusable")).toBe(true);
  expect(
    screen.getByRole("button", { name: "Add to Loved Tracks" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Add to collection" }),
  ).toBeTruthy();
});

it("keeps the menu on a blocked row unless asked to drop it", () => {
  const store = createStore();
  store.set(allowExplicitAtom, false);
  const track = mkTrack(1, { explicit: true });
  const r = renderTv(
    <TvTrackRow track={track} index={0} onSelect={() => {}} />,
    { store },
  );
  const button = () => screen.getByText("T1").closest("button")!;
  const more = () =>
    within(button().closest(".tv-track-row") as HTMLElement).queryByRole(
      "button",
      { name: "More options" },
    );
  expect(button().hasAttribute("data-tv-has-menu")).toBe(true);
  expect(more()).not.toBeNull();
  r.rerender(
    <TvTrackRow track={track} index={0} blockedNoMenu onSelect={() => {}} />,
  );
  expect(button().hasAttribute("data-tv-has-menu")).toBe(false);
  expect(more()).toBeNull();
});

it("indexes grid cards", () => {
  renderTv(
    <TvGrid
      queueId="g"
      name="G"
      entries={
        sectionEntries(
          [
            { id: 5, title: "A", cover: "c" },
            { id: 6, title: "B", cover: "c" },
          ],
          "ALBUM_LIST",
        ).entries
      }
    />,
  );
  expect(
    screen.getByText("B").closest("button")!.getAttribute("data-tv-index"),
  ).toBe("1");
});

it("a card keeps its focus style and does not shrink in a row", () => {
  renderTv(
    <TvRow
      title="R"
      entries={
        sectionEntries([{ id: 5, title: "A", cover: "c" }], "ALBUM_LIST")
          .entries
      }
    />,
  );
  const card = screen.getByText("A").closest("button")!;
  expect(card.classList.contains("tv-card")).toBe(true);
  expect(card.classList.contains("shrink-0")).toBe(true);
});

it("marks the first grid card for initial focus only when asked", () => {
  const entries = sectionEntries(
    [
      { id: 5, title: "A", cover: "c" },
      { id: 6, title: "B", cover: "c" },
    ],
    "ALBUM_LIST",
  ).entries;
  const card = (t: string) => screen.getByText(t).closest("button")!;
  const r = renderTv(<TvGrid queueId="g" name="G" entries={entries} />);
  expect(card("A").hasAttribute("data-tv-autofocus")).toBe(false);
  r.rerender(<TvGrid queueId="g" name="G" entries={entries} autoFocusFirst />);
  expect(card("A").hasAttribute("data-tv-autofocus")).toBe(true);
  expect(card("B").hasAttribute("data-tv-autofocus")).toBe(false);
});

it("a grid card's menu carries the grid's menu context", () => {
  const { nav } = renderTv(
    <TvGrid
      queueId="g"
      name="G"
      menuContext={{ folderId: "f1" }}
      entries={
        sectionEntries([{ id: 5, title: "A", cover: "c" }], "ALBUM_LIST")
          .entries
      }
    />,
  );
  menuForElement(screen.getByText("A").closest("button")!)!();
  expect(vi.mocked(nav.mediaMenu).mock.lastCall).toEqual([
    expect.objectContaining({ id: 5 }),
    false,
    { folderId: "f1" },
  ]);
});
it("a row card's menu carries the row's menu context", () => {
  const { nav } = renderTv(
    <TvRow
      title="R"
      menuContext={{ folderId: "root" }}
      entries={
        sectionEntries([{ id: 5, title: "A", cover: "c" }], "ALBUM_LIST")
          .entries
      }
    />,
  );
  menuForElement(screen.getByText("A").closest("button")!)!();
  expect(vi.mocked(nav.mediaMenu).mock.lastCall).toEqual([
    expect.objectContaining({ id: 5 }),
    false,
    { folderId: "root" },
  ]);
});
it("calls onActivate before opening a row's card or its View all card", () => {
  const onActivate = vi.fn();
  const { nav } = renderTv(
    <TvRow
      title="R"
      onActivate={onActivate}
      viewAll={{ type: "feed" }}
      entries={
        sectionEntries([{ id: 5, title: "A", cover: "c" }], "ALBUM_LIST")
          .entries
      }
    />,
  );
  act(() => screen.getByText("View all").closest("button")!.click());
  expect(onActivate).toHaveBeenCalledTimes(1);
  expect(vi.mocked(nav.run).mock.lastCall![0]).toEqual({
    kind: "open",
    view: { type: "feed" },
  });
  expect(onActivate.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(nav.run).mock.invocationCallOrder[0],
  );
  act(() => screen.getByText("A").closest("button")!.click());
  expect(onActivate).toHaveBeenCalledTimes(2);
});

it("marqueeShift", () => {
  expect(marqueeShift(300, 200)).toBe(-100);
  expect(marqueeShift(201, 200)).toBeNull();
});
it("arms only overflowing titles, measuring the outer box", () => {
  const root = document.createElement("div");
  root.innerHTML =
    '<span class="tv-marquee"><span>long</span></span><span class="tv-marquee"><span>short</span></span>';
  const [long, short] = Array.from(
    root.querySelectorAll<HTMLElement>(".tv-marquee"),
  );
  Object.defineProperty(long, "clientWidth", { value: 200 });
  Object.defineProperty(long, "scrollWidth", { value: 300 });
  Object.defineProperty(short, "clientWidth", { value: 200 });
  Object.defineProperty(short, "scrollWidth", { value: 200 });
  armMarquee(root);
  expect(long.dataset.overflow).toBeDefined();
  expect(long.style.getPropertyValue("--tv-marquee-shift")).toBe("-100px");
  expect(short.dataset.overflow).toBeUndefined();
});
it("clears a title that no longer overflows", () => {
  const root = document.createElement("div");
  root.innerHTML = '<span class="tv-marquee"><span>t</span></span>';
  const el = root.firstElementChild as HTMLElement;
  let scroll = 1000;
  Object.defineProperty(el, "clientWidth", { value: 200 });
  Object.defineProperty(el, "scrollWidth", { get: () => scroll });
  armMarquee(root);
  expect(el.style.getPropertyValue("--tv-marquee-duration")).toBe("20s");
  scroll = 200;
  armMarquee(root);
  expect(el.dataset.overflow).toBeUndefined();
  expect(el.style.getPropertyValue("--tv-marquee-shift")).toBe("");
  expect(el.style.getPropertyValue("--tv-marquee-duration")).toBe("");
});
it("a title glides once per focus, then settles back to its ellipsis", () => {
  const root = document.createElement("div");
  root.innerHTML = '<span class="tv-marquee"><span>t</span></span>';
  const el = root.firstElementChild as HTMLElement;
  Object.defineProperty(el, "clientWidth", { value: 200 });
  Object.defineProperty(el, "scrollWidth", { value: 300 });
  armMarquee(root);
  expect(el.dataset.marqueeDone).toBeUndefined();
  el.firstElementChild!.dispatchEvent(
    new Event("animationend", { bubbles: true }),
  );
  expect(el.dataset.marqueeDone).toBeDefined();
  armMarquee(root);
  expect(el.dataset.marqueeDone).toBeUndefined();
});
it("focusing a card, tile or track row arms its title", () => {
  const entries = sectionEntries(
    [{ id: 5, title: "Card", cover: "c" }],
    "ALBUM_LIST",
  ).entries;
  renderTv(
    <>
      <TvRow title="R" entries={entries} />
      <TvTile
        entry={
          sectionEntries([{ id: 6, title: "Tile", cover: "c" }], "ALBUM_LIST")
            .entries[0]
        }
        onSelect={() => {}}
      />
      <TvTrackRow track={mkTrack(1)} index={0} onSelect={() => {}} />
    </>,
  );
  for (const text of ["Card", "Tile", "T1"]) {
    const marquee = screen
      .getByText(text)
      .closest(".tv-marquee") as HTMLElement;
    Object.defineProperty(marquee, "clientWidth", { value: 100 });
    Object.defineProperty(marquee, "scrollWidth", { value: 180 });
    fireEvent.focus(screen.getByText(text).closest("button")!);
    expect(marquee.dataset.overflow).toBeDefined();
    expect(marquee.style.getPropertyValue("--tv-marquee-shift")).toBe("-80px");
  }
});
