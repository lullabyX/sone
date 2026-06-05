import { useState, useEffect, useRef } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { X, Heart, CircleDot } from "lucide-react";

interface AboutModalProps {
  open: boolean;
  onClose: () => void;
}

const REPO_URL = "https://github.com/lullabyX/sone";
const RELEASES_URL = `${REPO_URL}/releases`;
const ISSUES_URL = `${REPO_URL}/issues`;
const LICENSE_URL = `${REPO_URL}/blob/master/LICENSE`;
const AUTHOR_URL = "https://github.com/lullabyX";
const PATREON_URL = "https://patreon.com/lullabyX";

const openExternal = (url: string) => {
  openUrl(url).catch(() => {});
};

const GithubMark = ({ size = 14 }: { size?: number }) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

export default function AboutModal({ open, onClose }: AboutModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [version, setVersion] = useState("");

  useEffect(() => {
    if (!open) return;
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, [open]);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={panelRef}
        className="w-[420px] bg-th-elevated rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ animation: "slideUp 0.2s ease-out" }}
      >
        {/* Header */}
        <div className="flex items-center justify-end px-3 pt-3">
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-th-inset transition-colors text-th-text-muted hover:text-th-text-primary"
          >
            <X size={18} />
          </button>
        </div>

        {/* Identity */}
        <div className="flex flex-col items-center px-5 pb-4 -mt-1">
          <img
            src="/sone-icon.png"
            alt=""
            className="w-16 h-16 rounded-2xl mb-3"
            draggable={false}
          />
          <h2 className="text-[20px] font-bold text-th-text-primary tracking-tight">
            SONE
          </h2>
          <div className="mt-1 flex items-center gap-2 text-[12px] text-th-text-muted">
            <button
              onClick={() => openExternal(RELEASES_URL)}
              className="hover:text-th-accent transition-colors"
              title="View releases"
            >
              {version ? `v${version}` : "—"}
            </button>
            <span className="text-th-text-muted/60">·</span>
            <button
              onClick={() => openExternal(LICENSE_URL)}
              className="hover:text-th-accent transition-colors"
              title="View license"
            >
              GPL-3.0
            </button>
          </div>
          <p className="mt-2 text-[12px] text-th-text-muted text-center">
            Native Linux client for TIDAL
          </p>
          <p className="mt-1 text-[11px] text-th-text-muted text-center">
            by Hassan Rabbi ·{" "}
            <button
              onClick={() => openExternal(AUTHOR_URL)}
              className="hover:text-th-accent transition-colors"
            >
              @lullabyX
            </button>
          </p>
        </div>

        {/* Support + links */}
        <div className="border-t border-th-border-subtle px-5 py-3">
          <button
            onClick={() => openExternal(PATREON_URL)}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-th-accent/10 text-th-accent hover:bg-th-accent/20 transition-colors text-[13px] font-medium"
          >
            <Heart size={14} />
            Support development on Patreon
          </button>
          <div className="mt-2.5 flex items-center justify-center gap-4 text-[12px]">
            <button
              onClick={() => openExternal(REPO_URL)}
              className="flex items-center gap-1.5 text-th-text-secondary hover:text-th-text-primary transition-colors"
            >
              <GithubMark size={14} />
              GitHub
            </button>
            <span className="text-th-text-muted/60">·</span>
            <button
              onClick={() => openExternal(ISSUES_URL)}
              className="flex items-center gap-1.5 text-th-text-secondary hover:text-th-text-primary transition-colors"
            >
              <CircleDot size={14} />
              Issues
            </button>
          </div>
        </div>

        {/* Disclaimer */}
        <div className="border-t border-th-border-subtle px-5 py-3 space-y-1">
          <p className="text-[10px] text-th-text-muted/70 text-center">
            Unofficial streaming client. Requires a valid TIDAL subscription.
          </p>
          <p className="text-[10px] text-th-text-muted/70 text-center">
            All trademarks belong to their respective owners.
          </p>
        </div>
      </div>
    </div>
  );
}
