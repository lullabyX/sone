import { useState, useEffect } from "react";
import { useAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { Cpu } from "lucide-react";
import { mcpConnectionInfoAtom, type McpConnectionInfo } from "../../atoms/mcp";
import Toggle from "../Toggle";
import SettingRow from "./SettingRow";

export default function McpTab() {
  const [info, setInfo] = useAtom(mcpConnectionInfoAtom);
  const [enabled, setEnabled] = useState(info.enabled);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<McpConnectionInfo>("mcp_get_connection_info")
      .then((i) => {
        setInfo(i);
        setEnabled(i.enabled);
      })
      .catch(() => {});
  }, [setInfo]);

  const copyUrl = async () => {
    if (!info.url) return;
    await navigator.clipboard.writeText(info.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const toggle = async (next: boolean) => {
    setBusy(true);
    setEnabled(next);
    try {
      const i = await invoke<McpConnectionInfo>("mcp_set_enabled", {
        enabled: next,
      });
      setInfo(i);
      setEnabled(i.enabled);
    } catch (e) {
      console.error("mcp_set_enabled failed:", e);
      setEnabled(!next);
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    if (
      !confirm(
        "Regenerate token? Any connected MCP clients will need to reconnect with the new URL.",
      )
    )
      return;
    setBusy(true);
    try {
      const i = await invoke<McpConnectionInfo>("mcp_regenerate_token");
      setInfo(i);
    } catch (e) {
      console.error("mcp_regenerate_token failed:", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mb-1">
        MCP
      </p>
      <div className="border-b border-th-border-subtle">
        <SettingRow
          icon={Cpu}
          title="MCP server"
          subtitle="Expose SONE to Claude Code and other MCP clients"
        >
          <button
            onClick={() => toggle(!enabled)}
            disabled={busy}
            className={busy ? "cursor-not-allowed opacity-50" : ""}
          >
            <Toggle on={enabled} />
          </button>
        </SettingRow>
      </div>

      {info.url ? (
        <div className="py-3 space-y-3">
          <div>
            <p className="text-[11px] text-th-text-muted mb-1.5">
              Connection URL
            </p>
            <div className="flex gap-2 items-center">
              <code className="flex-1 min-w-0 truncate px-2.5 py-1.5 rounded-md bg-th-inset border border-th-border-subtle text-[11px] text-th-text-secondary">
                {info.url}
              </code>
              <button
                onClick={copyUrl}
                className="shrink-0 px-3 py-1.5 text-[12px] border border-th-border-subtle rounded-md text-th-text-secondary hover:text-th-text-primary hover:border-th-accent/50 transition-colors"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <button
              onClick={regenerate}
              disabled={busy}
              className="px-3 py-1.5 text-[12px] border border-th-border-subtle rounded-md text-th-text-secondary hover:text-th-text-primary hover:border-th-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Regenerate token
            </button>
            <span className="text-[11px] text-th-text-muted">
              Port: {info.port}
            </span>
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-th-text-muted pt-3">
          {enabled ? "Starting…" : "Enable the server to get a connection URL."}
        </p>
      )}
    </div>
  );
}
