import {
  LogOut,
  Palette,
  User,
  Keyboard,
  X,
  Headphones,
  Shield,
  ChevronDown,
  Settings,
  Radio,
} from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAtom } from "jotai";
import { useAuth } from "../hooks/useAuth";
import {
  exclusiveModeAtom,
  bitPerfectAtom,
  exclusiveDeviceAtom,
} from "../atoms/playback";
import { useToast } from "../contexts/ToastContext";
import ThemeEditor from "./ThemeEditor";
import SettingsModal from "./SettingsModal";
import ScrobbleModal from "./ScrobbleModal";

const SHORTCUTS = [
  { keys: "Space", desc: "Play / Pause" },
  { keys: "Ctrl + →", desc: "Next track" },
  { keys: "Ctrl + ←", desc: "Previous track" },
  { keys: "↑", desc: "Volume up" },
  { keys: "↓", desc: "Volume down" },
  { keys: "M", desc: "Mute / Unmute" },
  { keys: "L", desc: "Like / Unlike current track" },
  { keys: "Ctrl + S", desc: "Focus search bar" },
  { keys: "Ctrl + R", desc: "Refresh app data" },
  { keys: "Esc", desc: "Close now-playing drawer" },
  { keys: "Ctrl + +", desc: "Zoom in" },
  { keys: "Ctrl + -", desc: "Zoom out" },
  { keys: "Ctrl + 0", desc: "Reset zoom to 100%" },
  { keys: "?", desc: "Show keyboard shortcuts" },
] as const;

export default function UserMenu() {
  const { userName, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scrobbleOpen, setScrobbleOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [exclusiveMode, setExclusiveMode] = useAtom(exclusiveModeAtom);
  const [bitPerfect, setBitPerfect] = useAtom(bitPerfectAtom);
  const [exclusiveDevice, setExclusiveDevice] = useAtom(exclusiveDeviceAtom);
  const [audioDevices, setAudioDevices] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [deviceDropdownOpen, setDeviceDropdownOpen] = useState(false);
  const { showToast } = useToast();
  const menuRef = useRef<HTMLDivElement>(null);

  // Toggle shortcuts modal from ? key
  useEffect(() => {
    const handler = () => setShortcutsOpen((prev) => !prev);
    window.addEventListener("toggle-shortcuts", handler);
    return () => window.removeEventListener("toggle-shortcuts", handler);
  }, []);

  // Load audio devices when exclusive mode is enabled
  useEffect(() => {
    if (exclusiveMode) {
      invoke<Array<{ id: string; name: string }>>("list_audio_devices")
        .then((devices) => {
          setAudioDevices(devices);
          if (!exclusiveDevice && devices.length > 0) {
            setExclusiveDevice(devices[0].id);
            invoke("set_exclusive_device", { device: devices[0].id }).catch(
              () => {},
            );
          }
        })
        .catch(() => {});
    }
  }, [exclusiveMode]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
        setDeviceDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close dropdown on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setDeviceDropdownOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  // Reusable toggle for dropdown items
  const Toggle = ({ on }: { on: boolean }) => (
    <div
      className={`w-8 h-[18px] rounded-full transition-colors ${
        on ? "bg-th-accent" : "bg-th-border-subtle"
      }`}
    >
      <div
        className={`w-3.5 h-3.5 rounded-full bg-th-text-primary mt-[2px] transition-transform ${
          on ? "translate-x-[16px]" : "translate-x-[2px]"
        }`}
      />
    </div>
  );

  const menuItemClass =
    "w-full flex items-center gap-3 px-4 py-2.5 text-[13px] text-th-text-secondary hover:text-th-text-primary hover:bg-th-border-subtle transition-colors";

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="w-8 h-8 rounded-full bg-th-button hover:bg-th-button-hover flex items-center justify-center transition-colors"
        title="Account"
      >
        <User size={16} className="text-th-text-secondary" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-th-surface rounded-lg shadow-2xl shadow-black/60 border border-th-border-subtle z-50 py-1 animate-fadeIn">
          {/* User info */}
          <div className="px-4 py-3 border-b border-th-border-subtle">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-th-button flex items-center justify-center shrink-0">
                <User size={16} className="text-th-text-muted" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-th-text-primary truncate">
                  {userName}
                </p>
              </div>
            </div>
          </div>

          {/* ── Exclusive output group ── */}

          {/* Exclusive output */}
          <button
            onClick={() => {
              const next = !exclusiveMode;
              setExclusiveMode(next);
              if (!next) {
                setBitPerfect(false);
              }
              invoke("set_exclusive_mode", { enabled: next }).catch(() => {});
              showToast(
                next
                  ? "Exclusive output on — takes effect next track"
                  : "Exclusive output off — takes effect next track",
              );
            }}
            className={menuItemClass}
          >
            <Headphones size={16} />
            <span className="flex-1 text-left">Exclusive output</span>
            <Toggle on={exclusiveMode} />
          </button>

          {/* Device selector (visible when exclusive on) */}
          {exclusiveMode && audioDevices.length > 0 && (
            <div className="px-4 py-1 relative">
              <div className="ml-7">
                <button
                  onClick={() => setDeviceDropdownOpen((p) => !p)}
                  className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md bg-th-inset border border-th-border-subtle text-[12px] text-th-text-secondary hover:border-th-accent/50 transition-colors"
                >
                  <span className="truncate">
                    {audioDevices.find((d) => d.id === exclusiveDevice)?.name ||
                      "Select device"}
                  </span>
                  <ChevronDown
                    size={12}
                    className={`shrink-0 transition-transform ${deviceDropdownOpen ? "rotate-180" : ""}`}
                  />
                </button>
                {deviceDropdownOpen && (
                  <div className="absolute left-4 right-4 ml-7 mt-1 bg-th-elevated border border-th-border-subtle rounded-md shadow-xl z-10 py-1 max-h-[160px] overflow-y-auto">
                    {audioDevices.map((d) => (
                      <button
                        key={d.id}
                        onClick={() => {
                          setExclusiveDevice(d.id);
                          invoke("set_exclusive_device", {
                            device: d.id,
                          }).catch(() => {});
                          setDeviceDropdownOpen(false);
                        }}
                        className={`w-full text-left px-2.5 py-1.5 text-[12px] transition-colors ${
                          exclusiveDevice === d.id
                            ? "text-th-accent bg-th-accent/10"
                            : "text-th-text-secondary hover:bg-th-border-subtle"
                        }`}
                      >
                        {d.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Bit-perfect mode (visible when exclusive on) */}
          {exclusiveMode && (
            <button
              onClick={() => {
                const next = !bitPerfect;
                setBitPerfect(next);
                invoke("set_bit_perfect", { enabled: next }).catch(() => {});
                showToast(
                  next
                    ? "Bit-perfect on — takes effect next track"
                    : "Bit-perfect off — takes effect next track",
                );
              }}
              className={menuItemClass}
            >
              <Shield size={16} />
              <span className="flex-1 text-left">Bit-perfect</span>
              <Toggle on={bitPerfect} />
            </button>
          )}

          {/* ── Scrobbling ── */}
          <div className="border-t border-th-border-subtle my-1" />

          <button
            onClick={() => {
              setOpen(false);
              setScrobbleOpen(true);
            }}
            className={menuItemClass}
          >
            <Radio size={16} />
            Scrobbling
          </button>

          {/* ── Theme + Settings ── */}
          <div className="border-t border-th-border-subtle my-1" />

          <button
            onClick={() => {
              setOpen(false);
              setThemeOpen(true);
            }}
            className={menuItemClass}
          >
            <Palette size={16} />
            Theme
          </button>

          <button
            onClick={() => {
              setOpen(false);
              setSettingsOpen(true);
            }}
            className={menuItemClass}
          >
            <Settings size={16} />
            Settings
          </button>

          {/* ── Shortcuts ── */}
          <div className="border-t border-th-border-subtle my-1" />

          <button
            onClick={() => {
              setOpen(false);
              setShortcutsOpen(true);
            }}
            className={menuItemClass}
          >
            <Keyboard size={16} />
            Shortcuts
          </button>

          {/* ── Logout ── */}
          <div className="border-t border-th-border-subtle my-1" />
          <button
            onClick={() => {
              setOpen(false);
              logout();
            }}
            className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] text-red-400 hover:bg-th-border-subtle transition-colors"
          >
            <LogOut size={16} />
            Log out
          </button>
        </div>
      )}

      <ThemeEditor open={themeOpen} onClose={() => setThemeOpen(false)} />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <ScrobbleModal
        open={scrobbleOpen}
        onClose={() => setScrobbleOpen(false)}
      />

      {/* Shortcuts modal */}
      {shortcutsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShortcutsOpen(false)}
        >
          <div
            className="bg-th-elevated rounded-xl shadow-2xl w-[420px] max-h-[80vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: "slideUp 0.2s ease-out" }}
          >
            <div className="flex items-center justify-between px-5 pt-5 pb-3">
              <h2 className="text-[16px] font-bold text-th-text-primary">
                Keyboard Shortcuts
              </h2>
              <button
                onClick={() => setShortcutsOpen(false)}
                className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-th-inset transition-colors text-th-text-muted hover:text-th-text-primary"
              >
                <X size={18} />
              </button>
            </div>
            <div className="px-5 pb-5 flex flex-col gap-1">
              {SHORTCUTS.map((s) => (
                <div
                  key={s.keys}
                  className="flex items-center justify-between py-2 px-1"
                >
                  <span className="text-[13px] text-th-text-secondary">
                    {s.desc}
                  </span>
                  <kbd className="text-[12px] font-mono text-th-text-muted bg-th-surface px-2.5 py-1 rounded-md border border-th-border-subtle">
                    {s.keys}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
