import { expect, it } from "vitest";
import { setupTvTest } from "../components/tv/tvTestUtils";
import { nextTvOverscan, type TvOverscan } from "./tv";

setupTvTest();

it("cycles the margin", () => {
  expect([0, 2.5, 5].map((v) => nextTvOverscan(v as TvOverscan))).toEqual([
    2.5, 5, 0,
  ]);
});
