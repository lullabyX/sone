import { createStore } from "jotai";
import { expect, it } from "vitest";
import { tvOverscanAtom } from "../../atoms/tv";
import { tvNativeFitHeight, tvNativeZoom } from "./tvNative";
import TvNativeLayer from "./TvNativeLayer";
import { renderTv, setupTvTest } from "./tvTestUtils";

setupTvTest();

it("desktop 9.5px labels reach 16px at 1080p", () => {
  expect(9.5 * tvNativeZoom(24, 1920, 800)).toBeGreaterThanOrEqual(16);
});

it("never wider than the screen", () => {
  expect(800 * tvNativeZoom(48, 1920, 800)).toBeLessThanOrEqual(
    1920 * 0.95 + 1e-9,
  );
});

it("stays inside the screen margin", () => {
  expect(800 * tvNativeZoom(48, 1920, 800, 5)).toBeLessThanOrEqual(
    1920 * 0.85 + 1e-9,
  );
});

it("never below 1", () => {
  expect(tvNativeZoom(14, 1280, 800)).toBe(1);
});

it("the sheet fits the safe area", () => {
  const z = tvNativeZoom(24, 1920, 800);
  expect(tvNativeFitHeight(1080, z, 5) * z).toBeCloseTo(1080 * 0.84);
});

it("publishes the fit height for the hosted dialog", () => {
  document.documentElement.style.fontSize = "24px"; // jsdom: innerWidth 1024, innerHeight 768
  const store = createStore();
  store.set(tvOverscanAtom, 5);
  const { container } = renderTv(
    <TvNativeLayer width={800}>
      <div />
    </TvNativeLayer>,
    { store },
  );
  const layer = container.querySelector("[data-tv-native]") as HTMLElement;
  const z = tvNativeZoom(24, 1024, 800, 5);
  expect(layer.style.getPropertyValue("--tv-native-fit-h")).toBe(
    `${tvNativeFitHeight(768, z, 5)}px`,
  );
});
