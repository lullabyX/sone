import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MessageSquare } from "lucide-react";
import Toggle from "../Toggle";
import SettingRow from "./SettingRow";

export default function DiscordTab() {
  const [discordRpc, setDiscordRpc] = useState(false);
  const [discordStatusText, setDiscordStatusText] = useState("");
  const discordStatusSaveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    invoke<boolean>("get_discord_rpc")
      .then(setDiscordRpc)
      .catch(() => {});
    invoke<string>("get_discord_status_text")
      .then(setDiscordStatusText)
      .catch(() => {});
    return () => {
      clearTimeout(discordStatusSaveTimer.current);
    };
  }, []);

  const updateDiscordStatusText = (text: string) => {
    setDiscordStatusText(text);
    clearTimeout(discordStatusSaveTimer.current);
    discordStatusSaveTimer.current = window.setTimeout(() => {
      invoke("set_discord_status_text", { text }).catch(() => {});
    }, 500);
  };

  return (
    <div>
      <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mb-1">
        Discord
      </p>
      <SettingRow
        icon={MessageSquare}
        title="Discord Rich Presence"
        subtitle="Show what you're listening to on Discord"
      >
        <button
          onClick={() => {
            const next = !discordRpc;
            setDiscordRpc(next);
            invoke("set_discord_rpc", { enabled: next }).catch(() => {
              setDiscordRpc(!next);
            });
          }}
        >
          <Toggle on={discordRpc} />
        </button>
      </SettingRow>
      {discordRpc && (
        <div className="pl-[47px] pb-2 space-y-1.5">
          <label className="block text-[11px] text-th-text-muted">
            Status text
          </label>
          <input
            type="text"
            value={discordStatusText}
            onChange={(e) => updateDiscordStatusText(e.target.value)}
            placeholder="{track} by {artist} on {album}"
            className="w-full px-2.5 py-1.5 rounded-md bg-th-inset border border-th-border-subtle text-[12px] text-th-text-primary placeholder:text-th-text-disabled focus:border-th-accent/50 focus:outline-none"
          />
        </div>
      )}
    </div>
  );
}
