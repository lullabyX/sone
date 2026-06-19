import { useState, useEffect, useRef } from "react";
import { useAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown } from "lucide-react";
import { proxySettingsAtom, type ProxySettings } from "../../atoms/proxy";
import Toggle from "../Toggle";
import SettingRow from "./SettingRow";

type BannerStatus = "idle" | "testing" | "ok" | "err";

export default function NetworkTab() {
  const [proxySettings, setProxySettings] = useAtom(proxySettingsAtom);
  const [bannerStatus, setBannerStatus] = useState<BannerStatus>("idle");
  const [bannerMessage, setBannerMessage] = useState("Not tested");
  const proxySaveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      clearTimeout(proxySaveTimer.current);
    };
  }, []);

  const updateProxy = (patch: Partial<ProxySettings>) => {
    const next = { ...proxySettings, ...patch };
    setProxySettings(next);
    setBannerStatus("idle");
    setBannerMessage("Not tested");
    clearTimeout(proxySaveTimer.current);
    proxySaveTimer.current = window.setTimeout(() => {
      invoke("set_proxy_settings", { settings: next }).catch(() => {});
    }, 500);
  };

  const toggleProtocol = () => {
    updateProxy({
      proxy_type: proxySettings.proxy_type === "http" ? "socks5" : "http",
    });
  };

  const testProxy = async () => {
    setBannerStatus("testing");
    setBannerMessage("Testing…");
    try {
      const msg = await invoke<string>("test_proxy_connection", {
        settings: proxySettings,
      });
      setBannerStatus("ok");
      setBannerMessage(msg || "Connected");
    } catch (e: unknown) {
      console.error("Proxy connection test failed:", e);
      setBannerStatus("err");
      setBannerMessage("Connection failed — check host, port, and credentials");
    }
  };

  const endpoint = `${proxySettings.proxy_type}://${proxySettings.host || "host"}:${proxySettings.port || "port"}`;

  // Banner color treatment: ok → accent, err → red, idle/testing → neutral.
  const bannerSurface =
    bannerStatus === "ok"
      ? "bg-th-accent/10 border-th-accent/20"
      : bannerStatus === "err"
        ? "bg-[#ff6666]/10 border-[#ff6666]/25"
        : "bg-th-inset border-th-border-subtle";
  const dotClass =
    bannerStatus === "ok"
      ? "bg-th-accent"
      : bannerStatus === "err"
        ? "bg-[#ff6666]"
        : "bg-th-text-faint";
  const dotGlow =
    bannerStatus === "ok"
      ? "0 0 0 3px color-mix(in srgb, var(--th-accent) 20%, transparent)"
      : bannerStatus === "err"
        ? "0 0 0 3px rgba(255,102,102,0.2)"
        : undefined;
  const msgClass =
    bannerStatus === "ok"
      ? "text-th-accent"
      : bannerStatus === "err"
        ? "text-[#ff6666]"
        : "text-th-text-muted";

  return (
    <div>
      <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mb-1">
        Network
      </p>
      <SettingRow
        title="Proxy"
        subtitle="Route all Tidal traffic through a proxy server"
      >
        <button
          onClick={() => updateProxy({ enabled: !proxySettings.enabled })}
        >
          <Toggle on={proxySettings.enabled} />
        </button>
      </SettingRow>

      {/* Proxy config — revealed only when enabled */}
      {proxySettings.enabled && (
        <div className="px-4 pb-4 pt-4 border-t border-th-border-subtle">
          {/* Connection status banner */}
          <div
            className={`flex items-center gap-2.5 px-[13px] py-[11px] rounded-[11px] border mb-4 transition-colors ${bannerSurface}`}
          >
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 transition-[background,box-shadow] ${dotClass}`}
              style={{ boxShadow: dotGlow }}
            />
            <span className="font-mono text-[12px] text-th-text-secondary min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {endpoint}
            </span>
            <span
              className={`ml-auto text-[11px] font-semibold flex-shrink-0 ${msgClass}`}
            >
              {bannerMessage}
            </span>
          </div>

          {/* Proxy address — endpoint builder */}
          <div>
            <span className="block text-[10px] font-bold tracking-[0.9px] uppercase text-th-text-faint mb-[7px]">
              Proxy address
            </span>
            <div className="flex items-stretch rounded-[10px] border border-th-border-subtle bg-th-inset overflow-hidden transition-colors focus-within:border-th-accent/55">
              <button
                onClick={toggleProtocol}
                className="flex items-center gap-1.5 px-3 text-[11.5px] font-bold font-mono text-th-accent bg-th-accent/[0.09] border-r border-th-border-subtle whitespace-nowrap"
              >
                {proxySettings.proxy_type.toUpperCase()}
                <ChevronDown className="w-[11px] h-[11px] opacity-80" />
              </button>
              <input
                type="text"
                placeholder="host"
                value={proxySettings.host}
                onChange={(e) => updateProxy({ host: e.target.value })}
                className="flex-1 min-w-0 px-3 py-[9px] bg-transparent border-none font-mono text-[12.5px] text-th-text-primary placeholder:text-th-text-muted focus:outline-none"
              />
              <span className="flex items-center text-th-text-faint font-mono">
                :
              </span>
              <input
                type="number"
                placeholder="port"
                value={proxySettings.port || ""}
                onChange={(e) =>
                  updateProxy({ port: parseInt(e.target.value) || 0 })
                }
                className="w-[62px] px-2 py-[9px] bg-transparent border-0 border-l border-th-border-subtle font-mono text-[12.5px] text-th-text-primary placeholder:text-th-text-muted focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            </div>
          </div>

          {/* Authentication — optional */}
          <div className="mt-[15px]">
            <span className="block text-[10px] font-bold tracking-[0.9px] uppercase text-th-text-faint mb-[7px]">
              Authentication · optional
            </span>
            <div className="flex gap-[9px]">
              <input
                type="text"
                placeholder="Username"
                value={proxySettings.username || ""}
                onChange={(e) =>
                  updateProxy({ username: e.target.value || null })
                }
                className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-th-inset border border-th-border-subtle text-[12px] text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent/50 focus:outline-none"
              />
              <input
                type="password"
                placeholder="Password"
                value={proxySettings.password || ""}
                onChange={(e) =>
                  updateProxy({ password: e.target.value || null })
                }
                className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-th-inset border border-th-border-subtle text-[12px] text-th-text-primary placeholder:text-th-text-muted focus:border-th-accent/50 focus:outline-none"
              />
            </div>
          </div>

          {/* Test connection */}
          <button
            onClick={testProxy}
            disabled={
              bannerStatus === "testing" ||
              !proxySettings.host ||
              !proxySettings.port
            }
            className="mt-[15px] w-full py-2 rounded-lg text-[12px] font-semibold border border-th-border-subtle text-th-text-secondary hover:text-th-text-primary hover:border-th-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {bannerStatus === "testing" ? "Testing…" : "Test connection"}
          </button>
        </div>
      )}
    </div>
  );
}
