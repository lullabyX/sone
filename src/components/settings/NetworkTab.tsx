import { useState, useEffect, useRef } from "react";
import { useAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { Globe } from "lucide-react";
import { proxySettingsAtom, type ProxySettings } from "../../atoms/proxy";
import Toggle from "../Toggle";
import SettingRow from "./SettingRow";

export default function NetworkTab() {
  const [proxySettings, setProxySettings] = useAtom(proxySettingsAtom);
  const [proxyTestStatus, setProxyTestStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >("idle");
  const [proxyTestMessage, setProxyTestMessage] = useState("");
  const proxySaveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      clearTimeout(proxySaveTimer.current);
    };
  }, []);

  const updateProxy = (patch: Partial<ProxySettings>) => {
    const next = { ...proxySettings, ...patch };
    setProxySettings(next);
    setProxyTestStatus("idle");
    clearTimeout(proxySaveTimer.current);
    proxySaveTimer.current = window.setTimeout(() => {
      invoke("set_proxy_settings", { settings: next }).catch(() => {});
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
    } catch (e: unknown) {
      setProxyTestStatus("error");
      setProxyTestMessage(
        typeof e === "string" ? e : e instanceof Error ? e.message : "Failed",
      );
    }
  };

  return (
    <div>
      <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mb-1">
        Network
      </p>
      <SettingRow icon={Globe} title="Proxy">
        <button
          onClick={() => updateProxy({ enabled: !proxySettings.enabled })}
        >
          <Toggle on={proxySettings.enabled} />
        </button>
      </SettingRow>

      {/* Proxy config (visible when enabled) */}
      {proxySettings.enabled && (
        <div className="pl-[47px] space-y-2 pb-2">
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
            {proxyTestStatus === "testing" ? "Testing..." : "Test Connection"}
          </button>

          {/* Test result */}
          {proxyTestStatus === "success" && (
            <p className="text-[11px] text-green-400">{proxyTestMessage}</p>
          )}
          {proxyTestStatus === "error" && (
            <p className="text-[11px] text-red-400">{proxyTestMessage}</p>
          )}
        </div>
      )}

      {!proxySettings.enabled && (
        <p className="text-[11px] text-th-text-muted pl-[47px] -mt-1">
          Enable proxy to configure connection settings
        </p>
      )}
    </div>
  );
}
