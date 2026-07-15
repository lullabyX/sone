import { useState, useEffect } from "react";
import { useAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { overlayConnectionInfoAtom, type OverlayConnectionInfo } from "../../atoms/overlay";
import { safeErrorMessage } from "../../lib/errorUtils";
import Toggle from "../Toggle";
import SettingRow from "./SettingRow";

export default function OverlayTab() {
  const [info, setInfo] = useAtom(overlayConnectionInfoAtom);
  const [enabled, setEnabled] = useState(info.enabled);
  const [portInput, setPortInput] = useState(String(info.port ?? 5578));
  const [hostInput, setHostInput] = useState(info.host ?? "127.0.0.1");
  const [urlCopied, setUrlCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [portError, setPortError] = useState("");
  const [hostError, setHostError] = useState("");
  const [toggleError, setToggleError] = useState("");

  useEffect(() => {
    invoke<OverlayConnectionInfo>("overlay_get_connection_info")
      .then((i) => {
        setInfo(i);
        setEnabled(i.enabled);
        setPortInput(String(i.port ?? 5578));
        setHostInput(i.host ?? "127.0.0.1");
      })
      .catch(() => {});
  }, [setInfo]);

  const refresh = async () => {
    try {
      const i = await invoke<OverlayConnectionInfo>("overlay_get_connection_info");
      setInfo(i);
      setEnabled(i.enabled);
    } catch {
      // keep last known state
    }
  };

  const copy = async (text: string): Promise<void> => {
    await navigator.clipboard.writeText(text);
    setUrlCopied(true);
    setTimeout(() => setUrlCopied(false), 1500);
  };

  const toggle = async (next: boolean) => {
    setBusy(true);
    setEnabled(next);
    setToggleError("");
    try {
      const i = await invoke<OverlayConnectionInfo>("overlay_set_enabled", {
        enabled: next,
      });
      setInfo(i);
      setEnabled(i.enabled);
    } catch (e) {
      console.error("overlay_set_enabled failed:", e);
      setEnabled(!next);
      setToggleError(safeErrorMessage(e, "Failed to update overlay server"));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const applyPort = async () => {
    const p = parseInt(portInput, 10);
    if (isNaN(p) || p < 1024 || p > 65535) {
      setPortError("Port must be between 1024 and 65535");
      return;
    }
    setPortError("");
    setBusy(true);
    try {
      const i = await invoke<OverlayConnectionInfo>("overlay_set_port", { port: p });
      setInfo(i);
      setPortInput(String(i.port ?? p));
    } catch (e) {
      console.error("overlay_set_port failed:", e);
      setPortError(safeErrorMessage(e, "Failed to apply port"));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const applyHost = async () => {
    const h = hostInput.trim();
    if (!h) {
      setHostError("Host cannot be empty");
      return;
    }
    setHostError("");
    setBusy(true);
    try {
      const i = await invoke<OverlayConnectionInfo>("overlay_set_host", { host: h });
      setInfo(i);
      setHostInput(i.host);
    } catch (e) {
      console.error("overlay_set_host failed:", e);
      setHostError(safeErrorMessage(e, "Invalid host address"));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mb-1">
        OBS Overlay
      </p>
      <div className="border-b border-th-border-subtle">
        <SettingRow
          title="Browser source overlay"
          subtitle="Expose a local page for OBS/Streamlabs — add it as a Browser Source"
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

      <div className="px-4 pb-4 pt-4 border-t border-th-border-subtle">
        {/* Status banner */}
        {(() => {
          const errored = enabled && !info.url;
          const surface = errored
            ? "bg-[#ff6666]/10 border-[#ff6666]/25"
            : enabled
              ? "bg-th-accent/10 border-th-accent/20"
              : "bg-th-inset border-th-border-subtle";
          const dotGlow = errored
            ? "0 0 0 3px rgba(255,102,102,0.2)"
            : enabled
              ? "0 0 0 3px color-mix(in srgb, var(--th-accent) 20%, transparent)"
              : undefined;
          return (
            <div
              className={`flex items-center gap-2.5 px-[13px] py-[11px] rounded-[11px] border mb-4 transition-colors ${surface}`}
            >
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 transition-[background,box-shadow] ${
                  errored
                    ? "bg-[#ff6666]"
                    : enabled
                      ? "bg-th-accent"
                      : "bg-th-text-faint"
                }`}
                style={dotGlow ? { boxShadow: dotGlow } : undefined}
              />
              <span className="font-mono text-[12px] text-th-text-secondary min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                {info.host ?? "127.0.0.1"}:{info.port ?? 5578}/overlay
              </span>
              <span
                className={`ml-auto text-[11px] font-semibold flex-shrink-0 ${
                  errored
                    ? "text-[#ff6666]"
                    : enabled
                      ? "text-th-accent"
                      : "text-th-text-muted"
                }`}
              >
                {errored ? "Server error" : enabled ? "Running" : "Stopped"}
              </span>
            </div>
          );
        })()}

        {toggleError && (
          <p className="text-[11px] text-[#ff6666] mb-4">{toggleError}</p>
        )}

        {enabled && info.url ? (
          <>
            {/* URL row */}
            <span className="block text-[10px] font-bold tracking-[0.9px] uppercase text-th-text-faint mb-[7px]">
              Browser source URL
            </span>
            <div className="rounded-[11px] border border-th-border-subtle bg-th-inset px-[13px] py-0.5 mb-4">
              <div className="flex items-center gap-3 py-2.5">
                <span className="flex-1 min-w-0 font-mono text-[12px] text-th-text-primary overflow-hidden text-ellipsis whitespace-nowrap">
                  {info.url}
                </span>
                <button
                  onClick={() => copy(info.url!)}
                  className="px-2.5 py-1.5 text-[12px] border border-th-border-subtle rounded-md text-th-text-secondary hover:text-th-text-primary hover:border-th-accent/50 transition-colors flex-shrink-0"
                >
                  {urlCopied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>

            {/* Instructions */}
            <div className="rounded-[11px] border border-th-border-subtle bg-th-inset px-[13px] py-3 mb-4">
              <p className="text-[11.5px] text-th-text-secondary leading-relaxed">
                In OBS: <span className="text-th-text-primary font-medium">Sources → + → Browser</span>
                <br />
                Paste the URL above and set the size to{" "}
                <span className="font-mono text-th-text-primary font-medium">400 × 120</span>.
              </p>
            </div>
          </>
        ) : (
          <p className="text-[11px] text-th-text-muted pt-3 mb-4">
            {enabled
              ? "Couldn't start the server — try toggling it off and on."
              : "Enable the overlay to get a URL for OBS."}
          </p>
        )}

        {/* Network interface (host) */}
        <span className="block text-[10px] font-bold tracking-[0.9px] uppercase text-th-text-faint mb-[7px]">
          Network interface
        </span>
        <div className="flex items-center gap-2 mb-1">
          <input
            type="text"
            value={hostInput}
            placeholder="127.0.0.1"
            onChange={(e) => setHostInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyHost()}
            className="flex-1 bg-th-inset border border-th-border-subtle rounded-md px-3 py-1.5 text-[12px] font-mono text-th-text-primary focus:outline-none focus:border-th-accent/50"
          />
          <button
            onClick={applyHost}
            disabled={busy}
            className="px-3 py-1.5 text-[12px] border border-th-border-subtle rounded-md text-th-text-secondary hover:text-th-text-primary hover:border-th-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Apply
          </button>
        </div>
        {hostError && (
          <p className="text-[11px] text-[#ff6666] mt-1">{hostError}</p>
        )}
        <p className="text-[11px] text-th-text-muted mt-1 mb-4">
          <span className="font-mono text-th-text-secondary">127.0.0.1</span> = local only &nbsp;·&nbsp;
          <span className="font-mono text-th-text-secondary">0.0.0.0</span> = all interfaces (accessible on LAN)
        </p>

        {/* Port config */}
        <span className="block text-[10px] font-bold tracking-[0.9px] uppercase text-th-text-faint mb-[7px]">
          Port
        </span>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1024}
            max={65535}
            value={portInput}
            onChange={(e) => setPortInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyPort()}
            className="w-[110px] bg-th-inset border border-th-border-subtle rounded-md px-3 py-1.5 text-[12px] font-mono text-th-text-primary focus:outline-none focus:border-th-accent/50"
          />
          <button
            onClick={applyPort}
            disabled={busy}
            className="px-3 py-1.5 text-[12px] border border-th-border-subtle rounded-md text-th-text-secondary hover:text-th-text-primary hover:border-th-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Apply
          </button>
        </div>
        {portError && (
          <p className="text-[11px] text-[#ff6666] mt-1.5">{portError}</p>
        )}
        <p className="text-[11px] text-th-text-muted mt-2">
          Default: 5578. Changing the port restarts the server.
        </p>
      </div>
    </div>
  );
}
