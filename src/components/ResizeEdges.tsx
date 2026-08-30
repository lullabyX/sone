import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

type ResizeDir =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

interface ResizeEdgesProps {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

function buildZones(top: number, bottom: number, left: number, right: number) {
  const zones: {
    direction: ResizeDir;
    style: React.CSSProperties;
    cursor: string;
  }[] = [
    {
      direction: "North",
      style: { top: 0, left: left, right: right, height: top },
      cursor: "ns-resize",
    },
    {
      direction: "South",
      style: { bottom: 0, left: left, right: right, height: bottom },
      cursor: "ns-resize",
    },
    {
      direction: "West",
      style: { left: 0, top: top, bottom: bottom, width: left },
      cursor: "ew-resize",
    },
    {
      direction: "East",
      style: { right: 0, top: top, bottom: bottom, width: right },
      cursor: "ew-resize",
    },
    {
      direction: "NorthWest",
      style: { top: 0, left: 0, width: left, height: top },
      cursor: "nwse-resize",
    },
    {
      direction: "NorthEast",
      style: { top: 0, right: 0, width: right, height: top },
      cursor: "nesw-resize",
    },
    {
      direction: "SouthWest",
      style: { bottom: 0, left: 0, width: left, height: bottom },
      cursor: "nesw-resize",
    },
    {
      direction: "SouthEast",
      style: { bottom: 0, right: 0, width: right, height: bottom },
      cursor: "nwse-resize",
    },
  ];
  return zones;
}

// Maximized / fullscreen windows can't be edge-resized, and these strips sit on
// top of the content scrollbars — so don't render them at all in those states.
function useWindowFills() {
  const [fills, setFills] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let cancelled = false;

    const sync = () => {
      Promise.all([win.isMaximized(), win.isFullscreen()])
        .then(([maximized, fullscreen]) => {
          if (!cancelled) setFills(maximized || fullscreen);
        })
        .catch(() => {});
    };

    sync();
    const unlisten = win.onResized(sync);

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  return fills;
}

export default function ResizeEdges({
  top = 4,
  bottom = 4,
  left = 4,
  right = 4,
}: ResizeEdgesProps) {
  const fills = useWindowFills();
  const zones = buildZones(top, bottom, left, right);

  if (fills) return null;

  return (
    <>
      {zones.map((zone) => (
        <div
          key={zone.direction}
          data-resize-edge={zone.direction}
          onMouseDown={(e) => {
            e.preventDefault();
            getCurrentWindow().startResizeDragging(zone.direction);
          }}
          style={{
            position: "absolute",
            zIndex: 50,
            cursor: zone.cursor,
            ...zone.style,
          }}
        />
      ))}
    </>
  );
}
