import { useRef, type CSSProperties, type ReactNode } from "react";

// KNOWN LIMITATION: WebKitGTK (the Tauri webview on Linux) rasterizes CSS 3D
// `perspective()` transforms as AFFINE approximations — a parallelogram with no
// keystone foreshortening — so this tilt looks correct only along one diagonal
// and slightly "skewed" on the other corners. See docs/webkitgtk-perspective-bug.md.
// A pixel-correct WebGL implementation exists and was verified working; it was
// reverted for simplicity and archived at docs/tiltcover-webgl-gpu.md (revive
// that if the affine tilt ever becomes unacceptable). Renders true perspective
// in Chrome/Firefox.

const prefersReducedMotion =
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const glareBg = (gx: number, gy: number) =>
  `radial-gradient(circle at ${gx.toFixed(2)}% ${gy.toFixed(2)}%, rgba(255,255,255,0.15) 0%, rgba(255,255,255,0.12) 10%, rgba(255,255,255,0.08) 20%, rgba(255,255,255,0.04) 35%, rgba(255,255,255,0.02) 50%, rgba(255,255,255,0.004) 65%, transparent 80%)`;

const COVER_SHADOW =
  "0 1px 3px rgba(0,0,0,0.1), 0 8px 20px rgba(0,0,0,0.1), 0 16px 48px -8px rgba(0,0,0,0.12)";
const COVER_BORDER = "1px solid rgba(255,255,255,0.1)";

const LERP_TAU_MS = 108;
const EDGE = 0.15;

interface TiltCoverProps {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
  style?: CSSProperties;
  maxTilt?: number;
  perspective?: number;
}

export function TiltCover({
  children,
  className = "",
  innerClassName = "",
  style,
  maxTilt = 12,
  perspective = 1000,
}: TiltCoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const glareRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  const lastTsRef = useRef(0);
  const cur = useRef({ rx: 0, ry: 0 });
  const tgt = useRef({ rx: 0, ry: 0, returning: false });

  const innerStyle: CSSProperties = {
    borderRadius: "inherit",
    transformOrigin: "center",
    boxShadow: COVER_SHADOW,
    border: COVER_BORDER,
  };

  if (prefersReducedMotion) {
    return (
      <div
        className={`relative overflow-hidden ${className} ${innerClassName}`}
        style={{ ...style, boxShadow: COVER_SHADOW }}
      >
        {children}
      </div>
    );
  }

  const frame = (now: number) => {
    const c = cur.current;
    const t = tgt.current;
    const dt = lastTsRef.current ? now - lastTsRef.current : 16.7;
    lastTsRef.current = now;
    const k = 1 - Math.exp(-dt / LERP_TAU_MS);
    c.rx += (t.rx - c.rx) * k;
    c.ry += (t.ry - c.ry) * k;
    const root = rootRef.current;
    if (root) {
      const ang = Math.max(Math.abs(c.rx), Math.abs(c.ry));
      root.style.transform =
        ang < 0.001
          ? `perspective(${perspective}px)`
          : `perspective(${perspective}px) rotateX(${c.rx.toFixed(3)}deg) rotateY(${c.ry.toFixed(
              3,
            )}deg)`;
    }
    const settled =
      Math.abs(t.rx - c.rx) < 0.01 && Math.abs(t.ry - c.ry) < 0.01;
    if (settled) {
      if (t.returning && root) root.style.transform = "";
      rafRef.current = 0;
      return;
    }
    rafRef.current = requestAnimationFrame(frame);
  };

  const kick = () => {
    if (!rafRef.current) {
      lastTsRef.current = 0;
      rafRef.current = requestAnimationFrame(frame);
    }
  };

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;

    const falloff = Math.max(
      0,
      Math.min(1, Math.min(fx, 1 - fx, fy, 1 - fy) / EDGE),
    );
    const clamp = (v: number) => Math.max(-maxTilt, Math.min(maxTilt, v));
    tgt.current.rx = clamp((0.5 - fy) * 2 * maxTilt * falloff);
    tgt.current.ry = clamp((fx - 0.5) * 2 * maxTilt * falloff);
    tgt.current.returning = false;

    const glare = glareRef.current;
    if (glare) {
      glare.style.background = glareBg((1 - fx) * 100, (1 - fy) * 100);
      glare.style.opacity = falloff.toFixed(3);
    }
    kick();
  };

  const onLeave = () => {
    tgt.current.rx = 0;
    tgt.current.ry = 0;
    tgt.current.returning = true;
    if (glareRef.current) glareRef.current.style.opacity = "0";
    kick();
  };

  return (
    <div
      className={`relative ${className}`}
      style={style}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      <div
        ref={rootRef}
        className={`absolute inset-0 overflow-hidden ${innerClassName}`}
        style={{ ...innerStyle, willChange: "transform" }}
      >
        {children}
        <div
          ref={glareRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[1]"
          style={{
            borderRadius: "inherit",
            opacity: 0,
            transition: "opacity 250ms ease-out",
          }}
        />
      </div>
    </div>
  );
}

export default TiltCover;
