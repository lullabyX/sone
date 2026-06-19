import { useState, useEffect, useCallback, useRef } from "react";
import { useAtom } from "jotai";
import { themeAtom } from "../../atoms/theme";
import { PRESET_THEMES, deriveTheme, type Theme } from "../../lib/theme";
import { Check, RotateCcw } from "lucide-react";
import ColorPicker from "./ColorPicker";
import ThemeMiniPreview from "./ThemeMiniPreview";

const SECTION_LABEL =
  "text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mb-3";

type PickerTarget = "accent" | "bg";

export default function ThemesTab() {
  const [theme, setTheme] = useAtom(themeAtom);
  const [localAccent, setLocalAccent] = useState(theme.accent);
  const [localBg, setLocalBg] = useState(theme.bgBase);
  const [activePreset, setActivePreset] = useState<string | null>(
    PRESET_THEMES.find(
      (p) => p.accent === theme.accent && p.bgBase === theme.bgBase,
    )?.name ?? null,
  );

  // Color-picker popover state
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [pickerPos, setPickerPos] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });
  const sectionRef = useRef<HTMLElement>(null);
  const accentSwatchRef = useRef<HTMLButtonElement>(null);
  const bgSwatchRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

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

  // Close popover on outside click
  useEffect(() => {
    if (!picker) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (accentSwatchRef.current?.contains(target)) return;
      if (bgSwatchRef.current?.contains(target)) return;
      setPicker(null);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [picker]);

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

  const togglePicker = (
    target: PickerTarget,
    anchor: HTMLButtonElement | null,
  ) => {
    if (picker === target) {
      setPicker(null);
      return;
    }
    const section = sectionRef.current;
    if (anchor && section) {
      const a = anchor.getBoundingClientRect();
      const s = section.getBoundingClientRect();
      setPickerPos({
        top: a.bottom - s.top + 8,
        left: a.left - s.left,
      });
    }
    setPicker(target);
  };

  return (
    <div>
      {/* Presets */}
      <section>
        <h3 className={SECTION_LABEL}>Presets</h3>
        <div className="grid grid-cols-4 gap-2.5">
          {PRESET_THEMES.map((p) => {
            const active = activePreset === p.name;
            const d = deriveTheme(p.accent, p.bgBase);
            return (
              <button
                key={p.name}
                onClick={() => handlePresetClick(p)}
                className="cursor-pointer text-left"
              >
                <span
                  className="relative flex h-[42px] items-center gap-2 rounded-[10px] px-3 transition"
                  style={{
                    background: d.bgSurface,
                    boxShadow: `inset 0 0 0 1px ${d.borderSubtle}`,
                    outline: active
                      ? `2px solid ${p.accent}`
                      : "2px solid transparent",
                  }}
                >
                  <span
                    className="block h-[18px] w-[18px] shrink-0 rounded-full"
                    style={{ background: p.accent }}
                  />
                  <span
                    className="block h-[18px] w-[18px] shrink-0 rounded-full"
                    style={{
                      background: p.bgBase,
                      boxShadow: `inset 0 0 0 1px ${d.borderSubtle}`,
                    }}
                  />
                  {active && (
                    <span
                      className="absolute right-1.5 top-[5px] grid h-[15px] w-[15px] place-items-center rounded-full"
                      style={{ background: p.accent, color: d.onAccent }}
                    >
                      <Check size={9} />
                    </span>
                  )}
                </span>
                <span
                  className={`mt-1 block text-[11px] font-medium ${
                    active ? "text-th-text-primary" : "text-th-text-secondary"
                  }`}
                >
                  {p.name}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Custom + picker + preview */}
      <section ref={sectionRef} className="relative mt-[30px]">
        <h3 className={SECTION_LABEL}>Custom</h3>

        <div className="flex items-center gap-[11px]">
          <span className="text-[12.5px] text-th-text-secondary w-[92px] shrink-0">
            Accent
          </span>
          <button
            ref={accentSwatchRef}
            type="button"
            onClick={() => togglePicker("accent", accentSwatchRef.current)}
            className="w-[34px] h-[34px] rounded-[9px] border border-th-border-subtle cursor-pointer p-0 shrink-0"
            style={{ background: localAccent }}
            aria-label="Pick accent color"
          />
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
            className="w-[112px] px-[11px] py-2 text-[12.5px] font-mono uppercase bg-th-inset border border-th-border-subtle rounded-[9px] text-th-text-primary outline-none focus:border-th-accent transition-colors"
            maxLength={7}
            spellCheck={false}
          />
        </div>

        <div className="flex items-center gap-[11px] mt-[11px]">
          <span className="text-[12.5px] text-th-text-secondary w-[92px] shrink-0">
            Background
          </span>
          <button
            ref={bgSwatchRef}
            type="button"
            onClick={() => togglePicker("bg", bgSwatchRef.current)}
            className="w-[34px] h-[34px] rounded-[9px] border border-th-border-subtle cursor-pointer p-0 shrink-0"
            style={{ background: localBg }}
            aria-label="Pick background color"
          />
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
            className="w-[112px] px-[11px] py-2 text-[12.5px] font-mono uppercase bg-th-inset border border-th-border-subtle rounded-[9px] text-th-text-primary outline-none focus:border-th-accent transition-colors"
            maxLength={7}
            spellCheck={false}
          />
        </div>

        {/* Preview */}
        <h3 className={`${SECTION_LABEL} mt-[30px]`}>Preview</h3>
        <ThemeMiniPreview accent={localAccent} bg={localBg} />

        <button
          onClick={handleReset}
          className="mt-[18px] inline-flex items-center gap-2 px-4 py-2 text-[12.5px] font-semibold text-th-text-secondary border border-th-border-subtle rounded-[10px] hover:text-th-text-primary hover:border-th-text-faint transition-colors"
        >
          <RotateCcw size={15} /> Reset to default
        </button>

        {/* Color-picker popover */}
        {picker && (
          <div
            ref={popoverRef}
            className="absolute z-50"
            style={{ top: pickerPos.top, left: pickerPos.left }}
          >
            <ColorPicker
              value={picker === "accent" ? localAccent : localBg}
              onChange={
                picker === "accent" ? handleAccentChange : handleBgChange
              }
            />
          </div>
        )}
      </section>
    </div>
  );
}
