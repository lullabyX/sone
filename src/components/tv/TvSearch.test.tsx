import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { SearchResults } from "../../types";
import TvSearch from "./TvSearch";
import { pressKey, renderTv, setupTvTest } from "./tvTestUtils";

setupTvTest();
const searchTidal = vi.hoisted(() =>
  vi.fn((_query: string, _limit?: number): Promise<SearchResults> => new Promise(() => {})));
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()), searchTidal }));
it("does not pull typing out of an open prompt", () => {
  renderTv(<><TvSearch /><div data-tv-modal><button>ok</button></div></>);
  const ok = screen.getByText("ok");
  ok.focus();
  pressKey(ok, { key: "a" });
  expect(document.activeElement).toBe(ok);
  expect((screen.getByPlaceholderText("Search TIDAL") as HTMLInputElement).value).toBe("");
});
