import { X, type LucideIcon } from "lucide-react";
import { getArtistPage } from "../../api/tidal";
import { getArtistImage } from "../../utils/itemHelpers";
import type { TvMenuHostHandle } from "./TvMenuHost";
import type { TvNav } from "./TvNavContext";
import type { TvPromptRequest } from "./TvPrompt";

export interface TvMenuItem {
  label: string;
  icon?: LucideIcon;
  /** Runs the action; the menu closes afterwards. */
  onSelect?: () => void | Promise<void>;
  /** Opens a nested menu instead (Back returns to this one). */
  submenu?: () => TvMenuSpec | Promise<TvMenuSpec>;
  /** Asks for text first (a search), then opens the nested menu built from
   *  it; cancelling the prompt stays on this menu. */
  ask?: {
    prompt: TvPromptRequest;
    submenu: (text: string) => TvMenuSpec | Promise<TvMenuSpec>;
  };
  /** Marks the current choice in a list (e.g. a toggle that is on). */
  checked?: boolean;
  /** The label wraps instead of being cut off (reading text such as credits). */
  multiline?: boolean;
  /** A round avatar before the label: its URL, or a loader for it. */
  avatar?: string | (() => Promise<string | undefined>);
  /** A coloured dot before the label (a Signal path stage's state). */
  tone?: TvMenuTone;
  /** A second line under the label, and a quieter third one; both wrap. */
  detail?: string;
  note?: string;
  /** Read-only information: focusable so a long list scrolls, but not greyed
   *  out like an entry that can't be chosen. */
  info?: boolean;
  /** A Signal path row on the cable: a stage (dot) or a change made to the
   *  audio (a cross), with the cable's state above and below it. */
  path?: {
    kind: "stage" | "change";
    above?: TvCableState;
    below?: TvCableState;
  };
}

/** Untouched, changed without losing audio bits, or with bits lost. */
export type TvCableState = "pristine" | "altered" | "lossy";

export type TvMenuTone = "ok" | "warn" | "lossy" | "neutral";

/** The Signal path colours, as the desktop diagram uses them. */
export const TONE_DOT: Record<TvMenuTone, string> = {
  ok: "bg-green-400",
  warn: "bg-amber-400",
  lossy: "bg-red-400",
  neutral: "bg-th-text-muted",
};

/** A verdict under a menu's header (the Signal path): a coloured dot and
 *  word, a count, a one-line summary and a line of facts. */
export interface TvMenuVerdict {
  tone: TvMenuTone;
  word: string;
  count?: string;
  headline: string;
  facts?: string;
}

export interface TvMenuSpec {
  title: string;
  subtitle?: string;
  verdict?: TvMenuVerdict;
  /** Rebuilt every `everyMs` while it is the menu shown (the Signal path
   *  follows the playing audio); replaced in place, focus and scroll kept. */
  poll?: { everyMs: number; next: () => Promise<TvMenuSpec> };
  image?: string;
  round?: boolean;
  /** A wider panel for reading long entries. */
  wide?: boolean;
  /** Text shown as a QR code under the header. */
  qr?: string;
  items: TvMenuItem[];
}

/** An external link to open on a phone: its QR code and its address. */
export function linkMenu(url: string, title: string): TvMenuSpec {
  return {
    title: title || "Link",
    subtitle: "Scan with your phone to open this link",
    qr: url,
    items: [{ label: url, multiline: true }],
  };
}

/** Sharing on a TV: the item's link as a QR code to open on a phone. */
export function shareMenu(url: string, name: string): TvMenuSpec {
  return {
    title: name || "Share",
    subtitle: "Scan with your phone to share it",
    qr: url,
    items: [{ label: url, multiline: true }],
  };
}

export interface TvMenuArtist {
  id: number;
  name: string;
  picture?: string | null;
}

/** Artists to pick from, each with their picture: from the item itself, or
 *  from the artist's page (cached) when the item has none. */
export function artistsMenu(
  title: string,
  artists: TvMenuArtist[],
  open: (a: TvMenuArtist) => void,
): TvMenuSpec {
  return {
    title,
    items: artists.map((a) => ({
      label: a.name,
      avatar: a.picture
        ? getArtistImage(a, 320)
        : async () =>
            getArtistImage(await getArtistPage(a.id), 320) || undefined,
      onSelect: () => open(a),
    })),
  };
}

/** The nav's menu entry points, forwarded to the mounted menu host. */
export function navMenus(
  host: () => TvMenuHostHandle | null,
): Pick<TvNav, "openMenu" | "trackMenu" | "mediaMenu"> {
  return {
    openMenu: (spec) => host()?.open(spec),
    trackMenu: (track, extra) => host()!.trackMenu(track, extra),
    mediaMenu: (item, onItsPage, context) =>
      host()!.mediaMenu(item, onItsPage, context),
  };
}

/** A destructive confirmation; "Cancel" comes first so it gets the focus. */
export function confirmMenu(opts: {
  title: string;
  subtitle?: string;
  confirmLabel: string;
  icon?: LucideIcon;
  onConfirm: () => void | Promise<void>;
}): TvMenuSpec {
  return {
    title: opts.title,
    subtitle: opts.subtitle,
    items: [
      { label: "Cancel", icon: X, onSelect: () => {} },
      { label: opts.confirmLabel, icon: opts.icon, onSelect: opts.onConfirm },
    ],
  };
}

/** Elements carrying a menu (long-press Enter / the Menu key opens it). */
const menuBuilders = new WeakMap<Element, () => TvMenuSpec>();

/** Ref callback helper: `ref={tvMenuRef(() => nav.trackMenu(track))}`. */
export function tvMenuRef(build: () => TvMenuSpec) {
  return (el: HTMLElement | null) => {
    if (el) menuBuilders.set(el, build);
  };
}

/** The menu builder for `el` or its nearest ancestor that has one. */
export function menuForElement(el: Element | null): (() => TvMenuSpec) | null {
  const host = el?.closest("[data-tv-has-menu]");
  return (host && menuBuilders.get(host)) ?? null;
}
