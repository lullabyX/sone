import {
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  type RefObject,
  type CSSProperties,
} from "react";
import { useEscapeDismiss } from "./useEscapeDismiss";
import { DISMISS_PRIORITY } from "../lib/dismissStack";

interface UseContextMenuOptions {
  cursorPosition?: { x: number; y: number };
  anchorRef?: RefObject<HTMLElement | null>;
  anchorGap?: number;
  ignoreRefs?: RefObject<HTMLElement | null>[];
  suppressClose?: boolean;
  onClose: () => void;
}

export function useContextMenu({
  cursorPosition,
  anchorRef,
  anchorGap = 4,
  ignoreRefs,
  suppressClose,
  onClose,
}: UseContextMenuOptions) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const [isPositioned, setIsPositioned] = useState(false);
  const [pos, setPos] = useState({ top: -9999, left: -9999 });

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  // Position the menu after first paint so we can measure its size.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (!menu) return;

      const zoom = parseFloat(document.documentElement.style.zoom || "1");
      const menuRect = menu.getBoundingClientRect();
      // clientX/Y, getBoundingClientRect, and innerWidth/Height return VISUAL
      // pixels (× zoom); position:fixed top/left are LAYOUT pixels. Divide
      // every visual-space read by zoom so all the math below is layout-px.
      const menuWidth = menuRect.width / zoom || 240;
      const menuHeight = menuRect.height / zoom || 300;
      const viewW = window.innerWidth / zoom;
      const viewH = window.innerHeight / zoom;
      const pad = 8;

      let top: number;
      let left: number;

      if (cursorPosition) {
        top = cursorPosition.y / zoom;
        left = cursorPosition.x / zoom;
      } else if (anchorRef?.current) {
        const rect = anchorRef.current.getBoundingClientRect();
        top = rect.bottom / zoom + anchorGap;
        left = rect.right / zoom - menuWidth;
      } else {
        return;
      }

      // Clamp horizontally
      if (left < pad) left = pad;
      if (left + menuWidth > viewW - pad) left = viewW - menuWidth - pad;

      // Clamp vertically — flip upward if overflowing bottom
      if (top + menuHeight > viewH - pad) {
        if (cursorPosition) {
          top = cursorPosition.y / zoom - menuHeight;
        } else if (anchorRef?.current) {
          const rect = anchorRef.current.getBoundingClientRect();
          top = rect.top / zoom - menuHeight - anchorGap;
        }
      }
      if (top < pad) top = pad;

      setPos({ top, left });
      setIsPositioned(true);
    });

    return () => cancelAnimationFrame(raf);
  }, [cursorPosition, anchorRef, anchorGap]);

  useEscapeDismiss(!suppressClose, onClose, DISMISS_PRIORITY.contextMenu);

  // A right-click can continue as a drag into the menu, releasing on an item will select it
  const cursorX = cursorPosition?.x;
  const cursorY = cursorPosition?.y;
  useEffect(() => {
    if (cursorX === undefined || cursorY === undefined || suppressClose) return;

    let armed = true;
    let dragged = false;
    const dragSlop = 8;

    const handleMouseMove = (e: MouseEvent) => {
      if (Math.hypot(e.clientX - cursorX, e.clientY - cursorY) > dragSlop) {
        dragged = true;
      }
    };
    const handleMouseDown = () => {
      armed = false;
    };
    const handleMouseUp = (e: MouseEvent) => {
      if (!armed) return;
      armed = false;
      if (!dragged) return;

      const target = e.target;
      const menu = menuRef.current;
      const button =
        target instanceof Element ? target.closest("button") : null;
      if (button && menu?.contains(button)) {
        button.click();
      } else if (!target || !menu?.contains(target as Node)) {
        onCloseRef.current();
      }
    };

    document.addEventListener("mousemove", handleMouseMove, true);
    document.addEventListener("mousedown", handleMouseDown, true);
    document.addEventListener("mouseup", handleMouseUp, true);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove, true);
      document.removeEventListener("mousedown", handleMouseDown, true);
      document.removeEventListener("mouseup", handleMouseUp, true);
    };
  }, [cursorX, cursorY, suppressClose]);

  // Dismiss on click-outside
  useEffect(() => {
    if (suppressClose) return;

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      if (ignoreRefs?.some((r) => r.current?.contains(target))) return;
      onClose();
    };

    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [onClose, anchorRef, ignoreRefs, suppressClose]);

  const style: CSSProperties = {
    position: "fixed",
    top: pos.top,
    left: pos.left,
    opacity: isPositioned ? 1 : 0,
    animation: isPositioned ? "fadeIn 0.12s ease-out" : undefined,
  };

  return { menuRef, style, isPositioned };
}
