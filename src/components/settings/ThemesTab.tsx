import { useState, useEffect, useCallback } from "react";
import { useAtom } from "jotai";
import { themeAtom } from "../../atoms/theme";
import { PRESET_THEMES, deriveTheme, type Theme } from "../../lib/theme";
import { Check, RotateCcw } from "lucide-react";

const SECTION_LABEL =
  "text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mb-3";

export default function ThemesTab() {
  const [theme, setTheme] = useAtom(themeAtom);
  const [localAccent, setLocalAccent] = useState(theme.accent);
  const [localBg, setLocalBg] = useState(theme.bgBase);
  const [activePreset, setActivePreset] = useState<string | null>(
    PRESET_THEMES.find(
      (p) => p.accent === theme.accent && p.bgBase === theme.bgBase,
    )?.name ?? null,
  );

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
    <div>
      {/* Presets */}
      <section>
        <h3 className={SECTION_LABEL}>Presets</h3>
        <div className="grid grid-cols-4 gap-2">
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

      {/* Custom & preview */}
      <section className="mt-6">
        <h3 className={SECTION_LABEL}>Custom & preview</h3>
        <div className="flex flex-wrap gap-4">
          <div className="flex-1 min-w-[230px]">
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
          </div>

          <div className="flex-1 min-w-[210px]">
            {/* Live preview */}
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
          </div>
        </div>
      </section>

      <button
        onClick={handleReset}
        className="mt-5 inline-flex items-center gap-2 px-4 py-2 text-[12.5px] font-semibold text-th-text-secondary border border-th-border-subtle rounded-[10px] hover:text-th-text-primary hover:border-th-text-faint transition-colors"
      >
        <RotateCcw size={15} /> Reset to default
      </button>
    </div>
  );
}
