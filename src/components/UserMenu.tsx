import { LogOut, User } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { useAudioContext } from "../contexts/AudioContext";

export default function UserMenu() {
  const { userName, logout } = useAudioContext();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="w-8 h-8 rounded-full bg-[#333] hover:bg-[#444] flex items-center justify-center transition-colors"
        title="Account"
      >
        <User size={16} className="text-[#ccc]" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-56 bg-[#1a1a1a] rounded-lg shadow-2xl shadow-black/60 border border-white/[0.08] z-50 py-1 animate-fadeIn">
          {/* User info */}
          <div className="px-4 py-3 border-b border-white/[0.06]">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-[#333] flex items-center justify-center shrink-0">
                <User size={16} className="text-[#a6a6a6]" />
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-white truncate">
                  {userName}
                </p>
              </div>
            </div>
          </div>

          {/* Logout */}
          <button
            onClick={() => {
              setOpen(false);
              logout();
            }}
            className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] text-red-400 hover:bg-white/[0.06] transition-colors"
          >
            <LogOut size={16} />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
