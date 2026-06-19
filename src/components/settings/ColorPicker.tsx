import { useEffect, useRef, useState } from "react";

export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s,
    x = c * (1 - Math.abs(((h / 60) % 2) - 1)),
    m = v - c;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const hx = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16) / 255,
    g = parseInt(c.slice(2, 4), 16) / 255,
    b = parseInt(c.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b),
    d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

type Hsv = { h: number; s: number; v: number };

export default function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (hex: string) => void;
}) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [hexText, setHexText] = useState(() => value);
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  // Keep latest hsv accessible to drag handlers without re-binding listeners.
  const hsvRef = useRef(hsv);
  hsvRef.current = hsv;

  // Re-seed when the external value changes (e.g. picker reopened on a new swatch).
  useEffect(() => {
    setHsv(hexToHsv(value));
    setHexText(value);
  }, [value]);

  const commit = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next.h, next.s, next.v);
    setHexText(hex);
    onChange(hex);
  };

  const svPick = (e: { clientX: number; clientY: number }) => {
    const el = svRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    commit({
      ...hsvRef.current,
      s: clamp01((e.clientX - r.left) / r.width),
      v: 1 - clamp01((e.clientY - r.top) / r.height),
    });
  };

  const huePick = (e: { clientX: number }) => {
    const el = hueRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    commit({
      ...hsvRef.current,
      h: clamp01((e.clientX - r.left) / r.width) * 360,
    });
  };

  const startDrag = (
    el: HTMLElement,
    pointerId: number,
    pick: (e: { clientX: number; clientY: number }) => void,
    e: { clientX: number; clientY: number },
  ) => {
    el.setPointerCapture(pointerId);
    pick(e);
    const move = (ev: PointerEvent) => pick(ev);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const onHexChange = (raw: string) => {
    setHexText(raw);
    const v = raw.trim();
    if (/^#?[0-9a-f]{6}$/i.test(v)) {
      const hex = `#${v.replace("#", "")}`.toLowerCase();
      setHsv(hexToHsv(hex));
      onChange(hex);
    }
  };

  const previewHex = hsvToHex(hsv.h, hsv.s, hsv.v);

  return (
    <div
      className="w-[230px] rounded-[12px] p-3"
      style={{
        background: "var(--th-bg-surface)",
        border: "1px solid var(--th-border-subtle)",
        boxShadow: "0 16px 44px rgba(0,0,0,.55)",
      }}
    >
      <div
        ref={svRef}
        onPointerDown={(e) =>
          startDrag(e.currentTarget, e.pointerId, svPick, e)
        }
        className="relative h-[120px] rounded-[9px] overflow-hidden cursor-crosshair"
        style={{
          background: `hsl(${hsv.h} 100% 50%)`,
          touchAction: "none",
        }}
      >
        <div
          className="absolute inset-0"
          style={{ background: "linear-gradient(to right,#fff,transparent)" }}
        />
        <div
          className="absolute inset-0"
          style={{ background: "linear-gradient(to top,#000,transparent)" }}
        />
        <div
          className="absolute w-[13px] h-[13px] rounded-full border-2 border-white pointer-events-none"
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            transform: "translate(-50%,-50%)",
            boxShadow: "0 0 0 1px rgba(0,0,0,.45),0 1px 3px rgba(0,0,0,.5)",
          }}
        />
      </div>

      <div
        ref={hueRef}
        onPointerDown={(e) =>
          startDrag(e.currentTarget, e.pointerId, huePick, e)
        }
        className="relative h-[13px] rounded-[7px] mt-[11px] cursor-pointer"
        style={{
          background:
            "linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)",
          touchAction: "none",
        }}
      >
        <div
          className="absolute w-[13px] h-[13px] rounded-full border-2 border-white pointer-events-none"
          style={{
            left: `${(hsv.h / 360) * 100}%`,
            top: "50%",
            transform: "translate(-50%,-50%)",
            boxShadow: "0 0 0 1px rgba(0,0,0,.45),0 1px 3px rgba(0,0,0,.5)",
          }}
        />
      </div>

      <div className="flex items-center gap-[9px] mt-[11px]">
        <span
          className="w-[26px] h-[26px] rounded-[7px] shrink-0"
          style={{
            background: previewHex,
            border: "1px solid var(--th-border-subtle)",
          }}
        />
        <input
          value={hexText}
          onChange={(e) => onHexChange(e.target.value)}
          spellCheck={false}
          className="flex-1 min-w-0 rounded-[7px] px-2 py-1 text-[12.5px] font-mono outline-none"
          style={{
            background: "var(--th-bg-inset)",
            border: "1px solid var(--th-border-subtle)",
            color: "var(--th-text-primary)",
          }}
        />
      </div>
    </div>
  );
}
