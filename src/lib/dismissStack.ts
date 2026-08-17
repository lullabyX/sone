// Escape dismisses exactly one layer: the visually topmost. Priority beats
// registration order, so a context menu opened over a modal closes first
// regardless of which mounted when.
export const DISMISS_PRIORITY = {
  contextMenu: 400,
  modal: 300,
  overlay: 200,
  drawer: 100,
} as const;

type Entry = { priority: number; onClose: () => void; seq: number };

let entries: Entry[] = [];
let seq = 0;
let listening = false;

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  if (entries.length === 0) return;

  let top = entries[0];
  for (const entry of entries) {
    if (
      entry.priority > top.priority ||
      (entry.priority === top.priority && entry.seq > top.seq)
    ) {
      top = entry;
    }
  }

  e.preventDefault();
  top.onClose();
}

export function registerDismissable(
  priority: number,
  onClose: () => void,
): () => void {
  const entry: Entry = { priority, onClose, seq: ++seq };
  entries.push(entry);
  if (!listening) {
    // Bubble phase on purpose — a focused input's stopPropagation must win.
    window.addEventListener("keydown", onKeyDown);
    listening = true;
  }

  return () => {
    entries = entries.filter((e) => e !== entry);
    if (entries.length === 0 && listening) {
      window.removeEventListener("keydown", onKeyDown);
      listening = false;
    }
  };
}
