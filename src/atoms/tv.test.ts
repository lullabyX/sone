import { afterEach, expect, it } from "vitest";
import { setupTvTest } from "../components/tv/tvTestUtils";
import { legacyTvOverscan } from "./tv";

setupTvTest();

afterEach(() => localStorage.removeItem("sone.tvOverscan.v1"));

it("carries the old single margin over to both axes", () => {
  localStorage.setItem("sone.tvOverscan.v1", "2.5");
  expect(legacyTvOverscan()).toEqual({ x: 2.5, y: 2.5 });
});

it("starts without a margin when none or an unreadable one was saved", () => {
  expect(legacyTvOverscan()).toEqual({ x: 0, y: 0 });
  localStorage.setItem("sone.tvOverscan.v1", "{oops");
  expect(legacyTvOverscan()).toEqual({ x: 0, y: 0 });
});
