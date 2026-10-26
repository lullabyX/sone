import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { focusElement, focusFirstIn } from "../../lib/spatialNav";

/**
 * Hosts a desktop dialog (the settings sheet, the signal path panel) inside
 * TV mode: scaled up from its pixel sizes to TV size while still fitting on
 * screen, marked native so every control in it is reachable with the arrow
 * keys, focused on open, and focus handed back to where it was on close.
 * Back closes it via Escape, which these dialogs already handle.
 */
export default function TvNativeLayer({
  width,
  height,
  children,
}: {
  /** The dialog's largest size in CSS px, to keep it on screen. */
  width: number;
  height: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [zoom] = useState(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return Math.max(
      1,
      Math.min(
        rem / 16,
        (window.innerHeight * 0.94) / height,
        (window.innerWidth * 0.95) / width,
      ),
    );
  });

  useLayoutEffect(() => {
    const previous = document.activeElement;
    const id = requestAnimationFrame(() => {
      if (ref.current) focusFirstIn(ref.current);
    });
    return () => {
      cancelAnimationFrame(id);
      if (previous instanceof HTMLElement && previous.isConnected) {
        requestAnimationFrame(() => focusElement(previous));
      }
    };
  }, []);

  return (
    <div ref={ref} data-tv-modal data-tv-native style={{ zoom }}>
      {children}
    </div>
  );
}
