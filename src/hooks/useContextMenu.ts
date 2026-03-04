import {
  useRef,
  useState,
  useEffect,
  type RefObject,
  type CSSProperties,
} from "react";

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
  const [isPositioned, setIsPositioned] = useState(false);
  const [pos, setPos] = useState({ top: -9999, left: -9999 });

  // Position the menu after first paint so we can measure its size.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (!menu) return;

      const menuRect = menu.getBoundingClientRect();
      const menuWidth = menuRect.width || 240;
      const menuHeight = menuRect.height || 300;
      const viewW = window.innerWidth;
      const viewH = window.innerHeight;
      const pad = 8;

      let top: number;
      let left: number;

      if (cursorPosition) {
        const zoom = parseFloat(document.documentElement.style.zoom || "1");
        top = cursorPosition.y / zoom;
        left = cursorPosition.x / zoom;
      } else if (anchorRef?.current) {
        const rect = anchorRef.current.getBoundingClientRect();
        top = rect.bottom + anchorGap;
        left = rect.right - menuWidth;
      } else {
        return;
      }

      // Clamp horizontally
      if (left < pad) left = pad;
      if (left + menuWidth > viewW - pad) left = viewW - menuWidth - pad;

      // Clamp vertically — flip upward if overflowing bottom
      if (top + menuHeight > viewH - pad) {
        if (cursorPosition) {
          const zoom = parseFloat(document.documentElement.style.zoom || "1");
          top = cursorPosition.y / zoom - menuHeight;
        } else if (anchorRef?.current) {
          const rect = anchorRef.current.getBoundingClientRect();
          top = rect.top - menuHeight - anchorGap;
        }
      }
      if (top < pad) top = pad;

      setPos({ top, left });
      setIsPositioned(true);
    });

    return () => cancelAnimationFrame(raf);
  }, [cursorPosition, anchorRef, anchorGap]);

  // Dismiss on click-outside / Escape
  useEffect(() => {
    if (suppressClose) return;

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      if (ignoreRefs?.some((r) => r.current?.contains(target))) return;
      onClose();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
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
