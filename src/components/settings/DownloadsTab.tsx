import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import SettingRow from "./SettingRow";

export default function DownloadsTab() {
  const [folder, setFolder] = useState<string | null>(null);

  useEffect(() => {
    invoke<string | null>("get_download_folder").then(setFolder).catch(() => {});
  }, []);

  const chooseFolder = async () => {
    const selected = await open({ directory: true, multiple: false, title: "Choose download folder" });
    if (!selected || Array.isArray(selected)) return;
    await invoke("set_download_folder", { folder: selected });
    setFolder(selected);
  };

  return (
    <div>
      <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mb-2.5">
        Downloads
      </p>
      <div className="rounded-[14px] bg-th-surface border border-th-border-subtle overflow-hidden">
        <SettingRow
          title="Folder"
          subtitle={folder ?? "Choose where downloaded music is saved"}
        >
          <button
            onClick={() => void chooseFolder()}
            className="shrink-0 rounded-lg border border-th-border-subtle px-3 py-1.5 text-[12px] font-semibold text-th-text-secondary hover:border-th-accent/50 hover:text-th-text-primary transition-colors"
          >
            {folder ? "Change" : "Choose folder"}
          </button>
        </SettingRow>
      </div>
    </div>
  );
}
