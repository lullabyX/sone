import { expect, it } from "vitest";
import { caretAllowsLeaving, claimsKey, routeTvKey, textEntryKind, type TvKeyFacts } from "./tvKeys";
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
  expect(r({ key: "Enter", repeat: true })).toEqual({ type: "swallow" });
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
it("claims TV navigation keys and keys it routes", () => {
  expect(claimsKey(facts({ key: "Enter" }), { type: "none" })).toBe(true);
  expect(claimsKey(facts({ key: "m" }), { type: "none" })).toBe(false);
  expect(claimsKey(facts({ key: " ", video: v }), { type: "videoToggle" })).toBe(true);
  expect(claimsKey(facts({ key: "ArrowUp", modified: true }), { type: "none" })).toBe(false);
});
const input = (type: string, value = "") => Object.assign(document.createElement("input"), { type, value });
it("classifies inputs", () => {
  expect(textEntryKind(input("text"))).toBe("caret");
  expect(textEntryKind(input("number"))).toBe("field");
  expect(textEntryKind(input("email"))).toBe("field");
  expect(textEntryKind(input("range"))).toBe("range");
  expect(textEntryKind(input("checkbox"))).toBe(null);
  expect(textEntryKind(document.createElement("textarea"))).toBe("caret");
});
it("lets Left and Right leave a filled number field", () => {
  expect(caretAllowsLeaving(input("number", "8080"), "right")).toBe(true);
  expect(caretAllowsLeaving(input("number", "8080"), "left")).toBe(true);
});
it("keeps Left/Right on a range input, Up/Down leave", () => {
  expect(r({ key: "ArrowRight", field: "range" })).toEqual({ type: "none" });
  expect(r({ key: "ArrowDown", field: "range" })).toEqual({ type: "move", dir: "down", enterSide: true });
  expect(r({ key: "Backspace", field: "range" })).toEqual({ type: "back" });
  expect(r({ key: "Backspace", field: "field" })).toEqual({ type: "none" });
});
it("never repeats a held OK outside a text field", () => {
  expect(r({ key: "Enter", repeat: true, layer: "native" })).toEqual({ type: "swallow" });
  expect(r({ key: "Enter", repeat: true, video: { inControls: true, inQualityList: false } })).toEqual({ type: "swallow" });
  expect(r({ key: "Enter", repeat: true, field: "caret" })).toEqual({ type: "none" });
});
