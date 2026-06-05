import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

// WebKitGTK rasterizes CSS 3D perspective transforms as affine approximations
// (parallelogram, no keystone) — see docs/webkitgtk-perspective-bug.md. The tilt
// is therefore rendered with WebGL: a margin-padded canvas overlays the DOM
// cover during hover and draws the cover + drop shadow + glare with a real
// perspective projection. Edge AA is screen-space (fwidth); the cover texture
// uses mipmaps + anisotropic filtering so it stays sharp under the tilt rather
// than bilinear-blurry. The 3-layer COVER_SHADOW is drawn in-shader in the same
// projected space so it foreshortens/leans with the cover (the static CSS
// shadow underlay cross-fades out while the canvas is active); glare is the
// original CSS radial-gradient profile, painted in flat cover space so it tilts
// with the cover. CSS-transform path is the fallback when WebGL2 is unavailable.

const prefersReducedMotion =
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const glareBg = (gx: number, gy: number) =>
  `radial-gradient(circle at ${gx.toFixed(2)}% ${gy.toFixed(2)}%, rgba(255,255,255,0.15) 0%, rgba(255,255,255,0.12) 10%, rgba(255,255,255,0.08) 20%, rgba(255,255,255,0.04) 35%, rgba(255,255,255,0.02) 50%, rgba(255,255,255,0.004) 65%, transparent 80%)`;

const COVER_SHADOW =
  "0 1px 3px rgba(0,0,0,0.1), 0 8px 20px rgba(0,0,0,0.1), 0 16px 48px -8px rgba(0,0,0,0.12)";

const LERP_TAU_MS = 108;
const GLARE_TAU_MS = 120;
const EDGE = 0.15;
const MARGIN_FRAC = 0.12; // canvas overhang per side (perspective-expanded quad)
const SHADOW_MARGIN_PX = 64; // extra overhang to contain the soft drop shadow
const SUPERSAMPLE = 2; // render backing at 2x then downscale → crisp texture

const VS = `#version 300 es
in vec2 aPos;
uniform vec2 uAng;     // rx, ry in radians
uniform float uDist;   // perspective distance in cover-half units
uniform float uGrow;   // quad growth factor (AA room)
uniform float uScale;  // half / (half + margin): cover units -> clip
out vec2 vPos;         // grown cover space, y down
void main() {
  vec2 q = aPos * uGrow;
  vPos = q;
  vec3 p = vec3(q.x, q.y, 0.0);
  float cy = cos(uAng.y), sy = sin(uAng.y);
  p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
  float cx = cos(uAng.x), sx = sin(uAng.x);
  p = vec3(p.x, p.y * cx - p.z * sx, p.y * sx + p.z * cx);
  float w = 1.0 - p.z / uDist;
  gl_Position = vec4(p.x * uScale, -p.y * uScale, 0.0, w);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vPos;
uniform sampler2D uTex;
uniform float uHalf;    // cover half size, CSS px
uniform float uRadius;  // border radius, CSS px
uniform vec2 uGlare;    // glare center, px, center-origin, y down (flat cover space)
uniform float uGlareR;  // farthest-corner distance from glare center, px
uniform float uGlareO;  // glare opacity 0..1
out vec4 fragColor;

float sdRound(vec2 p, float h, float r) {
  vec2 d = abs(p) - vec2(h - r);
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

// Piecewise-linear copy of the original CSS radial-gradient alpha stops:
// 0%->.15 10%->.12 20%->.08 35%->.04 50%->.02 65%->.004 80%->0
float glareProfile(float t) {
  if (t >= 0.80) return 0.0;
  if (t >= 0.65) return mix(0.004, 0.0, (t - 0.65) / 0.15);
  if (t >= 0.50) return mix(0.02, 0.004, (t - 0.50) / 0.15);
  if (t >= 0.35) return mix(0.04, 0.02, (t - 0.35) / 0.15);
  if (t >= 0.20) return mix(0.08, 0.04, (t - 0.20) / 0.15);
  if (t >= 0.10) return mix(0.12, 0.08, (t - 0.10) / 0.10);
  return mix(0.15, 0.12, t / 0.10);
}

// One CSS box-shadow layer (offset 0 oy, blur, spread), as coverage 0..1.
// The shadow box = cover rect grown by spread, offset down by oy; the edge is
// feathered over the blur radius (50% at the box edge), matching CSS blur.
float shadowLayer(vec2 px, float oy, float blur, float spread) {
  float sd = sdRound(px - vec2(0.0, oy), uHalf + spread, max(uRadius + spread, 0.0));
  return 1.0 - smoothstep(-blur, blur, sd);
}

void main() {
  vec2 px = vPos * uHalf;

  // Cover coverage (rounded rect, screen-space AA — crisp ~1px regardless of
  // how perspective magnifies the quad).
  float sd = sdRound(px, uHalf, uRadius);
  float aaw = fwidth(sd);
  float coverA = 1.0 - smoothstep(-aaw, aaw, sd);

  // Cover color: texture + glare (only meaningful where covered).
  vec2 uv = clamp((vPos + 1.0) * 0.5, 0.0, 1.0);
  vec3 col = texture(uTex, uv).rgb;
  float t = distance(px, uGlare) / uGlareR;
  col = mix(col, vec3(1.0), uGlareO * glareProfile(t));

  // Soft drop shadow = COVER_SHADOW's 3 layers, evaluated in THIS perspective
  // space so it foreshortens/leans with the cover instead of being a fixed box.
  //   0 1px  3px        rgba(0,0,0,0.10)
  //   0 8px  20px       rgba(0,0,0,0.10)
  //   0 16px 48px -8px  rgba(0,0,0,0.12)
  float s1 = shadowLayer(px, 1.0, 3.0, 0.0) * 0.10;
  float s2 = shadowLayer(px, 8.0, 20.0, 0.0) * 0.10;
  float s3 = shadowLayer(px, 16.0, 48.0, -8.0) * 0.12;
  float shadowA = 1.0 - (1.0 - s1) * (1.0 - s2) * (1.0 - s3);

  // Cover composited OVER its (black) shadow, premultiplied.
  float outA = coverA + shadowA * (1.0 - coverA);
  fragColor = vec4(col * coverA, outA);
}`;

interface GlState {
  gl: WebGL2RenderingContext;
  tex: WebGLTexture | null;
  maxAniso: number; // 0 if extension unavailable
  uAng: WebGLUniformLocation | null;
  uDist: WebGLUniformLocation | null;
  uGrow: WebGLUniformLocation | null;
  uScale: WebGLUniformLocation | null;
  uHalf: WebGLUniformLocation | null;
  uRadius: WebGLUniformLocation | null;
  uGlare: WebGLUniformLocation | null;
  uGlareR: WebGLUniformLocation | null;
  uGlareO: WebGLUniformLocation | null;
  uploadedSrc: string;
  textureReady: boolean;
  lost: boolean;
}

function initGl(canvas: HTMLCanvasElement): GlState | null {
  const gl = canvas.getContext("webgl2", {
    antialias: true,
    premultipliedAlpha: true,
  });
  if (!gl) return null;

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error("TiltCover shader:", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, VS);
  const fs = compile(gl.FRAGMENT_SHADER, FS);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error("TiltCover link:", gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  // Anisotropic filtering keeps the foreshortened (receding) side sharp; mipmaps
  // (set per-upload in syncTexture) give clean minification. Both are why the
  // tilted cover reads crisp instead of bilinear-blurry.
  const aniso =
    gl.getExtension("EXT_texture_filter_anisotropic") ||
    gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");
  const maxAniso = aniso
    ? gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)
    : 0;

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (maxAniso > 0 && aniso) {
    gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, maxAniso);
  }

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const u = (name: string) => gl.getUniformLocation(prog, name);
  return {
    gl,
    tex,
    maxAniso,
    uAng: u("uAng"),
    uDist: u("uDist"),
    uGrow: u("uGrow"),
    uScale: u("uScale"),
    uHalf: u("uHalf"),
    uRadius: u("uRadius"),
    uGlare: u("uGlare"),
    uGlareR: u("uGlareR"),
    uGlareO: u("uGlareO"),
    uploadedSrc: "",
    textureReady: false,
    lost: false,
  };
}

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
  const outerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const glareRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<GlState | null>(null);
  const rafRef = useRef(0);
  const lastTsRef = useRef(0);
  const activeRef = useRef(false);
  const cur = useRef({ rx: 0, ry: 0, gl: 0 });
  const tgt = useRef({
    rx: 0,
    ry: 0,
    gl: 0,
    gx: 0.5,
    gy: 0.5,
    returning: false,
  });

  // Shadow lives on a static underlay (see render JSX), not on the root — so it
  // stays put and identical whether the WebGL canvas or the DOM cover is shown.
  const innerStyle: CSSProperties = {
    borderRadius: "inherit",
    transformOrigin: "center",
  };

  useEffect(() => {
    if (prefersReducedMotion) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    glRef.current = initGl(canvas);
    const onLost = (e: Event) => {
      e.preventDefault();
      if (glRef.current) glRef.current.lost = true;
    };
    const onRestored = () => {
      glRef.current = initGl(canvas);
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      glRef.current?.gl.getExtension("WEBGL_lose_context")?.loseContext();
      glRef.current = null;
    };
  }, []);

  if (prefersReducedMotion) {
    return (
      <div
        className={`relative overflow-hidden ${className} ${innerClassName}`}
        style={{ ...style }}
      >
        {children}
      </div>
    );
  }

  /** Upload the cover <img> into the GL texture (with mipmaps) when it changes. */
  const syncTexture = (s: GlState): boolean => {
    const img = rootRef.current?.querySelector("img");
    if (!img || !img.complete || img.naturalWidth === 0) return s.textureReady;
    const src = img.currentSrc || img.src;
    if (src !== s.uploadedSrc) {
      try {
        const { gl } = s;
        gl.bindTexture(gl.TEXTURE_2D, s.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          img,
        );
        gl.generateMipmap(gl.TEXTURE_2D); // WebGL2 allows NPOT mipmaps
        s.uploadedSrc = src;
        s.textureReady = true;
      } catch {
        return s.textureReady;
      }
    }
    return s.textureReady;
  };

  const renderGl = () => {
    const s = glRef.current;
    const canvas = canvasRef.current;
    const outer = outerRef.current;
    if (!s || s.lost || !canvas || !outer) return;
    const { gl } = s;

    const size = outer.clientWidth;
    if (size <= 0) return;
    const half = size / 2;
    // Margin holds both the perspective bulge and the soft shadow spread.
    const margin = Math.round(Math.max(size * MARGIN_FRAC, SHADOW_MARGIN_PX));
    const cssSide = size + 2 * margin;
    const dpr = (window.devicePixelRatio || 1) * SUPERSAMPLE;
    const px = Math.ceil(cssSide * dpr);
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
      canvas.style.left = `${-margin}px`;
      canvas.style.top = `${-margin}px`;
      canvas.style.width = `${cssSide}px`;
      canvas.style.height = `${cssSide}px`;
    }

    const radius = rootRef.current
      ? parseFloat(getComputedStyle(rootRef.current).borderTopLeftRadius) || 0
      : 0;

    const c = cur.current;
    const t = tgt.current;
    const rad = Math.PI / 180;
    // Glare center, in flat cover space (center-origin px). Painted before the
    // perspective projection so the highlight tilts with the cover. Mirror of
    // the cursor (1 - f), and farthest-corner radius — matches the CSS gradient.
    const glareX = (t.gx - 0.5) * size;
    const glareY = (t.gy - 0.5) * size;
    const glareR = Math.hypot(half + Math.abs(glareX), half + Math.abs(glareY));

    gl.viewport(0, 0, px, px);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.uniform2f(s.uAng, c.rx * rad, c.ry * rad);
    gl.uniform1f(s.uDist, perspective / half);
    gl.uniform1f(s.uScale, half / (half + margin));
    // Quad fills the entire (margin-padded) canvas so the fragment shader has
    // pixels in the margin to draw the shadow. The cover stays the inner sd<0
    // region; being coplanar, its projection is unchanged by the larger quad.
    gl.uniform1f(s.uGrow, (half + margin) / half);
    gl.uniform1f(s.uHalf, half);
    gl.uniform1f(s.uRadius, radius);
    gl.uniform2f(s.uGlare, glareX, glareY);
    gl.uniform1f(s.uGlareR, glareR);
    gl.uniform1f(s.uGlareO, c.gl);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  const setActive = (on: boolean) => {
    if (activeRef.current === on) return;
    activeRef.current = on;
    const canvas = canvasRef.current;
    if (canvas) {
      // Instant swap in (canvas matches the DOM cover at rest); soft fade out.
      canvas.style.transition = on ? "none" : "opacity 150ms ease-out";
      canvas.style.opacity = on ? "1" : "0";
    }
    // Hide the flat DOM cover while the canvas is active — otherwise the
    // full-size static cover shows behind the tilted (foreshortened) quad.
    // visibility:hidden keeps the <img> laid out so syncTexture can read it.
    const root = rootRef.current;
    if (root) root.style.visibility = on ? "hidden" : "";
    // Cross-fade the CSS shadow with the canvas: the shader draws the shadow
    // while active, so hide the static underlay (else it doubles and reappears
    // as the fixed box). Fades back in as the canvas fades out on leave.
    const shadow = shadowRef.current;
    if (shadow) {
      shadow.style.transition = on ? "none" : "opacity 150ms ease-out";
      shadow.style.opacity = on ? "0" : "1";
    }
  };

  const webglUsable = () => {
    const s = glRef.current;
    return !!s && !s.lost && syncTexture(s);
  };

  const frame = (now: number) => {
    const c = cur.current;
    const t = tgt.current;
    const dt = lastTsRef.current ? now - lastTsRef.current : 16.7;
    lastTsRef.current = now;
    const k = 1 - Math.exp(-dt / LERP_TAU_MS);
    const kg = 1 - Math.exp(-dt / GLARE_TAU_MS);
    c.rx += (t.rx - c.rx) * k;
    c.ry += (t.ry - c.ry) * k;
    c.gl += (t.gl - c.gl) * kg;

    if (webglUsable()) {
      renderGl();
      setActive(true);
    } else if (rootRef.current) {
      // CSS fallback (affine on WebKitGTK, correct elsewhere). The shader path
      // is unavailable, so lean the root + its shadow underlay together.
      const root = rootRef.current;
      const ang = Math.max(Math.abs(c.rx), Math.abs(c.ry));
      const xf =
        ang < 0.001
          ? `perspective(${perspective}px)`
          : `perspective(${perspective}px) rotateX(${c.rx.toFixed(3)}deg) rotateY(${c.ry.toFixed(
              3,
            )}deg)`;
      root.style.transform = xf;
      if (shadowRef.current) shadowRef.current.style.transform = xf;
    }

    const settled =
      Math.abs(t.rx - c.rx) < 0.01 &&
      Math.abs(t.ry - c.ry) < 0.01 &&
      Math.abs(t.gl - c.gl) < 0.005;
    if (settled) {
      if (t.returning) {
        setActive(false);
        if (rootRef.current) rootRef.current.style.transform = "";
        if (shadowRef.current) shadowRef.current.style.transform = "";
      }
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
    const t = tgt.current;
    t.rx = clamp((0.5 - fy) * 2 * maxTilt * falloff);
    t.ry = clamp((fx - 0.5) * 2 * maxTilt * falloff);
    t.gl = falloff;
    t.gx = 1 - fx;
    t.gy = 1 - fy;
    t.returning = false;

    // CSS-fallback glare only — in the WebGL path the root (and this div) is
    // hidden and the shader draws the glare so it tilts with the cover.
    if (!webglUsable() && glareRef.current) {
      const glare = glareRef.current;
      glare.style.background = glareBg((1 - fx) * 100, (1 - fy) * 100);
      glare.style.opacity = falloff.toFixed(3);
    }
    kick();
  };

  const onLeave = () => {
    const t = tgt.current;
    t.rx = 0;
    t.ry = 0;
    t.gl = 0;
    t.returning = true;
    if (glareRef.current) glareRef.current.style.opacity = "0";
    kick();
  };

  return (
    <div
      ref={outerRef}
      className={`relative ${className}`}
      style={style}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      {/* Soft cover shadow at rest. While the WebGL canvas is active it draws
          the shadow in-shader (perspective-correct, leans with the cover), so
          this static underlay cross-fades out via setActive — otherwise it would
          double the shadow and reappear as the fixed box. In the CSS fallback it
          leans with the root (affine) via the rAF loop. */}
      <div
        ref={shadowRef}
        aria-hidden
        className="absolute inset-0"
        style={{
          borderRadius: "inherit",
          boxShadow: COVER_SHADOW,
          transformOrigin: "center",
          willChange: "transform, opacity",
          opacity: 1,
        }}
      />
      <div
        ref={rootRef}
        className={`absolute inset-0 overflow-hidden ${innerClassName}`}
        style={{ ...innerStyle, willChange: "transform" }}
      >
        {children}
        {/* CSS-fallback glare (no WebGL). In the WebGL path the root is hidden
            and the shader draws an equivalent glare that tilts with the cover. */}
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
      <canvas
        ref={canvasRef}
        aria-hidden
        className={`pointer-events-none absolute z-[2] ${innerClassName}`}
        style={{ opacity: 0 }}
      />
    </div>
  );
}

export default TiltCover;

// The WebGL context + compiled shaders are created in a useEffect([]) that Vite
// fast-refresh does NOT re-run, so shader edits would otherwise keep the stale
// program until a manual reload. Invalidate this module on HMR → edits trigger a
// full page reload in dev. Stripped from production builds.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot!.invalidate());
}
