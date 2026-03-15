import { getCurrentWindow } from "@tauri-apps/api/window";

const EDGE = 4;
const CORNER = 8;

type ResizeDir = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

const zones: { direction: ResizeDir; style: React.CSSProperties; cursor: string }[] = [
  { direction: "North", style: { top: 0, left: CORNER, right: CORNER, height: EDGE }, cursor: "ns-resize" },
  { direction: "South", style: { bottom: 0, left: CORNER, right: CORNER, height: EDGE }, cursor: "ns-resize" },
  { direction: "West", style: { left: 0, top: CORNER, bottom: CORNER, width: EDGE }, cursor: "ew-resize" },
  { direction: "East", style: { right: 0, top: CORNER, bottom: CORNER, width: EDGE }, cursor: "ew-resize" },
  { direction: "NorthWest", style: { top: 0, left: 0, width: CORNER, height: CORNER }, cursor: "nwse-resize" },
  { direction: "NorthEast", style: { top: 0, right: 0, width: CORNER, height: CORNER }, cursor: "nesw-resize" },
  { direction: "SouthWest", style: { bottom: 0, left: 0, width: CORNER, height: CORNER }, cursor: "nesw-resize" },
  { direction: "SouthEast", style: { bottom: 0, right: 0, width: CORNER, height: CORNER }, cursor: "nwse-resize" },
];

export default function ResizeEdges() {
  return (
    <>
      {zones.map((zone) => (
        <div
          key={zone.direction}
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
