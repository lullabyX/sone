import { expect, it } from "vitest";
import { act, screen, within } from "@testing-library/react";
import { allowExplicitAtom } from "../../atoms/playback";
import { TvRow } from "./TvParts";
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
