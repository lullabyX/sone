import { ChevronLeft, X } from "lucide-react";
import { SOCIAL_TYPES } from "../lib/socialLinks";

const LABELS: Record<string, string> = {
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
  FACEBOOK: "Facebook",
  TWITTER: "X",
  SNAPCHAT: "Snapchat",
};

interface SocialMediaPanelProps {
  socials: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  onBack: () => void;
  onClose: () => void;
}

export default function SocialMediaPanel({
  socials,
  onChange,
  onBack,
  onClose,
}: SocialMediaPanelProps) {
  return (
    <div className="w-[440px] max-w-[92vw] bg-th-elevated rounded-2xl shadow-2xl flex flex-col overflow-hidden max-h-[86vh]">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-th-border-subtle">
        <button
          onClick={onBack}
          aria-label="Back"
          className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-th-inset text-th-text-muted hover:text-th-text-primary transition-colors"
        >
          <ChevronLeft size={18} />
        </button>
        <h2 className="flex-1 text-[16px] font-bold text-th-text-primary">
          Social media
        </h2>
        <button
          onClick={onClose}
          aria-label="Close"
          className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-th-inset text-th-text-muted hover:text-th-text-primary transition-colors"
        >
          <X size={18} />
        </button>
      </div>

      <div className="px-5 py-4 overflow-y-auto scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent">
        <p className="text-[12px] text-th-text-muted mb-4">
          Your public profile will show links to social media accounts you add
          here.
        </p>
        <div className="flex flex-col gap-3">
          {SOCIAL_TYPES.map((type) => (
            <label key={type} className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold text-th-text-secondary">
                {LABELS[type]}
              </span>
              <input
                type="text"
                placeholder={LABELS[type]}
                value={socials[type] ?? ""}
                onChange={(e) => onChange({ ...socials, [type]: e.target.value })}
                className="bg-th-inset rounded-md px-3 py-2 text-[14px] text-th-text-primary placeholder:text-th-text-faint outline-none focus:ring-1 focus:ring-th-accent"
              />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
