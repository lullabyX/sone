import { useState, useEffect } from "react";
import { useAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { decorationsAtom, hideTitleBarAtom } from "../../atoms/ui";
import { useToast } from "../../contexts/ToastContext";
import Toggle from "../Toggle";
import SettingRow from "./SettingRow";

type TitleBarMode = "system" | "custom" | "hidden";

const TITLE_BAR_MODES: { id: TitleBarMode; label: string; spec: string }[] = [
  {
    id: "system",
    label: "System",
    spec: "Native OS title bar and window controls.",
  },
  {
    id: "custom",
    label: "Custom",
    spec: "SONE's own in-app title bar, themed to match.",
  },
  {
    id: "hidden",
    label: "Hidden",
    spec: "Frameless — no title bar at all.",
  },
];

export default function GeneralTab() {
  const [decorations, setDecorations] = useAtom(decorationsAtom);
  const [hideTitleBar, setHideTitleBar] = useAtom(hideTitleBarAtom);
  const [minimizeToTray, setMinimizeToTray] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    invoke<boolean>("get_minimize_to_tray")
      .then(setMinimizeToTray)
      .catch(() => {});
  }, []);

  const mode: TitleBarMode = hideTitleBar
    ? "hidden"
    : decorations
      ? "system"
      : "custom";

  const setMode = (next: TitleBarMode) => {
    if (next === "system") {
      setDecorations(true);
      if (hideTitleBar) setHideTitleBar(false);
      invoke("set_decorations", { enabled: true }).catch(() => {
        setDecorations(false);
        showToast("Failed to update window decorations");
      });
    } else if (next === "custom") {
      setDecorations(false);
      setHideTitleBar(false);
      invoke("set_decorations", { enabled: false }).catch(() => {
        setDecorations(true);
        showToast("Failed to update window decorations");
      });
    } else {
      setHideTitleBar(true);
      if (decorations) {
        setDecorations(false);
        invoke("set_decorations", { enabled: false }).catch(() => {
          setDecorations(true);
          showToast("Failed to update window decorations");
        });
      }
    }
  };

  return (
    <div>
      <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mb-2.5">
        Title bar
      </p>
      <div className="rounded-[14px] bg-th-surface border border-th-border-subtle overflow-hidden">
        {TITLE_BAR_MODES.map((m) => {
          const sel = mode === m.id;
          return (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
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

      <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mt-6 mb-1">
        Window
      </p>
      <div className="rounded-[14px] bg-th-surface border border-th-border-subtle overflow-hidden divide-y divide-th-border-subtle">
        <SettingRow
          title="Close to tray"
          subtitle="Minimize to system tray instead of quitting"
        >
          <button
            onClick={() => {
              const next = !minimizeToTray;
              setMinimizeToTray(next);
              invoke("set_minimize_to_tray", { enabled: next }).catch(() => {});
            }}
          >
            <Toggle on={minimizeToTray} />
          </button>
        </SettingRow>
      </div>
    </div>
  );
}
