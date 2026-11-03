import type { LucideIcon } from "lucide-react";

export interface TvMenuItem {
  label: string;
  icon?: LucideIcon;
  /** Runs the action; the menu closes afterwards. */
  onSelect?: () => void | Promise<void>;
  /** Opens a nested menu instead (Back returns to this one). */
  submenu?: () => TvMenuSpec | Promise<TvMenuSpec>;
  /** Marks the current choice in a list (e.g. a toggle that is on). */
  checked?: boolean;
}

export interface TvMenuSpec {
  title: string;
  subtitle?: string;
  image?: string;
  round?: boolean;
  items: TvMenuItem[];
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
