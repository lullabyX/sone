import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAtom } from "jotai";
import {
  ArrowDownLeft,
  ArrowDownRight,
  ArrowUpLeft,
  ArrowUpRight,
} from "lucide-react";
import {
  TV_OVERSCAN_MAX,
  TV_OVERSCAN_STEP,
  tvOverscanAtom,
  type TvOverscan,
} from "../../atoms/tv";
import { focusElement } from "../../lib/spatialNav";

const BACK = new Set(["Escape", "Backspace", "BrowserBack", "GoBack"]);

const clamp = (v: number) =>
  Math.min(
    TV_OVERSCAN_MAX,
    Math.max(0, Math.round(v / TV_OVERSCAN_STEP) * TV_OVERSCAN_STEP),
  );

export const formatTvOverscan = ({ x, y }: TvOverscan) =>
  x === 0 && y === 0 ? "Off" : x === y ? `${x} %` : `${x} % × ${y} %`;

const CORNERS = [
  { Icon: ArrowUpLeft, at: "top-0 left-0" },
  { Icon: ArrowUpRight, at: "top-0 right-0" },
  { Icon: ArrowDownLeft, at: "bottom-0 left-0" },
  { Icon: ArrowDownRight, at: "bottom-0 right-0" },
];

/**
 * Screen margin calibration: arrows in the four corners of the picture,
 * moved with the remote until their tips touch the edges of the screen.
 * Left/Right make the picture narrower or wider, Up/Down taller or shorter;
 * the interface follows live. OK keeps it, Back puts the old margin back.
 */
export default function TvMarginCalibration({
  onClose,
}: {
  onClose: () => void;
}) {
  const [overscan, setOverscan] = useAtom(tvOverscanAtom);
  const [initial] = useState(overscan);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const previous = document.activeElement;
    ref.current?.focus({ preventScroll: true });
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        requestAnimationFrame(() => focusElement(previous));
      }
    };
  }, []);

  const change = (axis: keyof TvOverscan, by: number) =>
    setOverscan((o) => ({ ...o, [axis]: clamp(o[axis] + by) }));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    switch (e.key) {
      case "ArrowLeft":
        change("x", TV_OVERSCAN_STEP);
        break;
      case "ArrowRight":
        change("x", -TV_OVERSCAN_STEP);
        break;
      case "ArrowDown":
        change("y", TV_OVERSCAN_STEP);
        break;
      case "ArrowUp":
        change("y", -TV_OVERSCAN_STEP);
        break;
      case "Enter":
      case " ":
        if (!e.repeat) onClose();
        break;
      default:
        if (!BACK.has(e.key)) return;
        if (!e.repeat) {
          setOverscan(initial);
          onClose();
        }
    }
    e.preventDefault();
  };

  return createPortal(
    <div
      data-tv-modal
      role="dialog"
      aria-label="Screen margin"
      className="fixed inset-0 z-[10000] bg-black/70"
    >
      <div
        ref={ref}
        tabIndex={0}
        data-tv-focusable
        onKeyDown={onKeyDown}
        aria-label={`Screen margin: ${formatTvOverscan(overscan)}`}
        className="absolute border-[0.15rem] border-dashed border-th-accent/60 outline-none"
        style={{ inset: `${overscan.y}vh ${overscan.x}vw` }}
      >
        {CORNERS.map(({ Icon, at }) => (
          <Icon
            key={at}
            aria-hidden
            strokeWidth={2.5}
            className={`absolute ${at} h-[3rem] w-[3rem] text-th-accent`}
          />
        ))}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="max-w-[34rem] rounded-[1rem] bg-th-elevated px-[2rem] py-[1.6rem] text-center shadow-2xl">
            <h2 className="text-[1.3rem] font-bold text-th-text-primary">
              Screen margin
            </h2>
            <p className="mt-[0.6rem] text-[0.9rem] text-th-text-secondary">
              Move the arrows until their tips touch the edges of your screen.
            </p>
            <p className="mt-[1rem] text-[0.9rem] font-semibold tabular-nums text-th-text-primary">
              Sides {overscan.x} % · Top and bottom {overscan.y} %
            </p>
            <p className="mt-[1rem] text-[0.8rem] text-th-text-muted">
              ← → narrower / wider · ↑ ↓ taller / shorter
            </p>
            <p className="mt-[0.3rem] text-[0.8rem] text-th-text-muted">
              OK to save · Back to cancel
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
