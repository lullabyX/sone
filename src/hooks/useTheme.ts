import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { themeAtom } from "../atoms/theme";
import { deriveTheme, themeToCssVars } from "../lib/theme";

/**
 * Reads the current theme from the Jotai atom, derives all color tokens,
 * and injects them as CSS custom properties on :root.
 *
 * Call once near the top of the component tree (e.g. in App).
 */
export function useTheme() {
  const theme = useAtomValue(themeAtom);

  useEffect(() => {
    const derived = deriveTheme(theme.accent, theme.bgBase);
    const vars = themeToCssVars(derived);
    const root = document.documentElement;

    for (const [key, value] of Object.entries(vars)) {
      root.style.setProperty(key, value);
    }

    // Adapt native browser chrome (scrollbars, form controls) to theme
    const bgHex = theme.bgBase.replace("#", "");
    const r = parseInt(bgHex.substring(0, 2), 16) / 255;
    const g = parseInt(bgHex.substring(2, 4), 16) / 255;
    const b = parseInt(bgHex.substring(4, 6), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    root.style.colorScheme = l < 0.5 ? "dark" : "light";
  }, [theme]);
}
