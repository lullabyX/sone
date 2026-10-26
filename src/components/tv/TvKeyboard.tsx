import { useContext, useEffect, useRef } from "react";
import { Delete, X } from "lucide-react";
import { TvScreenContext } from "./TvNavContext";

const KEYS = "abcdefghijklmnopqrstuvwxyz1234567890".split("");

/**
 * The on-screen keyboard for typing with the remote (search, names). A
 * physical keyboard types too, wherever focus is on the keys: printable
 * keys add their character and Backspace deletes, instead of moving focus
 * or going back.
 */
export default function TvKeyboard({
  onChange,
  autoFocus,
}: {
  /** Applies an edit to the current text. */
  onChange: (edit: (text: string) => string) => void;
  /** Focus the first key when the screen opens. */
  autoFocus?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { active } = useContext(TvScreenContext);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || e.defaultPrevented) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      // A text field types natively.
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        return;
      }
      // Only the keyboard on top: not one under an open menu or prompt.
      const modals = document.querySelectorAll("[data-tv-modal]");
      const top = modals[modals.length - 1];
      if (top && !top.contains(root)) return;
      if (e.key === "Backspace") {
        e.preventDefault();
        onChange((t) => t.slice(0, -1));
      } else if (e.key.length === 1) {
        e.preventDefault();
        onChange((t) => t + e.key);
      }
    };
    // Capture: ahead of the TV interface's arrow/Back handling.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, onChange]);

  return (
    <div ref={rootRef} className="grid grid-cols-6 gap-[0.4rem]">
      {KEYS.map((k, i) => (
        <button
          key={k}
          data-tv-focusable
          data-tv-autofocus={(autoFocus && i === 0) || undefined}
          onClick={() => onChange((t) => t + k)}
          className="tv-key h-[2.4rem] rounded-[0.4rem] bg-th-surface text-[0.85rem] font-semibold uppercase text-th-text-primary"
        >
          {k}
        </button>
      ))}
      <button
        data-tv-focusable
        onClick={() => onChange((t) => t + " ")}
        className="tv-key col-span-3 h-[2.4rem] rounded-[0.4rem] bg-th-surface text-[0.75rem] font-semibold text-th-text-primary"
      >
        Space
      </button>
      <button
        data-tv-focusable
        aria-label="Delete"
        title="Delete"
        onClick={() => onChange((t) => t.slice(0, -1))}
        className="tv-key col-span-2 h-[2.4rem] rounded-[0.4rem] bg-th-surface flex items-center justify-center text-th-text-primary"
      >
        <Delete className="w-[1.1rem] h-[1.1rem]" />
      </button>
      <button
        data-tv-focusable
        aria-label="Clear"
        title="Clear"
        onClick={() => onChange(() => "")}
        className="tv-key h-[2.4rem] rounded-[0.4rem] bg-th-surface flex items-center justify-center text-th-text-primary"
      >
        <X className="w-[1.1rem] h-[1.1rem]" />
      </button>
    </div>
  );
}
