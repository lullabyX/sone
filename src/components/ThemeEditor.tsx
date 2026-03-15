import { useState, useRef, useEffect, useCallback } from "react";
import { useAtom } from "jotai";
import { themeAtom } from "../atoms/theme";
import { PRESET_THEMES, deriveTheme, type Theme } from "../lib/theme";
import { X, Check, RotateCcw, Palette } from "lucide-react";

interface ThemeEditorProps {
  open: boolean;
  onClose: () => void;
}

export default function ThemeEditor({ open, onClose }: ThemeEditorProps) {
  const [theme, setTheme] = useAtom(themeAtom);
  const [localAccent, setLocalAccent] = useState(theme.accent);
  const [localBg, setLocalBg] = useState(theme.bgBase);
  const [activePreset, setActivePreset] = useState<string | null>(
    PRESET_THEMES.find(
      (p) => p.accent === theme.accent && p.bgBase === theme.bgBase,
    )?.name ?? null,
  );
  const panelRef = useRef<HTMLDivElement>(null);

  // Sync local state when theme atom changes externally
  useEffect(() => {
    setLocalAccent(theme.accent);
    setLocalBg(theme.bgBase);
    setActivePreset(
      PRESET_THEMES.find(
        (p) => p.accent === theme.accent && p.bgBase === theme.bgBase,
      )?.name ?? null,
    );
  }, [theme]);

  // Apply live preview as user edits
  const applyPreview = useCallback(
    (accent: string, bgBase: string) => {
      setTheme({ name: "Custom", accent, bgBase });
    },
    [setTheme],
  );

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

  if (!open) return null;

  const handlePresetClick = (preset: Theme) => {
    setLocalAccent(preset.accent);
    setLocalBg(preset.bgBase);
    setActivePreset(preset.name);
    setTheme(preset);
  };

  const handleAccentChange = (hex: string) => {
    setLocalAccent(hex);
    setActivePreset(null);
    applyPreview(hex, localBg);
  };

  const handleBgChange = (hex: string) => {
    setLocalBg(hex);
    setActivePreset(null);
    applyPreview(localAccent, hex);
  };

  const handleReset = () => {
    const defaultTheme = PRESET_THEMES[0];
    setLocalAccent(defaultTheme.accent);
    setLocalBg(defaultTheme.bgBase);
    setActivePreset(defaultTheme.name);
    setTheme(defaultTheme);
  };

  const derived = deriveTheme(localAccent, localBg);

  return (
    <div className="fixed inset-0 z-9999 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fadeIn overflow-y-auto py-4">
      <div
        ref={panelRef}
        className="w-[440px] max-h-full bg-th-surface rounded-2xl shadow-2xl shadow-black/60 border border-th-border-subtle overflow-hidden flex flex-col animate-fadeIn my-auto shrink-0"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-th-border-subtle">
          <div className="flex items-center gap-2.5">
            <Palette size={18} className="text-th-accent" />
            <h2 className="text-[16px] font-bold text-th-text-primary">
              Theme
            </h2>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-th-text-muted hover:text-th-text-primary hover:bg-th-border-subtle transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Presets */}
          <section>
            <h3 className="text-[12px] font-bold text-th-text-muted uppercase tracking-wider mb-3">
              Presets
            </h3>
            <div className="grid grid-cols-3 gap-2">
              {PRESET_THEMES.map((preset) => {
                const isActive = activePreset === preset.name;
                const presetDerived = deriveTheme(preset.accent, preset.bgBase);
                return (
                  <button
                    key={preset.name}
                    onClick={() => handlePresetClick(preset)}
                    className={`relative flex flex-col items-center gap-2 p-3 rounded-xl border transition-all duration-150 ${
                      isActive
                        ? "border-th-accent bg-th-accent/10"
                        : "border-th-border-subtle hover:border-th-text-faint bg-th-base"
                    }`}
                  >
                    {/* Color swatch */}
                    <div className="flex items-center gap-1">
                      <div
                        className="w-5 h-5 rounded-full border border-th-border-subtle"
                        style={{ backgroundColor: preset.accent }}
                      />
                      <div
                        className="w-5 h-5 rounded-full border border-th-border-subtle"
                        style={{ backgroundColor: presetDerived.bgSurface }}
                      />
                    </div>
                    <span className="text-[11px] font-medium text-th-text-secondary leading-tight text-center">
                      {preset.name}
                    </span>
                    {isActive && (
                      <div className="absolute top-1.5 right-1.5">
                        <Check size={12} className="text-th-accent" />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Custom colors */}
          <section>
            <h3 className="text-[12px] font-bold text-th-text-muted uppercase tracking-wider mb-3">
              Custom
            </h3>
            <div className="space-y-3">
              {/* Accent */}
              <div className="flex items-center gap-3">
                <label className="text-[13px] text-th-text-secondary w-24 shrink-0">
                  Accent
                </label>
                <div className="flex items-center gap-2 flex-1">
                  <div className="relative">
                    <input
                      type="color"
                      value={localAccent}
                      onChange={(e) => handleAccentChange(e.target.value)}
                      className="w-9 h-9 rounded-lg cursor-pointer border border-th-border-subtle bg-transparent appearance-none [&::-webkit-color-swatch-wrapper]:p-0.5 [&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch]:border-none"
                    />
                  </div>
                  <input
                    type="text"
                    value={localAccent}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (/^#[0-9A-Fa-f]{0,6}$/.test(v)) {
                        setLocalAccent(v);
                        if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
                          setActivePreset(null);
                          applyPreview(v, localBg);
                        }
                      }
                    }}
                    className="flex-1 px-3 py-1.5 text-[13px] font-mono bg-th-inset border border-th-border-subtle rounded-lg text-th-text-primary focus:outline-none focus:border-th-accent transition-colors"
                    maxLength={7}
                    spellCheck={false}
                  />
                </div>
              </div>

              {/* Background */}
              <div className="flex items-center gap-3">
                <label className="text-[13px] text-th-text-secondary w-24 shrink-0">
                  Background
                </label>
                <div className="flex items-center gap-2 flex-1">
                  <div className="relative">
                    <input
                      type="color"
                      value={localBg}
                      onChange={(e) => handleBgChange(e.target.value)}
                      className="w-9 h-9 rounded-lg cursor-pointer border border-th-border-subtle bg-transparent appearance-none [&::-webkit-color-swatch-wrapper]:p-0.5 [&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch]:border-none"
                    />
                  </div>
                  <input
                    type="text"
                    value={localBg}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (/^#[0-9A-Fa-f]{0,6}$/.test(v)) {
                        setLocalBg(v);
                        if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
                          setActivePreset(null);
                          applyPreview(localAccent, v);
                        }
                      }
                    }}
                    className="flex-1 px-3 py-1.5 text-[13px] font-mono bg-th-inset border border-th-border-subtle rounded-lg text-th-text-primary focus:outline-none focus:border-th-accent transition-colors"
                    maxLength={7}
                    spellCheck={false}
                  />
                </div>
              </div>
            </div>
          </section>

          {/* Live preview */}
          <section>
            <h3 className="text-[12px] font-bold text-th-text-muted uppercase tracking-wider mb-3">
              Preview
            </h3>
            <div
              className="rounded-xl border border-th-border-subtle overflow-hidden"
              style={{ backgroundColor: derived.bgBase }}
            >
              {/* Mini sidebar + content mockup */}
              <div className="flex h-[120px]">
                {/* Mini sidebar */}
                <div
                  className="w-12 flex flex-col items-center gap-2 py-3 border-r border-th-border-subtle"
                  style={{ backgroundColor: derived.bgSidebar }}
                >
                  <div
                    className="w-6 h-6 rounded"
                    style={{ backgroundColor: derived.bgSurfaceHover }}
                  />
                  <div
                    className="w-6 h-1 rounded-full"
                    style={{ backgroundColor: derived.accent }}
                  />
                  <div
                    className="w-6 h-6 rounded"
                    style={{ backgroundColor: derived.bgSurfaceHover }}
                  />
                </div>
                {/* Mini content */}
                <div className="flex-1 p-3 flex flex-col gap-2">
                  <div className="flex gap-2">
                    <div
                      className="w-10 h-10 rounded"
                      style={{ backgroundColor: derived.bgSurfaceHover }}
                    />
                    <div className="flex flex-col gap-1 justify-center">
                      <div
                        className="w-20 h-2 rounded"
                        style={{
                          backgroundColor: derived.textPrimary,
                          opacity: 0.8,
                        }}
                      />
                      <div
                        className="w-14 h-1.5 rounded"
                        style={{ backgroundColor: derived.textMuted }}
                      />
                    </div>
                  </div>
                  <div className="flex gap-1.5 mt-auto">
                    <div
                      className="px-2.5 py-1 rounded-full text-[9px] font-bold"
                      style={{
                        backgroundColor: derived.accent,
                        color: derived.bgBase,
                      }}
                    >
                      Play
                    </div>
                    <div
                      className="px-2.5 py-1 rounded-full text-[9px] font-medium"
                      style={{
                        backgroundColor: derived.bgInset,
                        color: derived.textSecondary,
                      }}
                    >
                      Queue
                    </div>
                  </div>
                </div>
              </div>
              {/* Mini player bar */}
              <div
                className="flex items-center gap-2 px-3 py-2 border-t border-th-border-subtle"
                style={{ backgroundColor: derived.bgElevated }}
              >
                <div
                  className="w-6 h-6 rounded"
                  style={{ backgroundColor: derived.bgSurfaceHover }}
                />
                <div className="flex-1">
                  <div
                    className="h-1 rounded-full overflow-hidden"
                    style={{ backgroundColor: derived.bgInset }}
                  >
                    <div
                      className="h-full rounded-full w-2/3"
                      style={{ backgroundColor: derived.accent }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-th-border-subtle">
          <button
            onClick={handleReset}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-th-text-muted hover:text-th-text-primary transition-colors rounded-lg hover:bg-th-border-subtle"
          >
            <RotateCcw size={13} />
            Reset
          </button>
          <button
            onClick={onClose}
            className="px-5 py-2 text-[13px] font-bold rounded-full bg-th-accent text-black hover:brightness-110 active:scale-95 transition-all duration-150"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
