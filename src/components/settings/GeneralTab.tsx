import { useState, useEffect } from "react";
import { useAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { AppWindow, MonitorDown } from "lucide-react";
import { decorationsAtom, hideTitleBarAtom } from "../../atoms/ui";
import { useToast } from "../../contexts/ToastContext";
import Toggle from "../Toggle";
import SettingRow from "./SettingRow";

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

  return (
    <div>
      <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mb-1">
        General
      </p>
      <div className="divide-y divide-th-border-subtle">
        <SettingRow
          icon={AppWindow}
          title="Window decorations"
          subtitle="Show native title bar and window controls"
        >
          <button
            onClick={() => {
              const next = !decorations;
              setDecorations(next);
              invoke("set_decorations", { enabled: next }).catch(() => {
                setDecorations(!next);
                showToast("Failed to update window decorations");
              });
              // Turning system bar ON clears the "hide" override
              if (next && hideTitleBar) setHideTitleBar(false);
            }}
          >
            <Toggle on={decorations} />
          </button>
        </SettingRow>

        <SettingRow
          icon={AppWindow}
          title="Hide window decorations"
          subtitle="Hide title bar and window controls"
        >
          <button
            onClick={() => {
              const next = !hideTitleBar;
              setHideTitleBar(next);
              // Turning hide ON also disables the system bar
              if (next && decorations) {
                setDecorations(false);
                invoke("set_decorations", { enabled: false }).catch(() => {
                  setDecorations(true);
                  showToast("Failed to update window decorations");
                });
              }
            }}
          >
            <Toggle on={hideTitleBar} />
          </button>
        </SettingRow>

        <SettingRow
          icon={MonitorDown}
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
