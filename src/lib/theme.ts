// ---------------------------------------------------------------------------
// Theme types, color derivation, and preset themes
// ---------------------------------------------------------------------------

export interface Theme {
  name: string;
  accent: string; // hex, e.g. "#A855F7"
  bgBase: string; // hex, e.g. "#130F1A"
}

/** @public */
export interface DerivedTheme {
  // Backgrounds
  bgBase: string;
  bgSurface: string;
  bgSurfaceHover: string;
  bgElevated: string;
  bgSidebar: string;
  bgOverlay: string;
  bgInset: string;
  bgInsetHover: string;
  bgButton: string;
  bgButtonHover: string;

  // Accent
  accent: string;
  accentHover: string;

  // Text
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textFaint: string;
  textDisabled: string;

  // Border / scrollbar
  borderSubtle: string;
  scrollbar: string;
  scrollbarHover: string;

  // Highlights (adaptive overlays)
  hlFaint: string;
  hlMed: string;
  hlStrong: string;

  // Slider / progress
  sliderTrack: string;
  sliderFill: string;
  sliderBorder: string;

  // Semantic (fixed)
  success: string;
  error: string;
  warning: string;
}

// ---------------------------------------------------------------------------
// HSL helpers
// ---------------------------------------------------------------------------

function hexToHsl(hex: string): [number, number, number] {
  let r = 0,
    g = 0,
    b = 0;
  const h = hex.replace("#", "");
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16) / 255;
    g = parseInt(h[1] + h[1], 16) / 255;
    b = parseInt(h[2] + h[2], 16) / 255;
  } else {
    r = parseInt(h.substring(0, 2), 16) / 255;
    g = parseInt(h.substring(2, 4), 16) / 255;
    b = parseInt(h.substring(4, 6), 16) / 255;
  }

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let s = 0;
  let hue = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        hue = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        hue = ((b - r) / d + 2) / 6;
        break;
      case b:
        hue = ((r - g) / d + 4) / 6;
        break;
    }
  }

  return [hue * 360, s * 100, l * 100];
}

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lN - c / 2;
  let r = 0,
    g = 0,
    b = 0;

  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }

  const toHex = (v: number) => {
    const hex = Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
    return hex;
  };

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Clamp a value between min and max */
function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Shift lightness of a hex color by delta percent */
function shiftLightness(hex: string, delta: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, s, clamp(l + delta, 0, 100));
}

/** Scale lightness of a hex color by a factor (0-1 = darken, >1 = lighten) */
function scaleBrightness(hex: string, factor: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, s, clamp(l * factor, 0, 100));
}

// ---------------------------------------------------------------------------
// deriveTheme
// ---------------------------------------------------------------------------

export function deriveTheme(accent: string, bgBase: string): DerivedTheme {
  const [, , bgL] = hexToHsl(bgBase);
  const isDark = bgL < 50;

  // Background surfaces derived from bgBase via lightness shifts
  // For light themes, surfaces should be darker than base (not lighter)
  const dir = isDark ? 1 : -1;
  const bgSurface = shiftLightness(bgBase, 4 * dir);
  const bgSurfaceHover = shiftLightness(bgBase, 9 * dir);
  const bgElevated = shiftLightness(bgBase, 2.5 * dir);
  const bgSidebar = shiftLightness(bgBase, -2);     // always darker than base
  const bgOverlay = shiftLightness(bgBase, -3);      // always darker than base
  const bgInset = shiftLightness(bgBase, 7 * dir);
  const bgInsetHover = shiftLightness(bgBase, 11 * dir);
  const bgButton = shiftLightness(bgBase, 14 * dir);
  const bgButtonHover = shiftLightness(bgBase, 19 * dir);

  // Accent
  const accentHover = scaleBrightness(accent, 0.88);

  // Text: for dark backgrounds, use light text at varying opacities
  // For light backgrounds, use dark text
  let textPrimary: string;
  let textSecondary: string;
  let textMuted: string;
  let textFaint: string;
  let textDisabled: string;

  if (isDark) {
    textPrimary = "#ffffff";
    textSecondary = "#b3b3b3";
    textMuted = "#a6a6a6";
    textFaint = "#666666";
    textDisabled = "#535353";
  } else {
    textPrimary = "#111111";
    textSecondary = "#444444";
    textMuted = "#666666";
    textFaint = "#666666";
    textDisabled = "#aaaaaa";
  }

  // Borders / scrollbar
  const borderSubtle = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.08)";
  const scrollbar = bgButton;
  const scrollbarHover = bgButtonHover;

  // Adaptive highlight overlays
  const hlFaint = isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)";
  const hlMed = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)";
  const hlStrong = isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.10)";

  // Slider / progress
  const sliderTrack = isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.15)";
  const sliderFill = isDark ? "rgba(255,255,255,0.65)" : "rgba(0,0,0,0.45)";
  const sliderBorder = isDark ? bgElevated : "rgba(255,255,255,0.35)";

  return {
    bgBase,
    bgSurface,
    bgSurfaceHover,
    bgElevated,
    bgSidebar,
    bgOverlay,
    bgInset,
    bgInsetHover,
    bgButton,
    bgButtonHover,
    accent,
    accentHover,
    textPrimary,
    textSecondary,
    textMuted,
    textFaint,
    textDisabled,
    borderSubtle,
    scrollbar,
    scrollbarHover,
    hlFaint,
    hlMed,
    hlStrong,
    sliderTrack,
    sliderFill,
    sliderBorder,
    success: "#1ed760",
    error: "#ff6666",
    warning: "#ffa726",
  };
}

// ---------------------------------------------------------------------------
// CSS variable mapping — keys used by useTheme to set on :root
// ---------------------------------------------------------------------------

export function themeToCssVars(dt: DerivedTheme): Record<string, string> {
  return {
    "--th-bg-base": dt.bgBase,
    "--th-bg-surface": dt.bgSurface,
    "--th-bg-surface-hover": dt.bgSurfaceHover,
    "--th-bg-elevated": dt.bgElevated,
    "--th-bg-sidebar": dt.bgSidebar,
    "--th-bg-overlay": dt.bgOverlay,
    "--th-bg-inset": dt.bgInset,
    "--th-bg-inset-hover": dt.bgInsetHover,
    "--th-bg-button": dt.bgButton,
    "--th-bg-button-hover": dt.bgButtonHover,
    "--th-accent": dt.accent,
    "--th-accent-hover": dt.accentHover,
    "--th-text-primary": dt.textPrimary,
    "--th-text-secondary": dt.textSecondary,
    "--th-text-muted": dt.textMuted,
    "--th-text-faint": dt.textFaint,
    "--th-text-disabled": dt.textDisabled,
    "--th-border-subtle": dt.borderSubtle,
    "--th-scrollbar": dt.scrollbar,
    "--th-scrollbar-hover": dt.scrollbarHover,
    "--th-hl-faint": dt.hlFaint,
    "--th-hl-med": dt.hlMed,
    "--th-hl-strong": dt.hlStrong,
    "--th-slider-track": dt.sliderTrack,
    "--th-slider-fill": dt.sliderFill,
    "--th-slider-border": dt.sliderBorder,
    "--th-success": dt.success,
    "--th-error": dt.error,
    "--th-warning": dt.warning,
  };
}

// ---------------------------------------------------------------------------
// Preset themes
// ---------------------------------------------------------------------------

export const PRESET_THEMES: Theme[] = [
  { name: "Violet Night", accent: "#A855F7", bgBase: "#130F1A" },
  { name: "Cyberpunk", accent: "#FCE300", bgBase: "#18180C" },
  { name: "Forest", accent: "#22C55E", bgBase: "#0E1410" },
  { name: "Ocean", accent: "#3B82F6", bgBase: "#0E1118" },
  { name: "Midnight Cyan", accent: "#00FFFF", bgBase: "#121212" },
  { name: "Sakura", accent: "#F9A8D4", bgBase: "#140F12" },
  { name: "Rose", accent: "#F43F5E", bgBase: "#140E0F" },
  { name: "Ember", accent: "#F97316", bgBase: "#151010" },
  { name: "Copper", accent: "#E8915A", bgBase: "#12100E" },
  { name: "Daylight", accent: "#2563EB", bgBase: "#F5F3EE" },
  { name: "Snowfall", accent: "#0891B2", bgBase: "#F8FAFC" },
  { name: "Paper", accent: "#7C3AED", bgBase: "#FAF5FF" },
];
