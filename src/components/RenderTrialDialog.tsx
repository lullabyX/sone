import { useEffect, useRef, useState } from "react";
import {
  confirmRenderMode,
  getRenderReverted,
  getRenderTrial,
  revertRenderMode,
  RENDER_MODE_LABELS,
  type ActiveTrial,
} from "../api/render";
import { useToast } from "../contexts/ToastContext";
import { useEscapeDismiss } from "../hooks/useEscapeDismiss";
import { DISMISS_PRIORITY } from "../lib/dismissStack";

function trialTitle(trial: ActiveTrial): string {
  if (!trial.unprompted) return "Keep the new rendering mode?";
  const path = trial.revertTo === "cpu" ? "GPU" : "CPU";
  return `SONE is now rendering on the ${path}. Keep it?`;
}

export default function RenderTrialDialog() {
  const [trial, setTrial] = useState<ActiveTrial | null>(null);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const { showToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    getRenderTrial()
      .then((t) => {
        if (cancelled || !t) return;
        setNow(Date.now());
        setTrial(t);
        tickRef.current = setInterval(() => setNow(Date.now()), 1000);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      clearInterval(tickRef.current);
    };
  }, []);

  useEffect(() => {
    getRenderReverted()
      .then((mode) => {
        if (mode)
          showToast(`Rendering mode reverted to ${RENDER_MODE_LABELS[mode]}`);
      })
      .catch(() => {});
  }, [showToast]);

  // A trial needs an explicit answer; swallow Escape so nothing underneath closes.
  useEscapeDismiss(!!trial, () => {}, DISMISS_PRIORITY.contextMenu + 1);

  if (!trial) return null;

  const seconds = Math.max(0, Math.ceil((trial.deadlineMs - now) / 1000));

  const keep = () => {
    setBusy(true);
    setFailed(null);
    confirmRenderMode()
      .then(() => {
        clearInterval(tickRef.current);
        setTrial(null);
      })
      .catch(() => {
        setBusy(false);
        setFailed("Couldn't keep the rendering mode.");
      });
  };

  const revert = () => {
    setBusy(true);
    setFailed(null);
    revertRenderMode().catch(() => {
      setBusy(false);
      setFailed("Couldn't revert the rendering mode.");
    });
  };

  return (
    <div className="fixed inset-0 z-[10001] bg-black/60 backdrop-blur-sm flex items-center justify-center animate-fadeIn">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="render-trial-title"
        className="bg-th-elevated rounded-xl shadow-2xl border border-th-border-subtle max-w-[400px] w-[90%] p-6 settings-modal-anim"
      >
        <h3
          id="render-trial-title"
          className="text-lg font-semibold text-th-text-primary mb-2"
        >
          {trialTitle(trial)}
        </h3>
        <p className="text-sm text-th-text-secondary mb-6">
          Reverting to {RENDER_MODE_LABELS[trial.revertTo]} in {seconds} s.
        </p>
        {failed && <p className="text-sm text-th-error -mt-4 mb-4">{failed}</p>}
        <div className="flex justify-end gap-3">
          <button
            disabled={busy}
            className="px-4 py-2 rounded-lg text-sm font-medium text-th-text-secondary hover:text-th-text-primary hover:bg-th-hl-med transition-colors disabled:opacity-50"
            onClick={revert}
          >
            Revert
          </button>
          <button
            autoFocus
            disabled={busy}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-th-accent text-th-on-accent hover:brightness-110 transition-all disabled:opacity-50"
            onClick={keep}
          >
            Keep
          </button>
        </div>
      </div>
    </div>
  );
}
