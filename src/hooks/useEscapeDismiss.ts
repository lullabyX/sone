import { useEffect, useRef } from "react";
import { registerDismissable, DISMISS_PRIORITY } from "../lib/dismissStack";

// Registers while `active` — not merely while mounted — so a layer that is
// present but hidden (a minimized video) doesn't swallow Escape. The callback
// lives in a ref so an inline arrow doesn't re-register on every render.
export function useEscapeDismiss(
  active: boolean,
  onClose: () => void,
  priority: number = DISMISS_PRIORITY.modal,
): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!active) return;
    return registerDismissable(priority, () => onCloseRef.current());
  }, [active, priority]);
}
