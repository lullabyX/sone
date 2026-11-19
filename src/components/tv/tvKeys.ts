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
  video: {
    inControls: boolean;
    inQualityList: boolean;
    /** Focus is on the player's volume slider. */
    onVolume: boolean;
  } | null;
  /** Kind of the top `[data-tv-modal]`. */
  layer: TvLayer;
  /** Kind of the event target. */
  field: TextEntryKind;
  fieldEmpty: boolean;
  caretLeaves: { left: boolean; right: boolean };
  /** "lost": outside the TV root, or on an element not shown, while no
   *  layer is open. */
  focus: "rail" | "content" | "lost";
  /** Only computed when focus is "lost"; true otherwise. */
  screenHasFocusable: boolean;
  /** Focus is lost while the screen loads its next page; false otherwise. */
  screenLoading: boolean;
  /** Enter only: the focused element has an action menu. */
  hasMenu: boolean;
  /** An Enter long press is in progress. */
  holding: boolean;
  /** A caret/field input in a desktop dialog shown in TV mode (not the video). */
  nativeEditable: boolean;
}

export type TvMediaCommand =
  | { kind: "toggle" | "play" | "pause" | "next" | "previous" | "mute" }
  /** Seconds, ±TV_SEEK_STEP_S. */
  | { kind: "seek"; by: number }
  /** ±TV_VOLUME_STEP. */
  | { kind: "volume"; by: number };

export const TV_SEEK_STEP_S = 10;
export const TV_VOLUME_STEP = 0.05;

export type TvKeyAction =
  | { type: "none" }
  | { type: "swallow" }
  | { type: "media"; command: TvMediaCommand }
  | { type: "move"; dir: Direction; enterSide: boolean }
  | { type: "focusContent" }
  | { type: "focusRail" }
  | { type: "leaveRail" }
  | { type: "back" }
  | { type: "nativeEscape" }
  | { type: "openMenu" }
  | { type: "closeMenu" }
  | { type: "pressStart" }
  | { type: "editField" }
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

const VIDEO_BACK_KEYS = new Set([
  "Backspace",
  "BrowserBack",
  "GoBack",
  "Escape",
]);

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

const MEDIA_KEYS: Record<string, TvMediaCommand> = {
  MediaPlayPause: { kind: "toggle" },
  MediaPause: { kind: "pause" },
  // The TV interface has no stopped state.
  MediaStop: { kind: "pause" },
  MediaTrackNext: { kind: "next" },
  MediaTrackPrevious: { kind: "previous" },
  MediaFastForward: { kind: "seek", by: TV_SEEK_STEP_S },
  MediaRewind: { kind: "seek", by: -TV_SEEK_STEP_S },
  AudioVolumeUp: { kind: "volume", by: TV_VOLUME_STEP },
  AudioVolumeDown: { kind: "volume", by: -TV_VOLUME_STEP },
  AudioVolumeMute: { kind: "mute" },
};

/** WebKitGTK reports the play/pause key as `MediaPlay`; only its `code` is
 *  `MediaPlayPause`. */
export function mediaCommandForKey(
  key: string,
  code: string,
): TvMediaCommand | null {
  if (key === "MediaPlay") {
    return { kind: code === "MediaPlayPause" ? "toggle" : "play" };
  }
  return MEDIA_KEYS[key] ?? null;
}

/**
 * The video player owns the screen. Without a control focused, Enter pauses
 * and resumes, Left/Right skip and Up/Down move into the player's buttons;
 * there the arrows move between them (Left/Right on the volume slider change
 * the volume) and Back leaves them again. Back and Escape otherwise return
 * to Now Playing with the video still playing.
 */
function routeVideoKey(
  f: TvKeyFacts,
  video: NonNullable<TvKeyFacts["video"]>,
): TvKeyAction {
  if (VIDEO_BACK_KEYS.has(f.key)) {
    return { type: "videoBack" };
  }
  if (video.inControls) {
    if (f.key === "Enter" && video.inQualityList) {
      return { type: "videoNativeEnter" };
    }
    if (video.onVolume && (f.key === "ArrowLeft" || f.key === "ArrowRight")) {
      const by = f.key === "ArrowRight" ? TV_VOLUME_STEP : -TV_VOLUME_STEP;
      return { type: "media", command: { kind: "volume", by } };
    }
    const dir = ARROWS[f.key];
    return dir ? { type: "videoMove", dir } : { type: "none" };
  }
  switch (f.key) {
    case "Enter":
    case " ":
      return f.repeat ? { type: "swallow" } : { type: "videoToggle" };
    case "ArrowLeft":
      return { type: "videoSeek", by: -TV_SEEK_STEP_S };
    case "ArrowRight":
      return { type: "videoSeek", by: TV_SEEK_STEP_S };
    case "ArrowUp":
    case "ArrowDown":
      return { type: "videoControls" };
  }
  return { type: "none" };
}

function isFieldEdit(f: TvKeyFacts): boolean {
  return (
    f.key === "Enter" &&
    f.nativeEditable &&
    !f.repeat &&
    !f.composing &&
    !f.modified
  );
}

export function routeTvKey(f: TvKeyFacts): TvKeyAction {
  if (f.modified) return { type: "none" };
  // An input method owns every key until the text is composed.
  if (f.composing) return { type: "none" };
  // A settings text field is edited with the on-screen keyboard.
  if (isFieldEdit(f)) return { type: "editField" };
  // A held OK must not click over and over (or confirm what it just opened).
  if (
    f.key === "Enter" &&
    f.repeat &&
    f.field !== "caret" &&
    f.field !== "field"
  ) {
    return { type: "swallow" };
  }
  // Media keys work everywhere: in every layer, text field and the video.
  const media = mediaCommandForKey(f.key, f.code);
  if (media) {
    const repeats = media.kind === "seek" || media.kind === "volume";
    return f.repeat && !repeats
      ? { type: "swallow" }
      : { type: "media", command: media };
  }
  if (f.video) return routeVideoKey(f, f.video);

  // The Menu key toggles the action menu, as the Home key does the rail.
  if (f.key === "ContextMenu") {
    if (f.layer === "menu")
      return f.repeat ? { type: "swallow" } : { type: "closeMenu" };
    return { type: "openMenu" };
  }
  // A remote's Home key (a controller's Create / View): the rail from
  // anywhere, and back to the screen from the rail.
  if (f.key === "BrowserHome") {
    if (f.layer !== "none" || f.repeat) return { type: "swallow" };
    return f.focus === "rail" ? { type: "leaveRail" } : { type: "focusRail" };
  }
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
    // pick up in the current screen, not in the hidden rail. On a screen
    // with nothing to focus yet (still loading), only Left goes anywhere.
    if (f.focus === "lost") {
      // The screen places focus itself once the page lands.
      if (f.screenLoading) return { type: "swallow" };
      if (f.screenHasFocusable) return { type: "focusContent" };
      return dir === "left" ? { type: "focusRail" } : { type: "swallow" };
    }
    return { type: "move", dir, enterSide: !f.repeat };
  }

  const typing = f.field === "caret" || f.field === "field";
  // Backspace on the prompt's empty text cancels it.
  const cancelsPrompt = f.layer === "prompt" && f.fieldEmpty;
  if (
    BACK_KEYS.has(f.key) ||
    (f.key === "Backspace" && (!typing || cancelsPrompt))
  ) {
    // A desktop dialog handles Escape through its own dismiss handler.
    if (f.layer === "native" && f.key === "Escape") return { type: "none" };
    // A held Back goes back once.
    if (f.repeat) return { type: "swallow" };
    if (f.layer === "native") return { type: "nativeEscape" };
    // On the rail, Back closes it and returns to the screen.
    if (f.layer === "none" && f.focus === "rail") {
      return { type: "leaveRail" };
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

/** Keys TV carries out in the capture phase, so the desktop dismiss stack
 *  never sees them: it would close the video or the layer under a TV one. */
export function takesAtCapture(f: TvKeyFacts): boolean {
  if (f.video && !f.modified && BACK_KEYS.has(f.key)) return true;
  // Before the field's own Enter handler applies the old value.
  if (isFieldEdit(f)) return true;
  return f.key === "Escape" && (f.layer === "menu" || f.layer === "prompt");
}
