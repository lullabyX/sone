import { useEffect, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Plus, RefreshCw, X } from "lucide-react";
import {
  sonosDiscoveringAtom,
  sonosEnabledAtom,
  sonosGroupsAtom,
} from "../../atoms/sonos";
import { useSonosActions } from "../../hooks/useSonosActions";
import Toggle from "../Toggle";
import SettingRow from "./SettingRow";

export default function SonosTab() {
  const [enabled, setEnabled] = useAtom(sonosEnabledAtom);
  const groups = useAtomValue(sonosGroupsAtom);
  const discovering = useAtomValue(sonosDiscoveringAtom);
  const { discover, addManualIp, removeManualIp } = useSonosActions();

  const [manualIps, setManualIps] = useState<string[]>([]);
  const [ipDraft, setIpDraft] = useState("");
  const [addBusy, setAddBusy] = useState(false);

  const refreshManualIps = () => {
    invoke<string[]>("sonos_get_manual_ips")
      .then(setManualIps)
      .catch(() => {});
  };

  useEffect(() => {
    refreshManualIps();
    if (enabled) void discover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitIp = async () => {
    const ip = ipDraft.trim();
    if (!ip || addBusy) return;
    setAddBusy(true);
    const ok = await addManualIp(ip);
    setAddBusy(false);
    if (ok) {
      setIpDraft("");
      refreshManualIps();
    }
  };

  const removeIp = async (ip: string) => {
    await removeManualIp(ip);
    refreshManualIps();
  };

  return (
    <div>
      <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mb-1">
        Sonos
      </p>
      <div className="border-b border-th-border-subtle">
        <SettingRow
          title="Play on Sonos"
          subtitle="Show the output picker in the player bar. Speakers stream directly from TIDAL using the account linked in the Sonos app — audio never routes through this computer."
        >
          <button onClick={() => setEnabled(!enabled)}>
            <Toggle on={enabled} />
          </button>
        </SettingRow>
      </div>

      {enabled && (
        <>
          <div className="flex items-center justify-between mt-6 mb-1">
            <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint">
              Speakers
            </p>
            <button
              onClick={() => void discover()}
              disabled={discovering}
              className="flex items-center gap-1.5 text-[11.5px] text-th-text-secondary hover:text-th-text-primary transition-colors duration-150 disabled:opacity-45"
            >
              {discovering ? (
                <Loader2 size={12} strokeWidth={2} className="animate-spin" />
              ) : (
                <RefreshCw size={12} strokeWidth={2} />
              )}
              Rescan
            </button>
          </div>
          <div className="border-b border-th-border-subtle">
            {groups.length === 0 && !discovering && (
              <p className="px-4 py-3 text-[11.5px] text-th-text-muted">
                No speakers found yet. Discovery tries multicast first, then a
                local-network sweep. On networks that block both (VLANs, strict
                sandboxes), add a speaker by IP below — any single reachable
                speaker reveals the whole system.
              </p>
            )}
            {groups.map((group) => (
              <SettingRow
                key={group.coordinatorUuid}
                title={group.name}
                subtitle={`${group.members.map((m) => m.name).join(" + ")} · ${group.coordinatorIp}${
                  group.tidalLinked === false
                    ? " · TIDAL not linked in the Sonos app"
                    : ""
                }`}
              />
            ))}
          </div>

          <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mt-6 mb-1">
            Manual speakers
          </p>
          <div className="border-b border-th-border-subtle">
            {manualIps.map((ip) => (
              <SettingRow key={ip} title={ip}>
                <button
                  onClick={() => void removeIp(ip)}
                  className="text-th-text-faint hover:text-th-text-primary transition-colors duration-150"
                  title="Remove"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </SettingRow>
            ))}
            <div className="flex items-center gap-2 px-4 py-3">
              <input
                value={ipDraft}
                onChange={(e) => setIpDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitIp();
                }}
                placeholder="Speaker IP address, e.g. 192.168.1.50"
                className="flex-1 min-w-0 bg-th-base border border-th-border-subtle rounded-md px-2.5 py-1.5 text-[12.5px] text-th-text-primary placeholder:text-th-text-faint outline-none focus:border-th-accent"
              />
              <button
                onClick={() => void submitIp()}
                disabled={!ipDraft.trim() || addBusy}
                className="flex items-center gap-1 text-[11.5px] text-th-text-secondary hover:text-th-text-primary transition-colors duration-150 disabled:opacity-45"
              >
                {addBusy ? (
                  <Loader2 size={12} strokeWidth={2} className="animate-spin" />
                ) : (
                  <Plus size={12} strokeWidth={2} />
                )}
                Add
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
