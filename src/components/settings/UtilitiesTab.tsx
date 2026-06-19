import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileText, RefreshCw } from "lucide-react";
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

  return (
    <div>
      <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mb-1">
        Utilities
      </p>
      <div className="divide-y divide-th-border-subtle">
        <SettingRow
          icon={FileText}
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

        <SettingRow
          icon={RefreshCw}
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
