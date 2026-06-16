import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAtom, useStore } from "jotai";
import {
  X,
  Infinity as InfinityIcon,
  Film,
  Volume2,
  MessageSquare,
  AppWindow,
  MonitorDown,
  Globe,
  RefreshCw,
  ShieldAlert,
  FileText,
  Cpu,
} from "lucide-react";
import {
  autoplayAtom,
  bitPerfectAtom,
  volumeNormalizationAtom,
  allowExplicitAtom,
  currentTrackAtom,
  isPlayingAtom,
  queueAtom,
  manualQueueAtom,
  originalQueueAtom,
  historyAtom,
  playbackSourceAtom,
  contextSourceAtom,
} from "../atoms/playback";

function ExplicitContentToggle() {
  const [allowExplicit, setAllowExplicit] = useAtom(allowExplicitAtom);
  const store = useStore();

  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex items-center gap-3 min-w-0">
        <ShieldAlert size={16} className="text-th-text-muted shrink-0" />
        <div>
          <p className="text-[13px] text-th-text-secondary">
            Allow explicit content
          </p>
          <p className="text-[11px] text-th-text-muted">
            Allow playing tracks marked as explicit
          </p>
        </div>
      </div>
      <button
        onClick={() => {
          setAllowExplicit(!allowExplicit);
          invoke("stop_track").catch(() => {});
          store.set(currentTrackAtom, null);
          store.set(isPlayingAtom, false);
          store.set(queueAtom, []);
          store.set(manualQueueAtom, []);
          store.set(originalQueueAtom, null);
          store.set(historyAtom, []);
          store.set(playbackSourceAtom, null);
          store.set(contextSourceAtom, null);
        }}
      >
        <Toggle on={allowExplicit} />
      </button>
    </div>
  );
}
import { proxySettingsAtom, type ProxySettings } from "../atoms/proxy";
import { mcpConnectionInfoAtom, type McpConnectionInfo } from "../atoms/mcp";
import { decorationsAtom, hideTitleBarAtom, videoCoversAtom } from "../atoms/ui";
import { useToast } from "../contexts/ToastContext";
import { clearAllCache } from "../api/tidal";
import Toggle from "./Toggle";

type TabId = "playback" | "integrations" | "general" | "network" | "utilities" | "mcp";

const TABS: { id: TabId; label: string; icon: typeof Volume2 }[] = [
  { id: "playback",     label: "Playback",     icon: Volume2 },
  { id: "integrations", label: "Integrations", icon: MessageSquare },
  { id: "general",      label: "General",      icon: AppWindow },
  { id: "network",      label: "Network",      icon: Globe },
  { id: "utilities",    label: "Utilities",    icon: FileText },
  { id: "mcp",          label: "MCP",          icon: Cpu },
];

function McpSettingsTab() {
  const [info, setInfo] = useAtom(mcpConnectionInfoAtom);
  const [enabled, setEnabled] = useState(info.enabled);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<McpConnectionInfo>("mcp_get_connection_info")
      .then((i) => { setInfo(i); setEnabled(i.enabled); })
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
      const i = await invoke<McpConnectionInfo>("mcp_set_enabled", { enabled: next });
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
    if (!confirm("Regenerate token? Any connected MCP clients will need to reconnect with the new URL.")) return;
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
      <div className="flex items-center justify-between py-3 border-b border-th-border-subtle">
        <div className="flex items-center gap-3 min-w-0">
          <Cpu size={16} className="text-th-text-muted shrink-0" />
          <div>
            <p className="text-[13px] text-th-text-secondary">MCP server</p>
            <p className="text-[11px] text-th-text-muted">
              Expose SONE to Claude Code and other MCP clients
            </p>
          </div>
        </div>
        <button
          onClick={() => toggle(!enabled)}
          disabled={busy}
          className={busy ? "cursor-not-allowed opacity-50" : ""}
        >
          <Toggle on={enabled} />
        </button>
      </div>

      {info.url ? (
        <div className="py-3 space-y-3">
          <div>
            <p className="text-[11px] text-th-text-muted mb-1.5">Connection URL</p>
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
            <span className="text-[11px] text-th-text-muted">Port: {info.port}</span>
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

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [autoplay, setAutoplay] = useAtom(autoplayAtom);
  const [videoCovers, setVideoCovers] = useAtom(videoCoversAtom);
  const [bitPerfect] = useAtom(bitPerfectAtom);
  const [volumeNormalization, setVolumeNormalization] = useAtom(
    volumeNormalizationAtom,
  );
  const [discordRpc, setDiscordRpc] = useState(false);
  const [discordStatusText, setDiscordStatusText] = useState("");
  const [decorations, setDecorations] = useAtom(decorationsAtom);
  const [hideTitleBar, setHideTitleBar] = useAtom(hideTitleBarAtom);
  const [minimizeToTray, setMinimizeToTray] = useState(false);
  const [enableLogging, setEnableLogging] = useState(true);
  const [proxySettings, setProxySettings] = useAtom(proxySettingsAtom);
  const [proxyTestStatus, setProxyTestStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [proxyTestMessage, setProxyTestMessage] = useState("");
  const [activeTab, setActiveTab] = useState<TabId>("playback");
  const { showToast } = useToast();
  const panelRef = useRef<HTMLDivElement>(null);
  const proxySaveTimer = useRef<number | undefined>(undefined);
  const discordStatusSaveTimer = useRef<number | undefined>(undefined);

  // Load backend-synced preferences when modal opens
  useEffect(() => {
    if (!open) return;
    setActiveTab("playback");
    // volume normalization atom is hydrated globally on app boot via
    // AppInitializer and kept in sync by setBitPerfect/the toggle handler.
    // decorations atom is hydrated globally on app boot via AppInitializer;
    // no per-modal-open re-fetch needed.
    invoke<boolean>("get_minimize_to_tray")
      .then(setMinimizeToTray)
      .catch(() => {});
    invoke<boolean>("get_discord_rpc")
      .then(setDiscordRpc)
      .catch(() => {});
    invoke<boolean>("get_enable_logging")
      .then(setEnableLogging)
      .catch(() => {});
    invoke<string>("get_discord_status_text")
      .then(setDiscordStatusText)
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    return () => {
      clearTimeout(proxySaveTimer.current);
      clearTimeout(discordStatusSaveTimer.current);
    };
  }, []);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const updateProxy = (patch: Partial<ProxySettings>) => {
    const next = { ...proxySettings, ...patch };
    setProxySettings(next);
    setProxyTestStatus("idle");
    clearTimeout(proxySaveTimer.current);
    proxySaveTimer.current = window.setTimeout(() => {
      invoke("set_proxy_settings", { settings: next }).catch(() => {});
    }, 500);
  };

  const updateDiscordStatusText = (text: string) => {
    setDiscordStatusText(text);
    clearTimeout(discordStatusSaveTimer.current);
    discordStatusSaveTimer.current = window.setTimeout(() => {
      invoke("set_discord_status_text", { text }).catch(() => {});
    }, 500);
  };

  const testProxy = async () => {
    setProxyTestStatus("testing");
    try {
      const msg = await invoke<string>("test_proxy_connection", {
        settings: proxySettings,
      });
      setProxyTestStatus("success");
      setProxyTestMessage(msg);
    } catch (e: any) {
      setProxyTestStatus("error");
      setProxyTestMessage(typeof e === "string" ? e : e.message || "Failed");
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fadeIn">
        <div
          ref={panelRef}
          className="bg-th-elevated rounded-xl shadow-2xl w-[600px] min-h-[480px] max-h-[80vh] flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-th-border-subtle">
            <h2 className="text-[16px] font-bold text-th-text-primary">
              Settings
            </h2>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-th-inset transition-colors text-th-text-muted hover:text-th-text-primary"
            >
              <X size={18} />
            </button>
          </div>

          {/* Body: rail + active pane */}
          <div className="flex flex-1 min-h-0">
            {/* Left rail */}
            <nav className="w-[160px] shrink-0 border-r border-th-border-subtle py-4 px-2 flex flex-col gap-0.5">
              {TABS.map(({ id, label, icon: Icon }) => {
                const active = activeTab === id;
                return (
                  <button
                    key={id}
                    onClick={() => setActiveTab(id)}
                    className={`relative flex items-center gap-3 px-3 py-2 rounded-md text-left text-[13px] transition-colors ${
                      active
                        ? "bg-th-inset text-th-text-primary"
                        : "text-th-text-secondary hover:bg-th-inset/50"
                    }`}
                  >
                    {active && (
                      <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-th-accent" />
                    )}
                    <Icon size={16} className="shrink-0" />
                    {label}
                  </button>
                );
              })}
            </nav>

            {/* Right pane (scrolls independently) */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {activeTab === "playback" && (
                <div>
                  {/* Autoplay */}
                  <div className="flex items-center justify-between py-3 border-b border-th-border-subtle">
                    <div className="flex items-center gap-3 min-w-0">
                      <InfinityIcon
                        size={16}
                        className="text-th-text-muted shrink-0"
                      />
                      <div>
                        <p className="text-[13px] text-th-text-secondary">
                          Autoplay
                        </p>
                        <p className="text-[11px] text-th-text-muted">
                          Automatically play similar tracks when queue ends
                        </p>
                      </div>
                    </div>
                    <button onClick={() => setAutoplay(!autoplay)}>
                      <Toggle on={autoplay} />
                    </button>
                  </div>

                  {/* Animated album covers */}
                  <div className="flex items-center justify-between py-3 border-b border-th-border-subtle">
                    <div className="flex items-center gap-3 min-w-0">
                      <Film size={16} className="text-th-text-muted shrink-0" />
                      <div>
                        <p className="text-[13px] text-th-text-secondary">
                          Animated album covers
                        </p>
                        <p className="text-[11px] text-th-text-muted">
                          Play motion covers in the player when available
                        </p>
                      </div>
                    </div>
                    <button onClick={() => setVideoCovers(!videoCovers)}>
                      <Toggle on={videoCovers} />
                    </button>
                  </div>

                  {/* Normalize volume */}
                  <div
                    className={`flex items-center justify-between py-3 ${
                      bitPerfect ? "opacity-50" : ""
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Volume2
                        size={16}
                        className="text-th-text-muted shrink-0"
                      />
                      <div>
                        <p className="text-[13px] text-th-text-secondary">
                          Normalize volume
                        </p>
                        <p className="text-[11px] text-th-text-muted">
                          Even out volume differences between tracks
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        if (bitPerfect) return;
                        const next = !volumeNormalization;
                        setVolumeNormalization(next);
                        invoke("set_volume_normalization", { enabled: next }).catch(
                          () => {},
                        );
                      }}
                      disabled={bitPerfect}
                      className={bitPerfect ? "cursor-not-allowed" : ""}
                    >
                      <Toggle on={volumeNormalization} />
                    </button>
                  </div>

                  {/* Allow explicit content */}
                  <ExplicitContentToggle />
                </div>
              )}

              {activeTab === "integrations" && (
                <div>
                  {/* Discord Rich Presence */}
                  <div className="flex items-center justify-between pt-3"
                    style={{ paddingBottom: discordRpc ? "6px" : "12px" }}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <MessageSquare
                        size={16}
                        className="text-th-text-muted shrink-0"
                      />
                      <div>
                        <p className="text-[13px] text-th-text-secondary">
                          Discord Rich Presence
                        </p>
                        <p className="text-[11px] text-th-text-muted">
                          Show what you're listening to on Discord
                        </p>
                      </div>
                    </div>
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
                  </div>
                  {discordRpc && (
                    <div className="pl-7 pb-2 space-y-1.5">
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
              )}

              {activeTab === "general" && (
                <div>
                  {/* Use native window controls (escape hatch from custom titlebar) */}
                  <div className="flex items-center justify-between py-3 border-b border-th-border-subtle">
                    <div className="flex items-center gap-3 min-w-0">
                      <AppWindow
                        size={16}
                        className="text-th-text-muted shrink-0"
                      />
                      <div>
                        <p className="text-[13px] text-th-text-secondary">
                          Window decorations
                        </p>
                        <p className="text-[11px] text-th-text-muted">
                          Show native title bar and window controls
                        </p>
                      </div>
                    </div>
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
                  </div>

                  {/* Hide title bar entirely */}
                  <div className="flex items-center justify-between py-3 border-b border-th-border-subtle">
                    <div className="flex items-center gap-3 min-w-0">
                      <AppWindow
                        size={16}
                        className="text-th-text-muted shrink-0"
                      />
                      <div>
                        <p className="text-[13px] text-th-text-secondary">
                          Hide window decorations
                        </p>
                        <p className="text-[11px] text-th-text-muted">
                          Hide title bar and window controls
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        const next = !hideTitleBar;
                        setHideTitleBar(next);
                        // Turning hide ON also disables the system bar
                        if (next && decorations) {
                          setDecorations(false);
                          invoke("set_decorations", { enabled: false }).catch(
                            () => {
                              setDecorations(true);
                              showToast("Failed to update window decorations");
                            },
                          );
                        }
                      }}
                    >
                      <Toggle on={hideTitleBar} />
                    </button>
                  </div>

                  {/* Close to tray */}
                  <div className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <MonitorDown
                        size={16}
                        className="text-th-text-muted shrink-0"
                      />
                      <div>
                        <p className="text-[13px] text-th-text-secondary">
                          Close to tray
                        </p>
                        <p className="text-[11px] text-th-text-muted">
                          Minimize to system tray instead of quitting
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        const next = !minimizeToTray;
                        setMinimizeToTray(next);
                        invoke("set_minimize_to_tray", { enabled: next }).catch(
                          () => {},
                        );
                      }}
                    >
                      <Toggle on={minimizeToTray} />
                    </button>
                  </div>
                </div>
              )}

              {activeTab === "network" && (
                <div>
                  {/* Proxy toggle */}
                  <div className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Globe size={16} className="text-th-text-muted shrink-0" />
                      <div>
                        <p className="text-[13px] text-th-text-secondary">Proxy</p>
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        updateProxy({ enabled: !proxySettings.enabled })
                      }
                    >
                      <Toggle on={proxySettings.enabled} />
                    </button>
                  </div>

                  {/* Proxy config (visible when enabled) */}
                  {proxySettings.enabled && (
                    <div className="pl-9 space-y-2 pb-2">
                      {/* Type selector */}
                      <div className="flex gap-2">
                        {(["http", "socks5"] as const).map((t) => (
                          <button
                            key={t}
                            onClick={() => updateProxy({ proxy_type: t })}
                            className={`flex-1 text-[12px] py-1.5 rounded-md border transition-colors ${
                              proxySettings.proxy_type === t
                                ? "border-th-accent text-th-accent bg-th-accent/10"
                                : "border-th-border-subtle text-th-text-muted hover:border-th-accent/50"
                            }`}
                          >
                            {t.toUpperCase()}
                          </button>
                        ))}
                      </div>

                      {/* Host + Port */}
                      <div className="flex gap-2">
                        <input
                          type="text"
                          placeholder="Host"
                          value={proxySettings.host}
                          onChange={(e) => updateProxy({ host: e.target.value })}
                          className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-th-inset border border-th-border-subtle text-[12px] text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent/50 focus:outline-none"
                        />
                        <input
                          type="number"
                          placeholder="Port"
                          value={proxySettings.port || ""}
                          onChange={(e) =>
                            updateProxy({ port: parseInt(e.target.value) || 0 })
                          }
                          className="w-20 px-2.5 py-1.5 rounded-md bg-th-inset border border-th-border-subtle text-[12px] text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent/50 focus:outline-none"
                        />
                      </div>

                      {/* Username + Password */}
                      <input
                        type="text"
                        placeholder="Username (optional)"
                        value={proxySettings.username || ""}
                        onChange={(e) =>
                          updateProxy({ username: e.target.value || null })
                        }
                        className="w-full px-2.5 py-1.5 rounded-md bg-th-inset border border-th-border-subtle text-[12px] text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent/50 focus:outline-none"
                      />
                      <input
                        type="password"
                        placeholder="Password (optional)"
                        value={proxySettings.password || ""}
                        onChange={(e) =>
                          updateProxy({ password: e.target.value || null })
                        }
                        className="w-full px-2.5 py-1.5 rounded-md bg-th-inset border border-th-border-subtle text-[12px] text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent/50 focus:outline-none"
                      />

                      {/* Test button */}
                      <button
                        onClick={testProxy}
                        disabled={
                          proxyTestStatus === "testing" ||
                          !proxySettings.host ||
                          !proxySettings.port
                        }
                        className="w-full py-1.5 rounded-md text-[12px] font-medium border border-th-border-subtle text-th-text-secondary hover:text-th-text-primary hover:border-th-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {proxyTestStatus === "testing"
                          ? "Testing..."
                          : "Test Connection"}
                      </button>

                      {/* Test result */}
                      {proxyTestStatus === "success" && (
                        <p className="text-[11px] text-green-400">
                          {proxyTestMessage}
                        </p>
                      )}
                      {proxyTestStatus === "error" && (
                        <p className="text-[11px] text-red-400">
                          {proxyTestMessage}
                        </p>
                      )}
                    </div>
                  )}

                  {!proxySettings.enabled && (
                    <p className="text-[11px] text-th-text-muted pl-9 -mt-1">
                      Enable proxy to configure connection settings
                    </p>
                  )}
                </div>
              )}

              {activeTab === "mcp" && <McpSettingsTab />}

              {activeTab === "utilities" && (
                <div>
                  {/* Write logs to disk */}
                  <div className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <FileText
                        size={16}
                        className="text-th-text-muted shrink-0"
                      />
                      <div>
                        <p className="text-[13px] text-th-text-secondary">
                          Write logs to disk
                        </p>
                        <p className="text-[11px] text-th-text-muted">
                          Helps when reporting bugs. ~12 MB cap.
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        const next = !enableLogging;
                        setEnableLogging(next);
                        invoke("set_enable_logging", { enabled: next }).catch(
                          () => {},
                        );
                      }}
                    >
                      <Toggle on={enableLogging} />
                    </button>
                  </div>

                  {/* Refresh App */}
                  <div className="flex items-center justify-between py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <RefreshCw
                        size={16}
                        className="text-th-text-muted shrink-0"
                      />
                      <div>
                        <p className="text-[13px] text-th-text-secondary">
                          Refresh App
                        </p>
                        <p className="text-[11px] text-th-text-muted">
                          Clear cache and reload the application
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        await clearAllCache();
                        window.location.reload();
                      }}
                      className="px-3 py-1 text-[12px] border border-th-border-subtle rounded-md text-th-text-secondary hover:text-th-text-primary hover:border-th-accent/50 transition-colors shrink-0"
                    >
                      Refresh
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
  );
}
