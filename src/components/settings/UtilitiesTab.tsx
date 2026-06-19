import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Folder } from "lucide-react";
import { clearAllCache } from "../../api/tidal";
import Toggle from "../Toggle";
import SettingRow from "./SettingRow";

export default function UtilitiesTab() {
  const [enableLogging, setEnableLogging] = useState(true);

  useEffect(() => {
    invoke<boolean>("get_enable_logging")
      .then(setEnableLogging)
      .catch(() => {});
  }, []);

  const openLogFolder = async () => {
    try {
      await invoke("open_log_folder");
    } catch (e) {
      console.error("Failed to open log folder:", e);
    }
  };

  return (
    <div>
      <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mb-1">
        Utilities
      </p>

      {/* Write logs — toggle row + log-folder sub-row (one setting, no divider between) */}
      <SettingRow
        title="Write logs to disk"
        subtitle="Helps when reporting bugs. ~12 MB cap."
      >
        <button
          onClick={() => {
            const next = !enableLogging;
            setEnableLogging(next);
            invoke("set_enable_logging", { enabled: next }).catch(() => {});
          }}
        >
          <Toggle on={enableLogging} />
        </button>
      </SettingRow>

      {enableLogging && (
        <div className="px-4 pb-3.5">
          <span className="block text-[10px] font-bold tracking-[0.9px] uppercase text-th-text-faint mb-[7px]">
            Log folder
          </span>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 px-[11px] py-2 rounded-[9px] bg-th-inset border border-th-border-subtle font-mono text-[11px] text-th-text-secondary whitespace-nowrap overflow-hidden text-ellipsis">
              ~/.config/sone/logs
            </code>
            <button
              onClick={openLogFolder}
              className="flex items-center gap-1.5 shrink-0 px-3 py-2 text-[12px] border border-th-border-subtle rounded-md text-th-text-secondary hover:text-th-text-primary hover:border-th-accent/50 transition-colors"
            >
              <Folder className="w-3.5 h-3.5" />
              Open folder
            </button>
          </div>
        </div>
      )}

      {/* Refresh App — separate setting, divider above */}
      <div className="border-t border-th-border-subtle">
        <SettingRow
          title="Refresh App"
          subtitle="Clear cache and reload the application"
        >
          <button
            onClick={async () => {
              await clearAllCache();
              window.location.reload();
            }}
            className="px-3 py-1 text-[12px] border border-th-border-subtle rounded-md text-th-text-secondary hover:text-th-text-primary hover:border-th-accent/50 transition-colors shrink-0"
          >
            Refresh
          </button>
        </SettingRow>
      </div>
    </div>
  );
}
