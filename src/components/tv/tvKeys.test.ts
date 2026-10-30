import { expect, it } from "vitest";
import { routeTvKey, type TvKeyFacts } from "./tvKeys";
import { setupTvTest } from "./tvTestUtils";

setupTvTest();
const facts = (o: Partial<TvKeyFacts> = {}): TvKeyFacts => ({
  key: "", code: "", repeat: false, composing: false, modified: false, video: null, layer: "none",
  field: null, fieldEmpty: false, caretLeaves: { left: true, right: true }, focus: "content",
  screenHasFocusable: true, hasMenu: false, holding: false, nativeEditable: false, ...o,
});
const r = (o: Partial<TvKeyFacts>) => routeTvKey(facts(o));
const v = { inControls: false, inQualityList: false };
it("characterizes today's routing", () => {
  expect(r({ key: "ArrowDown" })).toEqual({ type: "move", dir: "down", enterSide: true });
  expect(r({ key: "ArrowLeft", repeat: true })).toEqual({ type: "move", dir: "left", enterSide: false });
  expect(r({ key: "ArrowRight", field: "caret", caretLeaves: { left: true, right: false } })).toEqual({ type: "none" });
  expect(r({ key: "ArrowDown", focus: "lost" })).toEqual({ type: "focusContent" });
  expect(r({ key: "ArrowDown", focus: "lost", screenHasFocusable: false })).toEqual({ type: "move", dir: "down", enterSide: true });
  expect(r({ key: "ArrowUp", modified: true })).toEqual({ type: "none" });
  expect(r({ key: "Backspace" })).toEqual({ type: "back" });
  expect(r({ key: "Backspace", field: "caret" })).toEqual({ type: "none" });
  expect(r({ key: "Escape", field: "caret" })).toEqual({ type: "back" });
  expect(r({ key: "Escape", layer: "native" })).toEqual({ type: "none" });
  expect(r({ key: "BrowserBack", layer: "native" })).toEqual({ type: "nativeEscape" });
  expect(r({ key: "GoBack", layer: "prompt" })).toEqual({ type: "back" });
  expect(r({ key: "Enter", hasMenu: true })).toEqual({ type: "pressStart" });
  expect(r({ key: "Enter", hasMenu: true, repeat: true })).toEqual({ type: "swallow" });
  expect(r({ key: "Enter", holding: true })).toEqual({ type: "swallow" });
  expect(r({ key: "Enter" })).toEqual({ type: "none" });
  expect(r({ key: "Enter", repeat: true })).toEqual({ type: "none" });
  expect(r({ key: "ContextMenu" })).toEqual({ type: "openMenu" });
  expect(r({ key: "MediaPlayPause" })).toEqual({ type: "media", command: { kind: "toggle" } });
  expect(r({ key: "MediaTrackNext" })).toEqual({ type: "media", command: { kind: "next" } });
  expect(r({ key: "Enter", video: v })).toEqual({ type: "videoToggle" });
  expect(r({ key: " ", video: v })).toEqual({ type: "videoToggle" });
  expect(r({ key: "MediaPlayPause", video: v })).toEqual({ type: "videoToggle" });
  expect(r({ key: "Enter", video: v, repeat: true })).toEqual({ type: "swallow" });
  expect(r({ key: "ArrowLeft", video: v })).toEqual({ type: "videoSeek", by: -10 });
  expect(r({ key: "ArrowUp", video: v })).toEqual({ type: "videoControls" });
  expect(r({ key: "Backspace", video: v })).toEqual({ type: "videoBack" });
  expect(r({ key: "ArrowRight", video: { ...v, inControls: true } })).toEqual({ type: "videoMove", dir: "right" });
  expect(r({ key: "Enter", video: { ...v, inControls: true } })).toEqual({ type: "none" });
  expect(r({ key: "Enter", video: { inControls: true, inQualityList: true } })).toEqual({ type: "videoNativeEnter" });
  expect(r({ key: "Escape", video: v })).toEqual({ type: "none" }); // today: the player's own Escape closes it
  expect(r({ key: "MediaTrackNext", video: v })).toEqual({ type: "none" });
  expect(r({ key: "m", video: v })).toEqual({ type: "none" });
});
