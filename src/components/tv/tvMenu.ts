import { X, type LucideIcon } from "lucide-react";
import type { TvMenuHostHandle } from "./TvMenuHost";
import type { TvNav } from "./TvNavContext";

export interface TvMenuItem {
  label: string;
  icon?: LucideIcon;
  /** Runs the action; the menu closes afterwards. */
  onSelect?: () => void | Promise<void>;
  /** Opens a nested menu instead (Back returns to this one). */
  submenu?: () => TvMenuSpec | Promise<TvMenuSpec>;
  /** Marks the current choice in a list (e.g. a toggle that is on). */
  checked?: boolean;
  /** The label wraps instead of being cut off (reading text such as credits). */
  multiline?: boolean;
}

export interface TvMenuSpec {
  title: string;
  subtitle?: string;
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
