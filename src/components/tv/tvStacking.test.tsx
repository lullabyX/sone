import { expect, it } from "vitest";
import videoSrc from "../VideoPlayer.tsx?raw";
import menuSrc from "./TvMenuHost.tsx?raw";
import promptSrc from "./TvPrompt.tsx?raw";
import tvAppSrc from "./TvApp.tsx?raw";
import TvNativeLayer from "./TvNativeLayer";
import { renderTv, setupTvTest } from "./tvTestUtils";

setupTvTest();

const num = (src: string, re: RegExp) => Number(re.exec(src)?.[1]);
const VIDEO = num(videoSrc, /role="dialog"[\s\S]*?z-\[(\d+)\]/);

it("reads the video player's layer", () => {
  expect(VIDEO).toBe(9998);
});

it("the action menu and the prompt draw above the video player", () => {
  expect(num(menuSrc, /fixed inset-0 z-\[(\d+)\]/)).toBeGreaterThan(VIDEO);
  expect(num(promptSrc, /fixed inset-0 z-\[(\d+)\]/)).toBeGreaterThan(VIDEO);
});

it("the menu and the prompt keep their content inside the screen margin", () => {
  expect(menuSrc).toMatch(/fixed inset-0 z-\[10000\] tv-overlay/);
  expect(promptSrc).toMatch(/fixed inset-0 z-\[10000\] tv-overlay/);
});

it("a native layer (More settings, Signal path) is one layer above the video player", () => {
  const { container } = renderTv(
    <TvNativeLayer width={800}>
      <div className="fixed inset-0 z-50" />
    </TvNativeLayer>,
  );
  const layer = container.querySelector("[data-tv-native]") as HTMLElement;
  expect(layer.style.position).toBe("relative");
  expect(Number(layer.style.zIndex)).toBeGreaterThan(VIDEO);
});

it("TvApp draws More settings, then the action menu, then the prompt", () => {
  const at = (re: RegExp) => tvAppSrc.search(re);
  expect(at(/<TvNativeLayer\b/)).toBeGreaterThan(-1);
  expect(at(/<TvNativeLayer\b/)).toBeLessThan(at(/<TvMenuHost\b/));
  expect(at(/<TvMenuHost\b/)).toBeLessThan(at(/<TvPrompt\b/));
});
