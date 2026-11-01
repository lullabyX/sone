import { useContext, useEffect, useRef, useState } from "react";
import { useStore } from "jotai";
import { Delete, Search, X } from "lucide-react";
import { currentVideoAtom, videoExpandedAtom } from "../../atoms/video";
import { TvScreenContext } from "./TvNavContext";

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");
const SYMBOLS = `. - _ @ : / # { } ( ) ! ? , ' & + = % ~ * $ ; " < >`.split(
  " ",
);
const DIGITS = "1234567890".split("");

/**
 * The on-screen keyboard for typing with the remote (search, names), with
 * a Shift case lock and a symbols layer. A
 * physical keyboard types too while focus is on the keys (or anywhere in
 * the prompt holding them): printable keys add their character and
 * Backspace deletes, instead of moving focus or going back. Backspace on
 * empty text is left to go back.
 */
export default function TvKeyboard({
  onChange,
  autoFocus,
  empty,
  onSubmit,
}: {
  /** Applies an edit to the current text. */
  onChange: (edit: (text: string) => string) => void;
  /** Focus the first key when the screen opens. */
  autoFocus?: boolean;
  /** The text is empty, so Backspace means Back. */
  empty?: boolean;
  /** Adds a last, full-width "Search" key that calls it. */
  onSubmit?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<"lower" | "upper" | "symbols">("lower");
  const keys = (
    layout === "symbols"
      ? SYMBOLS
      : layout === "upper"
        ? LETTERS.map((k) => k.toUpperCase())
        : LETTERS
  ).concat(DIGITS);
  const { active } = useContext(TvScreenContext);
  const store = useStore();

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || e.defaultPrevented) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (store.get(currentVideoAtom) && store.get(videoExpandedAtom)) return;
      // A text field types natively.
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        return;
      }
      // Only the keyboard on top: not one under an open menu or prompt.
      const modals = document.querySelectorAll("[data-tv-modal]");
      const top = modals[modals.length - 1];
      if (top && !top.contains(root)) return;
      const scope = root.closest("[data-tv-modal]") ?? root;
      if (!scope.contains(el)) return;
      if (e.key === "Backspace") {
        if (!empty) {
          e.preventDefault();
          onChange((t) => t.slice(0, -1));
        } else if (e.repeat) {
          e.preventDefault();
        }
      } else if (e.key.length === 1) {
        e.preventDefault();
        onChange((t) => t + e.key);
      }
    };
    // Capture: ahead of the TV interface's arrow/Back handling.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, onChange, empty, store]);

  return (
    <div
      ref={rootRef}
      data-tv-keyboard
      className="grid grid-cols-6 gap-[0.4rem]"
    >
      {keys.map((k, i) => (
        <button
          key={i}
          data-tv-focusable
          data-tv-autofocus={(autoFocus && i === 0) || undefined}
          onClick={() => onChange((t) => t + k)}
          className="tv-key h-[2.4rem] rounded-[0.4rem] bg-th-surface text-[0.85rem] font-semibold text-th-text-primary"
        >
          {k}
        </button>
      ))}
      <button
        data-tv-focusable
        aria-label="Shift"
        title="Shift"
        aria-pressed={layout === "upper"}
        onClick={() => setLayout((l) => (l === "upper" ? "lower" : "upper"))}
        className={`tv-key h-[2.4rem] rounded-[0.4rem] bg-th-surface flex flex-col items-center justify-center text-[0.95rem] font-semibold ${
          layout === "upper" ? "text-th-accent" : "text-th-text-primary"
        }`}
      >
        ⇧
        {layout === "upper" && (
          <span className="w-[0.8rem] h-[0.12rem] rounded-full bg-current" />
        )}
      </button>
      <button
        data-tv-focusable
        aria-label={layout === "symbols" ? "Letters" : "Symbols"}
        title={layout === "symbols" ? "Letters" : "Symbols"}
        onClick={() =>
          setLayout((l) => (l === "symbols" ? "lower" : "symbols"))
        }
        className="tv-key h-[2.4rem] rounded-[0.4rem] bg-th-surface text-[0.75rem] font-semibold text-th-text-primary"
      >
        {layout === "symbols" ? "abc" : "#+="}
      </button>
      <button
        data-tv-focusable
        onClick={() => onChange((t) => t + " ")}
        className="tv-key col-span-2 h-[2.4rem] rounded-[0.4rem] bg-th-surface text-[0.75rem] font-semibold text-th-text-primary"
      >
        Space
      </button>
      <button
        data-tv-focusable
        aria-label="Delete"
        title="Delete"
        onClick={() => onChange((t) => t.slice(0, -1))}
        className="tv-key h-[2.4rem] rounded-[0.4rem] bg-th-surface flex items-center justify-center text-th-text-primary"
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
      {onSubmit && (
        <button
          data-tv-focusable
          aria-label="Search"
          onClick={onSubmit}
          className="tv-key col-span-6 h-[2.4rem] rounded-[0.4rem] bg-th-surface flex items-center justify-center gap-[0.5rem] text-[0.8rem] font-semibold text-th-text-primary"
        >
          <Search className="w-[1.1rem] h-[1.1rem]" />
          Search
        </button>
      )}
    </div>
  );
}
