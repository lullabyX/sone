// Global tooltip interceptor.
//
// Listens for hover/focus on any element carrying a `title` attribute, strips
// the attribute so the OS bubble does not appear, and renders a themed
// tooltip via a portal instead. Every existing `title="..."` in the app
// upgrades to the themed style without per-call wrapping.
//
// The MutationObserver re-strips `title` if React re-renders the element
// while a tooltip is active; the attribute is restored on hide so other code
// (and accessibility tools) still see the original value.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

const SHOW_DELAY_MS = 500;
const ATTR_BACKUP = "data-tooltip-title";
const TRIGGER_SELECTOR = `[title]:not([title=""]), [${ATTR_BACKUP}]`;

interface TooltipState {
  text: string;
  rect: DOMRect;
}

export default function TooltipLayer() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const observerRef = useRef<MutationObserver | null>(null);

  const clearShowTimer = () => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  };

  const restoreTitle = (el: HTMLElement) => {
    const backup = el.getAttribute(ATTR_BACKUP);
    if (backup !== null) {
      el.setAttribute("title", backup);
      el.removeAttribute(ATTR_BACKUP);
    }
  };

  const stripTitle = (el: HTMLElement) => {
    const current = el.getAttribute("title");
    if (current !== null && current !== "") {
      el.setAttribute(ATTR_BACKUP, current);
      el.removeAttribute("title");
    }
  };

  const hide = useCallback(() => {
    clearShowTimer();
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (targetRef.current) {
      restoreTitle(targetRef.current);
      targetRef.current = null;
    }
    setTooltip(null);
  }, []);

  const show = useCallback((el: HTMLElement) => {
    const text = el.getAttribute(ATTR_BACKUP);
    if (!text) return;
    setTooltip({ text, rect: el.getBoundingClientRect() });

    if (observerRef.current) observerRef.current.disconnect();
    const obs = new MutationObserver(() => {
      // React re-render may re-apply title — strip it again to suppress
      // the OS bubble.
      stripTitle(el);
    });
    obs.observe(el, { attributes: true, attributeFilter: ["title"] });
    observerRef.current = obs;
  }, []);

  useEffect(() => {
    const onOver = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || typeof t.closest !== "function") return;
      const trigger = t.closest<HTMLElement>(TRIGGER_SELECTOR);
      if (trigger === targetRef.current) return;

      hide();
      if (!trigger) return;

      stripTitle(trigger);
      if (!trigger.getAttribute(ATTR_BACKUP)) return;

      targetRef.current = trigger;
      showTimerRef.current = window.setTimeout(() => {
        showTimerRef.current = null;
        if (targetRef.current === trigger && trigger.isConnected) show(trigger);
      }, SHOW_DELAY_MS);
    };

    const onOut = (e: MouseEvent) => {
      const current = targetRef.current;
      if (!current) return;
      const related = e.relatedTarget as Node | null;
      if (related && current.contains(related)) return;
      hide();
    };

    const onScroll = () => hide();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    const onBlur = () => hide();
    const onMouseDown = () => hide();

    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mouseout", onOut, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onBlur);

    return () => {
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("mouseout", onOut, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onBlur);
      hide();
    };
  }, [hide, show]);

  useLayoutEffect(() => {
    const el = elRef.current;
    if (!tooltip || !el) return;
    const { rect } = tooltip;

    // The global UI zoom on <html> scales the entire subtree (including this
    // portal). getBoundingClientRect and window.innerWidth are in viewport
    // (post-zoom) coords, but style.left is interpreted in the zoomed
    // subtree's coord space — divide by zoom to bridge.
    const zoomRaw = document.documentElement.style.zoom;
    const zoom = (zoomRaw && parseFloat(zoomRaw)) || 1;

    const triggerLeft = rect.left / zoom;
    const triggerTop = rect.top / zoom;
    const triggerBottom = rect.bottom / zoom;
    const triggerWidth = rect.width / zoom;
    const vw = window.innerWidth / zoom;
    const vh = window.innerHeight / zoom;

    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    const SPACING = 8;
    const PAD = 6;
    const placeAbove = triggerTop - th - SPACING >= PAD;
    let top = placeAbove ? triggerTop - SPACING - th : triggerBottom + SPACING;
    let left = triggerLeft + triggerWidth / 2 - tw / 2;
    left = Math.max(PAD, Math.min(vw - tw - PAD, left));
    top = Math.max(PAD, Math.min(vh - th - PAD, top));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.opacity = "1";
  }, [tooltip]);

  if (!tooltip) return null;

  return createPortal(
    <div
      ref={elRef}
      role="tooltip"
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        opacity: 0,
        pointerEvents: "none",
        zIndex: 10000,
        backgroundColor: "var(--th-bg-elevated)",
        color: "var(--th-text-primary)",
        border: "1px solid var(--th-border-subtle)",
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 12,
        lineHeight: 1.3,
        maxWidth: 280,
        whiteSpace: "normal",
        boxShadow: "0 6px 18px rgba(0, 0, 0, 0.35)",
        transition: "opacity 120ms ease-out",
        userSelect: "none",
      }}
    >
      {tooltip.text}
    </div>,
    document.body,
  );
}
