import { useAtom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { maxQualityAtom } from "../../atoms/playback";

const TIERS = [
  { id: "HIGH", label: "High", spec: "AAC · up to 320 kbps" },
  { id: "LOSSLESS", label: "Lossless", spec: "FLAC · 16-bit / 44.1 kHz" },
  {
    id: "HI_RES_LOSSLESS",
    label: "Hi-Res Lossless",
    spec: "FLAC · up to 24-bit / 192 kHz",
  },
] as const;

export default function QualityPicker() {
  const [maxQuality, setMaxQuality] = useAtom(maxQualityAtom);

  return (
    <div className="rounded-[15px] bg-th-surface border border-th-border-subtle overflow-hidden">
      {TIERS.map((t) => {
        const sel = maxQuality === t.id;
        return (
          <button
            key={t.id}
            onClick={() => {
              setMaxQuality(t.id);
              invoke("set_max_quality", { quality: t.id }).catch(() => {});
            }}
            className={`relative w-full flex items-center gap-4 px-5 py-4 text-left border-t border-th-border-subtle first:border-t-0 transition-colors hover:bg-th-hl-faint ${
              sel ? "bg-th-accent/10" : ""
            }`}
          >
            {sel && (
              <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-th-accent" />
            )}
            <span
              className={`w-5 h-5 shrink-0 rounded-full border-2 flex items-center justify-center ${
                sel ? "border-th-accent" : "border-th-text-faint"
              }`}
            >
              <span
                className={`w-[9px] h-[9px] rounded-full bg-th-accent transition-transform ${
                  sel ? "scale-100" : "scale-0"
                }`}
              />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[14.5px] font-bold text-th-text-primary">
                {t.label}
              </span>
              <span className="block text-[12px] text-th-text-muted mt-0.5">
                {t.spec}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
