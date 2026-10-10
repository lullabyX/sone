import type { createStore } from "jotai";
import { allowAiAtom, allowExplicitAtom } from "../atoms/playback";

type Store = ReturnType<typeof createStore>;
type BlockReason = "ai" | "explicit";
type Flagged = { explicit?: boolean; ai?: boolean } | null | undefined;

export type ContentPrefs = { allowExplicit: boolean; allowAi: boolean };

export function contentBlockReason(
  item: Flagged,
  prefs: ContentPrefs,
): BlockReason | null {
  if (!item) return null;
  if (!prefs.allowAi && item.ai === true) return "ai";
  if (!prefs.allowExplicit && item.explicit === true) return "explicit";
  return null;
}

export function isContentBlocked(item: Flagged, prefs: ContentPrefs): boolean {
  return contentBlockReason(item, prefs) !== null;
}

export function blockedMessage(reason: BlockReason): string {
  return reason === "ai"
    ? "AI content is turned off in Settings"
    : "Explicit content is turned off in Settings";
}

export function readContentPrefs(store: Store): ContentPrefs {
  return {
    allowExplicit: store.get(allowExplicitAtom),
    allowAi: store.get(allowAiAtom),
  };
}
