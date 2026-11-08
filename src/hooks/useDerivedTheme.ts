import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { themeAtom } from "../atoms/theme";
import { deriveTheme, type DerivedTheme } from "../lib/theme";

/** The same colours useTheme writes to the `--th-*` variables. */
export function useDerivedTheme(): DerivedTheme {
  const theme = useAtomValue(themeAtom);
  return useMemo(() => deriveTheme(theme.accent, theme.bgBase), [theme]);
}
