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
  }, [theme]);
}
