/**
 * OutputPicker — Spotify Connect-style output selector in the player bar.
 * Lists "This computer" plus discovered Sonos groups; selecting a room hands
 * playback to the speaker (which streams natively from TIDAL). While casting
 * the button shows an accent room-name chip.
 */

import { memo, useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import {
  Check,
  Laptop2,
  Loader2,
  Plus,
  RefreshCw,
  Speaker,
} from "lucide-react";
import { playbackTargetAtom } from "../atoms/playback";
import {
  sonosCastStateAtom,
  sonosDiscoveringAtom,
  sonosEnabledAtom,
  sonosGroupsAtom,
  type SonosGroupInfo,
} from "../atoms/sonos";
import { useSonosActions } from "../hooks/useSonosActions";

const rowClass =
  "w-full flex items-center gap-2.5 px-3 py-2 text-left rounded-md transition-colors duration-100 hover:bg-th-border-subtle disabled:opacity-45 disabled:hover:bg-transparent";

const OutputPicker = memo(function OutputPicker() {
  const enabled = useAtomValue(sonosEnabledAtom);
  const target = useAtomValue(playbackTargetAtom);
  const groups = useAtomValue(sonosGroupsAtom);
  const discovering = useAtomValue(sonosDiscoveringAtom);
  const castState = useAtomValue(sonosCastStateAtom);
  const { discover, castToGroup, switchToLocal, addManualIp } =
    useSonosActions();

  const [open, setOpen] = useState(false);
  const [ipDraft, setIpDraft] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Scan when the popover opens (results replace the cached list).
  useEffect(() => {
    if (open) void discover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Close on click outside / Escape (UserMenu popover pattern).
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!enabled) return null;

  const casting = target.type === "sonos";
  const connecting = castState === "connecting";

  const selectGroup = async (group: SonosGroupInfo) => {
    setOpen(false);
    await castToGroup(group);
  };

  const selectLocal = async () => {
    setOpen(false);
    await switchToLocal();
  };

  const submitIp = async () => {
    const ip = ipDraft.trim();
    if (!ip || addBusy) return;
    setAddBusy(true);
    const ok = await addManualIp(ip);
    setAddBusy(false);
    if (ok) setIpDraft("");
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 transition-colors duration-150 ${
          casting
            ? "text-th-accent"
            : "text-th-text-faint hover:text-th-text-primary"
        }`}
        title={
          casting && target.type === "sonos"
            ? `Playing on ${target.roomName}`
            : "Play on Sonos"
        }
      >
        {connecting ? (
          <Loader2 size={16} strokeWidth={2} className="animate-spin" />
        ) : (
          <Speaker size={16} strokeWidth={2} />
        )}
        {casting && target.type === "sonos" && (
          <span className="text-[11px] font-medium max-w-[90px] truncate">
            {target.roomName}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-3 w-[280px] bg-th-elevated border border-th-border-subtle rounded-xl shadow-2xl p-2 z-50">
          <div className="flex items-center justify-between px-3 pt-1.5 pb-2">
            <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint">
              Play on
            </p>
            <button
              onClick={() => void discover()}
              className="text-th-text-faint hover:text-th-text-primary transition-colors duration-150"
              title="Scan again"
              disabled={discovering}
            >
              {discovering ? (
                <Loader2 size={13} strokeWidth={2} className="animate-spin" />
              ) : (
                <RefreshCw size={13} strokeWidth={2} />
              )}
            </button>
          </div>

          <button onClick={() => void selectLocal()} className={rowClass}>
            <Laptop2
              size={16}
              strokeWidth={2}
              className="text-th-text-secondary flex-shrink-0"
            />
            <span className="flex-1 text-[13px] font-medium text-th-text-primary">
              This computer
            </span>
            {!casting && (
              <Check size={14} strokeWidth={2.5} className="text-th-accent" />
            )}
          </button>

          {groups.map((group) => {
            const active =
              target.type === "sonos" &&
              target.coordinatorUuid === group.coordinatorUuid;
            const tidalMissing = group.tidalLinked === false;
            const memberNames = group.members.map((m) => m.name).join(" + ");
            return (
              <button
                key={group.coordinatorUuid}
                onClick={() => void selectGroup(group)}
                disabled={tidalMissing}
                className={rowClass}
                title={
                  tidalMissing ? "Link TIDAL in the Sonos app first" : undefined
                }
              >
                <Speaker
                  size={16}
                  strokeWidth={2}
                  className="text-th-text-secondary flex-shrink-0"
                />
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] font-medium text-th-text-primary truncate">
                    {group.name}
                  </span>
                  {(group.members.length > 1 || tidalMissing) && (
                    <span className="block text-[11px] text-th-text-muted truncate">
                      {tidalMissing
                        ? "Link TIDAL in the Sonos app first"
                        : memberNames}
                    </span>
                  )}
                </span>
                {active && (
                  <Check
                    size={14}
                    strokeWidth={2.5}
                    className="text-th-accent"
                  />
                )}
              </button>
            );
          })}

          {!discovering && groups.length === 0 && (
            <p className="px-3 py-2 text-[11.5px] text-th-text-muted">
              No Sonos speakers found. If your network blocks discovery, add a
              speaker by IP below.
            </p>
          )}

          <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 border-t border-th-border-subtle mt-1.5">
            <input
              value={ipDraft}
              onChange={(e) => setIpDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitIp();
              }}
              placeholder="Add speaker by IP…"
              className="flex-1 min-w-0 bg-transparent text-[12px] text-th-text-primary placeholder:text-th-text-faint outline-none py-1"
            />
            <button
              onClick={() => void submitIp()}
              disabled={!ipDraft.trim() || addBusy}
              className="text-th-text-faint hover:text-th-text-primary disabled:opacity-45 transition-colors duration-150"
              title="Add speaker"
            >
              {addBusy ? (
                <Loader2 size={14} strokeWidth={2} className="animate-spin" />
              ) : (
                <Plus size={14} strokeWidth={2} />
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

export default OutputPicker;
