import { useEscapeDismiss } from "../../hooks/useEscapeDismiss";
import { DISMISS_PRIORITY } from "../../lib/dismissStack";

interface ContentOffDialogProps {
  label: string;
  onCancel: () => void;
  onConfirm: () => void;
}

// Rendered inside the settings panel so its clicks don't count as
// "outside" and close the sheet underneath.
export default function ContentOffDialog({
  label,
  onCancel,
  onConfirm,
}: ContentOffDialogProps) {
  useEscapeDismiss(true, onCancel, DISMISS_PRIORITY.modal);

  return (
    <div
      className="fixed inset-0 z-10 bg-black/60 backdrop-blur-sm flex items-center justify-center animate-fadeIn"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="content-off-title"
        className="bg-th-elevated rounded-xl shadow-2xl border border-th-border-subtle max-w-[400px] w-[90%] p-6 settings-modal-anim"
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          id="content-off-title"
          className="text-lg font-semibold text-th-text-primary mb-2"
        >
          Turn off {label} content?
        </h3>
        <p className="text-sm text-th-text-secondary mb-6">
          Turning this off clears your current queue.
        </p>
        <div className="flex justify-end gap-3">
          <button
            autoFocus
            className="px-4 py-2 rounded-lg text-sm font-medium text-th-text-secondary hover:text-th-text-primary hover:bg-th-hl-med transition-colors"
            onClick={onCancel}
          >
            Not now
          </button>
          <button
            className="px-4 py-2 rounded-lg text-sm font-medium bg-th-accent text-th-on-accent hover:brightness-110 transition-all"
            onClick={onConfirm}
          >
            Yes, turn off
          </button>
        </div>
      </div>
    </div>
  );
}
