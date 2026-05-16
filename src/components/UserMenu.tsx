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
  Info,
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
import {
  ACTION_REGISTRY,
  DEFAULT_BINDINGS,
  shortcutsAtom,
  formatCombo,
  keyFromEvent,
  comboEquals,
  isReserved,
  type ActionId,
  type KeyCombo,
} from "../lib/shortcuts";
import ThemeEditor from "./ThemeEditor";
import SettingsModal from "./SettingsModal";
import ScrobbleModal from "./ScrobbleModal";
import AboutModal from "./AboutModal";
import Toggle from "./Toggle";

export default function UserMenu() {
  const { userName, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scrobbleOpen, setScrobbleOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [bindings, setBindings] = useAtom(shortcutsAtom);
  const [editingId, setEditingId] = useState<ActionId | null>(null);
  const [reservedHint, setReservedHint] = useState(false);
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

  // Capture next keydown while editing a shortcut row
  useEffect(() => {
    if (!editingId) return;

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.code === "Escape") {
        setEditingId(null);
        setReservedHint(false);
        return;
      }

      const combo = keyFromEvent(e);
      if (!combo) return; // pure modifier — keep capturing

      if (isReserved(combo)) {
        setReservedHint(true);
        return;
      }

      const next: Record<ActionId, KeyCombo | null> = { ...bindings };
      for (const id of Object.keys(next) as ActionId[]) {
        if (id !== editingId && comboEquals(next[id], combo)) {
          next[id] = null;
        }
      }
      next[editingId] = combo;
      setBindings(next);
      setEditingId(null);
      setReservedHint(false);
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [editingId, bindings, setBindings]);

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

          {/* ── About ── */}
          <div className="border-t border-th-border-subtle my-1" />

          <button
            onClick={() => {
              setOpen(false);
              setAboutOpen(true);
            }}
            className={menuItemClass}
          >
            <Info size={16} />
            About
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
      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />

      {/* Shortcuts modal */}
      {shortcutsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => {
            setShortcutsOpen(false);
            setEditingId(null);
            setReservedHint(false);
          }}
        >
          <div
            className="bg-th-elevated rounded-xl shadow-2xl w-[460px] max-h-[80vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: "slideUp 0.2s ease-out" }}
          >
            <div className="flex items-center justify-between px-5 pt-5 pb-3">
              <h2 className="text-[16px] font-bold text-th-text-primary">
                Keyboard Shortcuts
              </h2>
              <button
                onClick={() => {
                  setShortcutsOpen(false);
                  setEditingId(null);
                  setReservedHint(false);
                }}
                className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-th-inset transition-colors text-th-text-muted hover:text-th-text-primary"
              >
                <X size={18} />
              </button>
            </div>
            <div className="px-5 pb-3 flex flex-col gap-0.5 overflow-y-auto min-h-0">
              {ACTION_REGISTRY.map((action) => {
                const isEditing = editingId === action.id;
                const binding = bindings[action.id];
                return (
                  <div
                    key={action.id}
                    onDoubleClick={() => {
                      setReservedHint(false);
                      setEditingId(action.id);
                    }}
                    className="flex items-center justify-between py-2 px-2 rounded hover:bg-th-inset cursor-pointer select-none"
                  >
                    <span className="text-[13px] text-th-text-secondary">
                      {action.label}
                    </span>
                    <kbd
                      className={`text-[12px] font-mono px-2.5 py-1 rounded-md border transition-colors ${
                        isEditing
                          ? reservedHint
                            ? "bg-red-500/10 text-red-400 border-red-500/40"
                            : "bg-th-accent/10 text-th-accent border-th-accent/60 animate-pulse"
                          : "bg-th-surface text-th-text-muted border-th-border-subtle"
                      }`}
                    >
                      {isEditing
                        ? reservedHint
                          ? "Reserved — pick another"
                          : "Press a key…"
                        : formatCombo(binding)}
                    </kbd>
                  </div>
                );
              })}
            </div>
            <div className="border-t border-th-border-subtle px-5 py-3 flex justify-between items-center">
              <span className="text-[11px] text-th-text-muted">
                Double-click to edit · Esc to cancel
              </span>
              <button
                onClick={() => {
                  setBindings(DEFAULT_BINDINGS);
                  setEditingId(null);
                  setReservedHint(false);
                }}
                className="text-[12px] px-3 py-1.5 rounded-md bg-th-surface hover:bg-th-border-subtle text-th-text-secondary transition-colors"
              >
                Restore defaults
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
