import { useEffect, useRef, useState } from "react";
import {
  X,
  Volume2,
  Palette,
  Radio,
  MessageSquare,
  AppWindow,
  Globe,
  FileText,
  Cpu,
  type LucideIcon,
} from "lucide-react";
import PlaybackTab from "./PlaybackTab";
import ThemesTab from "./ThemesTab";
import ScrobbleTab from "./ScrobbleTab";
import DiscordTab from "./DiscordTab";
import GeneralTab from "./GeneralTab";
import NetworkTab from "./NetworkTab";
import UtilitiesTab from "./UtilitiesTab";
import McpTab from "./McpTab";

type TabId =
  | "playback"
  | "themes"
  | "scrobble"
  | "discord"
  | "general"
  | "network"
  | "utilities"
  | "mcp";

const DISCORD_ICON: LucideIcon = MessageSquare; // replaced below by brand glyph

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "playback", label: "Playback", icon: Volume2 },
  { id: "themes", label: "Themes", icon: Palette },
  { id: "scrobble", label: "Scrobbling", icon: Radio },
  { id: "discord", label: "Discord", icon: DISCORD_ICON },
  { id: "general", label: "General", icon: AppWindow },
  { id: "network", label: "Network", icon: Globe },
  { id: "utilities", label: "Utilities", icon: FileText },
  { id: "mcp", label: "MCP", icon: Cpu },
];

function DiscordGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286ZM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189Zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

export default function SettingsSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [active, setActive] = useState<TabId>("playback");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setActive("playback");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node))
        onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/60 backdrop-blur-sm animate-fadeIn">
      <div
        ref={panelRef}
        className="w-full max-w-[960px] h-[90vh] bg-th-elevated rounded-t-2xl shadow-2xl flex flex-col overflow-hidden border border-th-border-subtle"
        style={{ animation: "slideUp 0.24s ease-out" }}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-th-border-subtle">
          <h2 className="text-[20px] font-extrabold text-th-text-primary">
            Settings
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-th-inset transition-colors text-th-text-muted hover:text-th-text-primary"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          <nav className="w-[176px] shrink-0 border-r border-th-border-subtle py-4 px-3 flex flex-col gap-0.5 overflow-y-auto">
            {TABS.map(({ id, label, icon: Icon }) => {
              const on = active === id;
              return (
                <button
                  key={id}
                  onClick={() => setActive(id)}
                  className={`relative flex items-center gap-3 px-3 py-2 rounded-md text-left text-[13px] transition-colors ${
                    on
                      ? "bg-th-inset text-th-text-primary"
                      : "text-th-text-secondary hover:bg-th-inset/50"
                  }`}
                >
                  {on && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-th-accent" />
                  )}
                  {id === "discord" ? (
                    <DiscordGlyph />
                  ) : (
                    <Icon size={16} className="shrink-0" />
                  )}
                  {label}
                </button>
              );
            })}
          </nav>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="max-w-[720px] mx-auto">
              {active === "playback" && <PlaybackTab />}
              {active === "themes" && <ThemesTab />}
              {active === "scrobble" && <ScrobbleTab />}
              {active === "discord" && <DiscordTab />}
              {active === "general" && <GeneralTab />}
              {active === "network" && <NetworkTab />}
              {active === "utilities" && <UtilitiesTab />}
              {active === "mcp" && <McpTab />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
