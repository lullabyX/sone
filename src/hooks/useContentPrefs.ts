import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { allowAiAtom, allowExplicitAtom } from "../atoms/playback";
import type { ContentPrefs } from "../lib/contentFilter";

export function useContentPrefs(): ContentPrefs {
  const allowExplicit = useAtomValue(allowExplicitAtom);
  const allowAi = useAtomValue(allowAiAtom);
  return useMemo(() => ({ allowExplicit, allowAi }), [allowExplicit, allowAi]);
}
