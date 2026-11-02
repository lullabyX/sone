import { useEffect, useState } from "react";
import {
  getRenderStatus,
  setRenderMode,
  type RenderMode,
  type RenderStatus,
} from "../../api/render";
import { useEscapeDismiss } from "../../hooks/useEscapeDismiss";
import { DISMISS_PRIORITY } from "../../lib/dismissStack";

const RENDER_MODES: { id: RenderMode; label: string; spec: string }[] = [
  {
    id: "auto",
    label: "Auto",
    spec: "Picks the safe path for your GPU. NVIDIA uses the CPU path.",
  },
  {
    id: "gpu",
    label: "GPU",
    spec: "Hardware rendering. Smoothest, but some NVIDIA setups show a blank window.",
  },
  {
    id: "cpu",
    label: "CPU",
    spec: "Software rendering. Always works, uses more CPU.",
  },
];

function ChoiceList<T extends string>({
  options,
  selected,
  onSelect,
}: {
  options: { id: T; label: string; spec: string }[];
  selected: T | undefined;
  onSelect: (id: T) => void;
}) {
  return (
    <div className="rounded-[14px] bg-th-surface border border-th-border-subtle overflow-hidden">
      {options.map((m) => {
        const sel = selected === m.id;
        return (
          <button
            key={m.id}
            onClick={() => onSelect(m.id)}
            style={
              sel
                ? {
                    background:
                      "linear-gradient(90deg, color-mix(in srgb, var(--th-accent) 11%, transparent), transparent 72%)",
                  }
                : undefined
            }
            className="relative w-full flex items-center gap-4 px-5 py-2.5 text-left border-t border-th-border-subtle first:border-t-0 transition-colors hover:bg-th-hl-faint"
          >
            {sel && (
              <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-th-accent" />
            )}
            <span
              className={`w-[18px] h-[18px] shrink-0 rounded-full border-2 flex items-center justify-center ${
                sel ? "border-th-accent" : "border-th-text-faint"
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full bg-th-accent transition-transform ${
                  sel ? "scale-100" : "scale-0"
                }`}
              />
            </span>
            <span className="flex-1 min-w-0">
              <span
                className={`block text-[13.5px] font-bold ${
                  sel ? "text-th-accent" : "text-th-text-primary"
                }`}
              >
                {m.label}
              </span>
              <span className="block text-[11.5px] text-th-text-muted mt-0.5">
                {m.spec}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function RestartDialog({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEscapeDismiss(!busy, onCancel, DISMISS_PRIORITY.modal);

  return (
    <div
      className="fixed inset-0 z-10 bg-black/60 backdrop-blur-sm flex items-center justify-center animate-fadeIn"
      onClick={busy ? undefined : onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="render-restart-title"
        className="bg-th-elevated rounded-xl shadow-2xl border border-th-border-subtle max-w-[400px] w-[90%] p-6 settings-modal-anim"
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          id="render-restart-title"
          className="text-lg font-semibold text-th-text-primary mb-6"
        >
          Restart SONE to apply? You'll get 40 seconds to keep or revert.
        </h3>
        <div className="flex justify-end gap-3">
          <button
            autoFocus
            disabled={busy}
            className="px-4 py-2 rounded-lg text-sm font-medium text-th-text-secondary hover:text-th-text-primary hover:bg-th-hl-med transition-colors disabled:opacity-50"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            disabled={busy}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-th-accent text-th-on-accent hover:brightness-110 transition-all disabled:opacity-50"
            onClick={onConfirm}
          >
            Restart
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RenderingSection() {
  const [status, setStatus] = useState<RenderStatus | null>(null);
  const [pending, setPending] = useState<RenderMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    getRenderStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);

  const select = (mode: RenderMode) => {
    if (!status || mode === status.mode) return;
    setFailed(false);
    setPending(mode);
  };

  const restart = () => {
    if (!pending) return;
    setBusy(true);
    setRenderMode(pending).catch(() => {
      setBusy(false);
      setPending(null);
      setFailed(true);
    });
  };

  return (
    <div>
      <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mt-6 mb-2.5">
        Rendering
      </p>
      <ChoiceList
        options={RENDER_MODES}
        selected={status?.mode}
        onSelect={select}
      />
      {status && (
        <p className="text-[11.5px] text-th-text-muted mt-2 px-1">
          {`Currently: ${status.path.toUpperCase()}${
            status.reason === "default" ? "" : ` (${status.reason})`
          }`}
        </p>
      )}
      {failed && (
        <p className="text-[11.5px] text-th-error mt-1 px-1">
          Couldn't change the rendering mode.
        </p>
      )}
      {pending && (
        <RestartDialog
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={restart}
        />
      )}
    </div>
  );
}
