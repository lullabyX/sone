import { useState, useEffect } from "react";
import { useAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { Eye, EyeOff } from "lucide-react";
import { mcpConnectionInfoAtom, type McpConnectionInfo } from "../../atoms/mcp";
import Toggle from "../Toggle";
import SettingRow from "./SettingRow";

export default function McpTab() {
  const [info, setInfo] = useAtom(mcpConnectionInfoAtom);
  const [enabled, setEnabled] = useState(info.enabled);
  const [revealed, setRevealed] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<McpConnectionInfo>("mcp_get_connection_info")
      .then((i) => {
        setInfo(i);
        setEnabled(i.enabled);
      })
      .catch(() => {});
  }, [setInfo]);

  const copy = async (
    text: string,
    setFlag: (v: boolean) => void,
  ): Promise<void> => {
    await navigator.clipboard.writeText(text);
    setFlag(true);
    setTimeout(() => setFlag(false), 1500);
  };

  const toggle = async (next: boolean) => {
    setBusy(true);
    setEnabled(next);
    setRevealed(false);
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
      setRevealed(false);
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
          title="MCP server"
          subtitle="Expose SONE to AI clients that support MCP"
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
        (() => {
          const token = new URL(info.url).searchParams.get("token") ?? "";
          const masked = "•".repeat(12);
          const shown = revealed ? token : masked;
          const shownUrl = token ? info.url.replace(token, shown) : info.url;
          const snippet = `{\n  "mcpServers": {\n    "sone": {\n      "type": "http",\n      "url": "${shownUrl}"\n    }\n  }\n}`;
          const realSnippet = `{\n  "mcpServers": {\n    "sone": {\n      "type": "http",\n      "url": "${info.url}"\n    }\n  }\n}`;

          return (
            <div className="px-4 pb-4 pt-4 border-t border-th-border-subtle">
              {/* Status banner — accent when running, neutral when stopped */}
              <div
                className={`flex items-center gap-2.5 px-[13px] py-[11px] rounded-[11px] border mb-4 transition-colors ${
                  enabled
                    ? "bg-th-accent/10 border-th-accent/20"
                    : "bg-th-inset border-th-border-subtle"
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 transition-[background,box-shadow] ${
                    enabled ? "bg-th-accent" : "bg-th-text-faint"
                  }`}
                  style={
                    enabled
                      ? {
                          boxShadow:
                            "0 0 0 3px color-mix(in srgb, var(--th-accent) 20%, transparent)",
                        }
                      : undefined
                  }
                />
                <span className="font-mono text-[12px] text-th-text-secondary min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                  127.0.0.1:{info.port}
                </span>
                <span
                  className={`ml-auto text-[11px] font-semibold flex-shrink-0 ${
                    enabled ? "text-th-accent" : "text-th-text-muted"
                  }`}
                >
                  {enabled ? "Running" : "Stopped"}
                </span>
              </div>

              {enabled && (
                <>
                  {/* Connection details */}
                  <span className="block text-[10px] font-bold tracking-[0.9px] uppercase text-th-text-faint mb-[7px]">
                    Connection details
                  </span>
                  <div className="rounded-[11px] border border-th-border-subtle bg-th-inset px-[13px] py-0.5">
                    <div className="flex items-center gap-3 py-2.5">
                      <span className="w-[84px] flex-shrink-0 text-[10px] font-bold tracking-[0.8px] uppercase text-th-text-faint">
                        Transport
                      </span>
                      <span className="flex-1 min-w-0 font-mono text-[12px] text-th-text-secondary">
                        Streamable HTTP
                      </span>
                    </div>
                    <div className="flex items-center gap-3 py-2.5 border-t border-th-border-subtle">
                      <span className="w-[84px] flex-shrink-0 text-[10px] font-bold tracking-[0.8px] uppercase text-th-text-faint">
                        URL
                      </span>
                      <span className="flex-1 min-w-0 font-mono text-[12px] text-th-text-primary overflow-hidden text-ellipsis whitespace-nowrap">
                        {shownUrl}
                      </span>
                      <span className="flex gap-1.5 flex-shrink-0">
                        <button
                          onClick={() => setRevealed((v) => !v)}
                          title={revealed ? "Hide token" : "Reveal token"}
                          className={`w-[34px] h-[34px] rounded-lg border grid place-items-center transition-colors ${
                            revealed
                              ? "border-th-accent/45 text-th-accent"
                              : "border-th-border-subtle text-th-text-muted hover:text-th-text-primary hover:border-th-accent/50"
                          }`}
                        >
                          {revealed ? (
                            <EyeOff className="w-[15px] h-[15px]" />
                          ) : (
                            <Eye className="w-[15px] h-[15px]" />
                          )}
                        </button>
                        <button
                          onClick={() => copy(info.url!, setUrlCopied)}
                          className="px-2.5 py-1.5 text-[12px] border border-th-border-subtle rounded-md text-th-text-secondary hover:text-th-text-primary hover:border-th-accent/50 transition-colors"
                        >
                          {urlCopied ? "Copied" : "Copy"}
                        </button>
                      </span>
                    </div>
                    <div className="flex items-center gap-3 py-2.5 border-t border-th-border-subtle">
                      <span className="w-[84px] flex-shrink-0 text-[10px] font-bold tracking-[0.8px] uppercase text-th-text-faint">
                        Port
                      </span>
                      <span className="flex-1 min-w-0 font-mono text-[12px] text-th-text-secondary">
                        {info.port}
                      </span>
                    </div>
                  </div>

                  {/* Client config — portable mcpServers snippet */}
                  <div className="flex items-center gap-2.5 mt-4 mb-2">
                    <span className="text-[10px] font-bold tracking-[0.9px] uppercase text-th-text-faint">
                      Client config
                    </span>
                    <button
                      onClick={() => copy(realSnippet, setSnippetCopied)}
                      className="ml-auto px-3 py-[5px] text-[12px] border border-th-border-subtle rounded-md text-th-text-secondary hover:text-th-text-primary hover:border-th-accent/50 transition-colors"
                    >
                      {snippetCopied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <div className="rounded-[10px] border border-th-border-subtle bg-th-inset px-[13px] py-3 overflow-x-auto">
                    <code className="block font-mono text-[11.5px] leading-[1.6] text-th-text-secondary whitespace-pre">
                      {snippet}
                    </code>
                  </div>
                  <p className="text-[11px] text-th-text-muted mt-2.5">
                    Standard{" "}
                    <span className="font-mono text-th-text-secondary">
                      mcpServers
                    </span>{" "}
                    format — drop into Claude, Cursor, Cline, Windsurf, or any
                    MCP client.
                  </p>

                  {/* Regenerate token */}
                  <div className="flex items-center justify-between mt-4">
                    <button
                      onClick={regenerate}
                      disabled={busy}
                      className="px-3 py-1.5 text-[12px] border border-th-border-subtle rounded-md text-th-text-secondary hover:text-th-text-primary hover:border-th-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Regenerate token
                    </button>
                    <span className="text-[11px] text-th-text-muted">
                      Disconnects connected clients
                    </span>
                  </div>
                </>
              )}
            </div>
          );
        })()
      ) : (
        <p className="text-[11px] text-th-text-muted pt-3">
          {enabled ? "Starting…" : "Enable the server to get a connection URL."}
        </p>
      )}
    </div>
  );
}
