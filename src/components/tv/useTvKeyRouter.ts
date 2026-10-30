import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useStore, type createStore } from "jotai";
import { currentVideoAtom, videoExpandedAtom } from "../../atoms/video";
import { menuForElement } from "./tvMenu";
import { claimKey } from "../../lib/keyClaim";
import {
  caretAllowsLeaving,
  claimsKey,
  routeTvKey,
  takesAtCapture,
  textEntryKind,
  type TvKeyAction,
  type TvKeyFacts,
  type TvLayer,
} from "./tvKeys";

type Store = ReturnType<typeof createStore>;

interface TvKeyRouterOptions {
  rootRef: RefObject<HTMLElement | null>;
  railRef: RefObject<HTMLElement | null>;
  holding: () => boolean;
  execute: (action: TvKeyAction, e: KeyboardEvent) => void;
  /** Called for every unmodified key while the video overlay shows. */
  wakeVideo: () => void;
}

/** The modal (action menu, prompt, settings sheet) that keeps focus to itself. */
export function topTvModal(): HTMLElement | null {
  const modals = document.querySelectorAll<HTMLElement>("[data-tv-modal]");
  return modals[modals.length - 1] ?? null;
}

function layerOf(el: HTMLElement | null): TvLayer {
  if (!el) return "none";
  if (el.hasAttribute("data-tv-native")) return "native";
  if (el.getAttribute("role") === "menu") return "menu";
  if (el.hasAttribute("data-tv-prompt")) return "prompt";
  return "none";
}

function readVideoFacts(store: Store): TvKeyFacts["video"] {
  if (!store.get(currentVideoAtom) || !store.get(videoExpandedAtom)) {
    return null;
  }
  const dialog =
    document
      .querySelector("[role='dialog'] video")
      ?.closest<HTMLElement>("[role='dialog']") ?? null;
  const active = document.activeElement;
  const inControls =
    !!dialog &&
    (active instanceof HTMLButtonElement ||
      active instanceof HTMLInputElement) &&
    dialog.contains(active);
  // The quality picker's list follows its button while open.
  const list = dialog?.querySelector(
    "button[title='Quality']",
  )?.nextElementSibling;
  const inQualityList = list instanceof HTMLElement && list.contains(active);
  return { inControls, inQualityList };
}

function readTvKeyFacts(
  e: KeyboardEvent,
  store: Store,
  opts: TvKeyRouterOptions,
): TvKeyFacts {
  const target = e.target;
  const field = textEntryKind(target);
  const text =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? target
      : null;
  const layer = layerOf(topTvModal());
  const active = document.activeElement;
  const root = opts.rootRef.current;

  let focus: TvKeyFacts["focus"] = "content";
  if (opts.railRef.current?.contains(active)) focus = "rail";
  else if (layer === "none" && !root?.contains(active)) focus = "lost";

  return {
    key: e.key,
    code: e.code,
    repeat: e.repeat,
    composing: e.isComposing,
    modified: e.ctrlKey || e.altKey || e.metaKey,
    video: readVideoFacts(store),
    layer,
    field,
    fieldEmpty: !!text && text.value === "",
    caretLeaves:
      field === "caret" && text
        ? {
            left: caretAllowsLeaving(text, "left"),
            right: caretAllowsLeaving(text, "right"),
          }
        : { left: true, right: true },
    focus,
    screenHasFocusable:
      focus !== "lost" ||
      !!root
        ?.querySelector(".tv-screen:not(.hidden)")
        ?.querySelector("[data-tv-focusable]"),
    hasMenu: e.key === "Enter" && menuForElement(active) !== null,
    holding: opts.holding(),
    nativeEditable:
      !!field && !!text?.closest("[data-tv-native]:not([data-tv-video])"),
  };
}

/**
 * Routes every key the TV interface handles. In the capture phase it only
 * claims TV's keys, so desktop shortcuts skip them, and carries out the few
 * that desktop dialogs must never see (`takesAtCapture`). The rest execute in
 * the bubble phase so element handlers (the seek bar, the on-screen keyboard)
 * win first; a key one of them prevented is left alone.
 */
export function useTvKeyRouter(opts: TvKeyRouterOptions): void {
  const store = useStore();
  const optsRef = useRef(opts);
  useLayoutEffect(() => {
    optsRef.current = opts;
  });

  useEffect(() => {
    const onClaim = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const o = optsRef.current;
      const facts = readTvKeyFacts(e, store, o);
      const action = routeTvKey(facts);
      if (takesAtCapture(facts)) {
        claimKey(e);
        e.stopPropagation();
        e.preventDefault();
        if (facts.video && !facts.modified) o.wakeVideo();
        if (action.type !== "none") o.execute(action, e);
        return;
      }
      if (claimsKey(facts, action)) claimKey(e);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const o = optsRef.current;
      const facts = readTvKeyFacts(e, store, o);
      if (facts.video && !facts.modified) o.wakeVideo();
      const action = routeTvKey(facts);
      if (action.type === "none") return;
      if (action.type !== "videoNativeEnter") e.preventDefault();
      o.execute(action, e);
    };
    window.addEventListener("keydown", onClaim, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onClaim, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [store]);
}
