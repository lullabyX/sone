import { useLayoutEffect, useRef, useState } from "react";
import { focusElement, focusFirstIn } from "../../lib/spatialNav";
import TvKeyboard from "./TvKeyboard";
import { TvButton } from "./TvParts";

export interface TvPromptRequest {
  title: string;
  /** Text to start from (a name being changed). */
  initial?: string;
  /** Label of the confirming button. */
  confirm: string;
}

/**
 * Asks for a line of text (a playlist name) with the on-screen keyboard;
 * a physical keyboard types into the field too. Back cancels.
 */
export default function TvPrompt({
  request,
  onDone,
}: {
  request: TvPromptRequest;
  onDone: (text: string | null) => void;
}) {
  const [text, setText] = useState(request.initial ?? "");
  const panelRef = useRef<HTMLDivElement>(null);

  // Take focus on open, give it back on close.
  useLayoutEffect(() => {
    const previous = document.activeElement;
    if (panelRef.current) focusFirstIn(panelRef.current);
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        focusElement(previous);
      }
    };
  }, []);

  const name = text.trim();

  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/60">
      <div
        ref={panelRef}
        data-tv-modal
        role="dialog"
        aria-label={request.title}
        className="w-[32rem] max-w-[90vw] rounded-[1rem] bg-th-elevated p-[2rem] shadow-2xl"
      >
        <h2 className="text-[1.4rem] font-extrabold text-th-text-primary">
          {request.title}
        </h2>
        <label className="tv-input mt-[1rem] flex h-[2.8rem] items-center rounded-[0.6rem] bg-th-surface px-[1rem]">
          <input
            data-tv-focusable
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name) onDone(name);
            }}
            spellCheck={false}
            placeholder="Name"
            className="min-w-0 flex-1 bg-transparent text-[0.95rem] text-th-text-primary outline-none placeholder:text-th-text-faint"
          />
        </label>
        <div className="mt-[1rem]">
          <TvKeyboard autoFocus onChange={setText} />
        </div>
        <div className="mt-[1.4rem] flex gap-[0.8rem]">
          <TvButton
            primary
            label={request.confirm}
            onClick={() => {
              if (name) onDone(name);
            }}
          />
          <TvButton label="Cancel" onClick={() => onDone(null)} />
        </div>
      </div>
    </div>
  );
}
