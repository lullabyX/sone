import { useEffect, useMemo, useRef } from "react";
import { useAtomValue } from "jotai";
import {
  shortcutsAtom,
  comboKey,
  keyFromEvent,
  ACTION_BY_ID,
  type ActionId,
} from "../lib/shortcuts";

type ShortcutDispatch = Partial<Record<ActionId, () => void>>;

export function useShortcuts(dispatch: ShortcutDispatch) {
  const bindings = useAtomValue(shortcutsAtom);
  const dispatchRef = useRef(dispatch);
  useEffect(() => {
    dispatchRef.current = dispatch;
  });

  const ownedKey = (Object.keys(dispatch) as ActionId[]).sort().join(",");

  const inverse = useMemo(() => {
    const owned = ownedKey.split(",").filter(Boolean) as ActionId[];
    const isFixed = (id: ActionId) => ACTION_BY_ID.get(id)?.fixed === true;
    const m = new Map<string, ActionId>();
    for (const id of owned.filter((a) => !isFixed(a))) {
      const combo = bindings[id];
      if (combo) m.set(comboKey(combo), id);
    }
    // Second pass: a fixed action's combo is reserved, so it wins any collision.
    for (const id of owned.filter(isFixed)) {
      const combo = ACTION_BY_ID.get(id)?.default;
      if (combo) m.set(comboKey(combo), id);
    }
    return m;
  }, [bindings, ownedKey]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const combo = keyFromEvent(e);
      if (!combo) return;
      const id = inverse.get(comboKey(combo));
      if (!id) return;

      const meta = ACTION_BY_ID.get(id);
      if (meta?.repeatable === false && e.repeat) return;

      const inInput =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement;
      // Alt-modified combos type nothing, so they stay live inside text fields.
      if (inInput && !combo.mod && !combo.alt) return;

      const fn = dispatchRef.current[id];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [inverse]);
}
