import { useAtomValue } from "jotai";
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { tvOverscanAtom } from "../../atoms/tv";
import { focusElement, focusFirstIn } from "../../lib/spatialNav";
import { tvNativeFitHeight, tvNativeZoom } from "./tvNative";

/**
 * Hosts a desktop dialog (the settings sheet, the signal path panel) inside
 * TV mode: scaled up from its pixel sizes to TV size while still fitting
 * inside the screen margin, marked native so every control in it is
 * reachable with the arrow keys, focused on open, and focus handed back to
 * where it was on close. Back closes it via Escape, which these dialogs
 * already handle. The dialog reads `--tv-native-fit-h` for its height.
 */
export default function TvNativeLayer({
  width,
  children,
}: {
  /** The dialog's largest width in CSS px, to keep it on screen. */
  width: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const overscan = useAtomValue(tvOverscanAtom);
  const [{ zoom, fitH }] = useState(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const z = tvNativeZoom(rem, window.innerWidth, width, overscan);
    return {
      zoom: z,
      fitH: tvNativeFitHeight(window.innerHeight, z, overscan),
    };
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
    <div
      ref={ref}
      data-tv-modal
      data-tv-native
      style={
        {
          zoom,
          position: "relative",
          zIndex: 10000,
          "--tv-native-fit-h": `${fitH}px`,
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}
