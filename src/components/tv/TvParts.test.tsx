import { expect, it, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
import { createStore } from "jotai";
import { allowExplicitAtom } from "../../atoms/playback";
import { TvGrid, TvRow, TvTrackRow } from "./TvParts";
import { sectionEntries } from "./tvItems";
import { menuForElement } from "./tvMenu";
import { mkTrack, renderTv, setupTvTest } from "./tvTestUtils";

setupTvTest();

it("greys a filtered track card and shows its badge", () => {
  const { container, store } = renderTv(
    <TvRow title="R" entries={sectionEntries([mkTrack(1, { explicit: true })], "TRACK_LIST").entries} />);
  act(() => store.set(allowExplicitAtom, false));
  const card = container.querySelector("[data-tv-dimmed]") as HTMLElement;
  expect(card).not.toBeNull();
  expect(within(card).getByText("E")).toBeTruthy();
});

it("badges an explicit album card only where asked", () => {
  const entries = sectionEntries([{ id: 5, title: "Loud", cover: "c", explicit: true }], "ALBUM_LIST").entries;
  const r = renderTv(<TvRow title="R" entries={entries} />);
  expect(within(screen.getByText("Loud").closest("button")!).queryByText("E")).toBeNull();
  r.rerender(<TvRow title="R" entries={entries} showExplicit />);
  expect(within(screen.getByText("Loud").closest("button")!).getByText("E")).toBeTruthy();
});

it("indexes a row by position and shows its number", () => {
  renderTv(<TvTrackRow track={mkTrack(1)} index={0} position={12} number={3} onSelect={() => {}} />);
  const row = screen.getByText("T1").closest("button")!;
  expect(row.closest(".tv-track-row")!.getAttribute("data-tv-index")).toBe("12");
  expect(within(row).getByText("3")).toBeTruthy();
});

it("keeps the menu on a blocked row unless asked to drop it", () => {
  const store = createStore();
  store.set(allowExplicitAtom, false);
  const track = mkTrack(1, { explicit: true });
  const r = renderTv(<TvTrackRow track={track} index={0} onSelect={() => {}} />, { store });
  const button = () => screen.getByText("T1").closest("button")!;
  const more = () => within(button().closest(".tv-track-row") as HTMLElement).queryByRole("button", { name: "More options" });
  expect(button().hasAttribute("data-tv-has-menu")).toBe(true);
  expect(more()).not.toBeNull();
  r.rerender(<TvTrackRow track={track} index={0} blockedNoMenu onSelect={() => {}} />);
  expect(button().hasAttribute("data-tv-has-menu")).toBe(false);
  expect(more()).toBeNull();
});

it("indexes grid cards", () => {
  renderTv(<TvGrid queueId="g" name="G" entries={sectionEntries([{ id: 5, title: "A", cover: "c" }, { id: 6, title: "B", cover: "c" }], "ALBUM_LIST").entries} />);
  expect(screen.getByText("B").closest("button")!.getAttribute("data-tv-index")).toBe("1");
});

it("a card keeps its focus style and does not shrink in a row", () => {
  renderTv(<TvRow title="R" entries={sectionEntries([{ id: 5, title: "A", cover: "c" }], "ALBUM_LIST").entries} />);
  const card = screen.getByText("A").closest("button")!;
  expect(card.classList.contains("tv-card")).toBe(true);
  expect(card.classList.contains("shrink-0")).toBe(true);
});

it("marks the first grid card for initial focus only when asked", () => {
  const entries = sectionEntries([{ id: 5, title: "A", cover: "c" }, { id: 6, title: "B", cover: "c" }], "ALBUM_LIST").entries;
  const card = (t: string) => screen.getByText(t).closest("button")!;
  const r = renderTv(<TvGrid queueId="g" name="G" entries={entries} />);
  expect(card("A").hasAttribute("data-tv-autofocus")).toBe(false);
  r.rerender(<TvGrid queueId="g" name="G" entries={entries} autoFocusFirst />);
  expect(card("A").hasAttribute("data-tv-autofocus")).toBe(true);
  expect(card("B").hasAttribute("data-tv-autofocus")).toBe(false);
});

it("a grid card's menu carries the grid's menu context", () => {
  const { nav } = renderTv(<TvGrid queueId="g" name="G" menuContext={{ folderId: "f1" }}
    entries={sectionEntries([{ id: 5, title: "A", cover: "c" }], "ALBUM_LIST").entries} />);
  menuForElement(screen.getByText("A").closest("button")!)!();
  expect(vi.mocked(nav.mediaMenu).mock.lastCall).toEqual([expect.objectContaining({ id: 5 }), false, { folderId: "f1" }]);
});
it("a row card's menu carries the row's menu context", () => {
  const { nav } = renderTv(<TvRow title="R" menuContext={{ folderId: "root" }}
    entries={sectionEntries([{ id: 5, title: "A", cover: "c" }], "ALBUM_LIST").entries} />);
  menuForElement(screen.getByText("A").closest("button")!)!();
  expect(vi.mocked(nav.mediaMenu).mock.lastCall).toEqual([expect.objectContaining({ id: 5 }), false, { folderId: "root" }]);
});
