import { expect, it } from "vitest";
import { act, screen, within } from "@testing-library/react";
import { allowExplicitAtom } from "../../atoms/playback";
import { TvGrid, TvRow, TvTrackRow } from "./TvParts";
import { sectionEntries } from "./tvItems";
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

it("indexes grid cards", () => {
  renderTv(<TvGrid queueId="g" name="G" entries={sectionEntries([{ id: 5, title: "A", cover: "c" }, { id: 6, title: "B", cover: "c" }], "ALBUM_LIST").entries} />);
  expect(screen.getByText("B").closest("button")!.getAttribute("data-tv-index")).toBe("1");
});
