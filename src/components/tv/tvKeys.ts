import type { Direction } from "../../lib/spatialNav";

export type TextEntryKind = "caret" | "field" | "range" | null;

/** Input types with a selection, where Left/Right move the caret. */
const CARET_TYPES = new Set(["text", "search", "url", "tel", "password"]);

const NON_TEXT_TYPES = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "color",
  "file",
  "image",
  "hidden",
]);

export function textEntryKind(el: EventTarget | null): TextEntryKind {
  if (el instanceof HTMLTextAreaElement) return "caret";
  if (!(el instanceof HTMLInputElement)) return null;
  if (CARET_TYPES.has(el.type)) return "caret";
  if (el.type === "range") return "range";
  return NON_TEXT_TYPES.has(el.type) ? null : "field";
}

/** Left/Right inside a text field move the caret until it reaches the edge. */
export function caretAllowsLeaving(
  el: HTMLInputElement | HTMLTextAreaElement,
  dir: Direction,
): boolean {
  if (dir === "up" || dir === "down") return true;
  if (textEntryKind(el) !== "caret") return true;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  if (start !== end) return false;
  return dir === "left" ? start === 0 : end === el.value.length;
}

export type TvLayer = "none" | "menu" | "prompt" | "native";

export interface TvKeyFacts {
  key: string;
  code: string;
  repeat: boolean;
  composing: boolean;
  /** Ctrl, Alt or Meta (Shift is not a modifier here). */
  modified: boolean;
  /** Set while the full-screen video overlay shows. */
  video: { inControls: boolean; inQualityList: boolean } | null;
  /** Kind of the top `[data-tv-modal]`. */
  layer: TvLayer;
  /** Kind of the event target. */
  field: TextEntryKind;
  fieldEmpty: boolean;
  caretLeaves: { left: boolean; right: boolean };
  /** "lost": outside the TV root while no layer is open. */
  focus: "rail" | "content" | "lost";
  /** Only computed when focus is "lost"; true otherwise. */
  screenHasFocusable: boolean;
  /** Enter only: the focused element has an action menu. */
  hasMenu: boolean;
  /** An Enter long press is in progress. */
  holding: boolean;
  nativeEditable: boolean;
}

export type TvMediaCommand = { kind: "toggle" | "next" | "previous" };

export type TvKeyAction =
  | { type: "none" }
  | { type: "swallow" }
  | { type: "media"; command: TvMediaCommand }
  | { type: "move"; dir: Direction; enterSide: boolean }
  | { type: "focusContent" }
  | { type: "back" }
  | { type: "nativeEscape" }
  | { type: "openMenu" }
  | { type: "pressStart" }
  | { type: "videoToggle" }
  | { type: "videoSeek"; by: number }
  | { type: "videoBack" }
  | { type: "videoControls" }
  | { type: "videoMove"; dir: Direction }
  /** Not preventDefaulted: the focused quality entry clicks natively. */
  | { type: "videoNativeEnter" };

const ARROWS: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

const BACK_KEYS = new Set(["Escape", "BrowserBack", "GoBack"]);

const TV_NAV_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "Backspace",
  "Escape",
  "BrowserBack",
  "GoBack",
  "ContextMenu",
]);

const MEDIA_KEYS: Record<string, TvMediaCommand["kind"]> = {
  MediaPlayPause: "toggle",
  MediaTrackNext: "next",
  MediaTrackPrevious: "previous",
};

/** How far Left/Right skip in a video, in seconds. */
const VIDEO_SKIP_S = 10;

/**
 * The video player owns the screen. Without a control focused, Enter pauses
 * and resumes, Left/Right skip and Up/Down move into the player's buttons;
 * there the arrows move between them and Back leaves them again. Back
 * otherwise returns to Now Playing with the video still playing (Escape
 * closes it, through the player itself).
 */
function routeVideoKey(
  f: TvKeyFacts,
  video: NonNullable<TvKeyFacts["video"]>,
): TvKeyAction {
  if (f.key === "Backspace" || f.key === "BrowserBack") {
    return { type: "videoBack" };
  }
  if (video.inControls) {
    if (f.key === "Enter" && video.inQualityList) {
      return { type: "videoNativeEnter" };
    }
    const dir = ARROWS[f.key];
    return dir ? { type: "videoMove", dir } : { type: "none" };
  }
  switch (f.key) {
    case "Enter":
    case " ":
    case "MediaPlayPause":
      return f.repeat ? { type: "swallow" } : { type: "videoToggle" };
    case "ArrowLeft":
      return { type: "videoSeek", by: -VIDEO_SKIP_S };
    case "ArrowRight":
      return { type: "videoSeek", by: VIDEO_SKIP_S };
    case "ArrowUp":
    case "ArrowDown":
      return { type: "videoControls" };
  }
  return { type: "none" };
}

export function routeTvKey(f: TvKeyFacts): TvKeyAction {
  if (f.modified) return { type: "none" };
  // A held OK must not click over and over (or confirm what it just opened).
  if (
    f.key === "Enter" &&
    f.repeat &&
    f.field !== "caret" &&
    f.field !== "field"
  ) {
    return { type: "swallow" };
  }
  if (f.video) return routeVideoKey(f, f.video);

  const media = MEDIA_KEYS[f.key];
  if (media) return { type: "media", command: { kind: media } };
  if (f.key === "ContextMenu") return { type: "openMenu" };
  if (f.key === "Enter") {
    // While Enter is held after a long press, its auto-repeat must not
    // activate whatever the menu focused (its first entry).
    if (f.holding) return { type: "swallow" };
    if (!f.hasMenu) return { type: "none" };
    return f.repeat ? { type: "swallow" } : { type: "pressStart" };
  }

  const dir = ARROWS[f.key];
  if (dir) {
    if (
      (dir === "left" || dir === "right") &&
      (f.field === "range" || (f.field === "caret" && !f.caretLeaves[dir]))
    ) {
      return { type: "none" };
    }
    // Focus got lost (its element went away, e.g. a played "Up next" row):
    // pick up in the current screen, not in the hidden rail.
    if (f.focus === "lost" && f.screenHasFocusable) {
      return { type: "focusContent" };
    }
    return { type: "move", dir, enterSide: !f.repeat };
  }

  const typing = f.field === "caret" || f.field === "field";
  if (BACK_KEYS.has(f.key) || (f.key === "Backspace" && !typing)) {
    // A desktop dialog handles Escape through its own dismiss handler.
    if (f.layer === "native") {
      return f.key === "Escape" ? { type: "none" } : { type: "nativeEscape" };
    }
    return { type: "back" };
  }
  return { type: "none" };
}

/** The key is TV's, so desktop shortcuts must not fire on it. Enter on an
 *  item without a menu routes "none" (a native click) but is still TV's. */
export function claimsKey(f: TvKeyFacts, action: TvKeyAction): boolean {
  return !f.modified && (action.type !== "none" || TV_NAV_KEYS.has(f.key));
}
