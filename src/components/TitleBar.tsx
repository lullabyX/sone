import { useEffect, useState, useCallback } from "react";
import { Minus, X, Square, Copy } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const TITLEBAR_HEIGHT = 32;

function useWindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFocused, setIsFocused] = useState(true);

  useEffect(() => {
    const win = getCurrentWindow();

    win
      .isMaximized()
      .then(setIsMaximized)
      .catch(() => {});
    win
      .isFocused()
      .then(setIsFocused)
      .catch(() => {});

    const unlistenResize = win.onResized(() => {
      win
        .isMaximized()
        .then(setIsMaximized)
        .catch(() => {});
    });
    const unlistenFocus = win.onFocusChanged(({ payload }) => {
      setIsFocused(payload);
    });

    return () => {
      unlistenResize.then((fn) => fn()).catch(() => {});
      unlistenFocus.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const minimize = useCallback(() => {
    getCurrentWindow()
      .minimize()
      .catch(() => {});
  }, []);

  // Explicit branch dodges wry#622 — toggleMaximize is flaky on frameless windows
  const toggleMaximize = useCallback(async () => {
    const win = getCurrentWindow();
    try {
      if (await win.isMaximized()) {
        await win.unmaximize();
      } else {
        await win.maximize();
      }
    } catch {
      /* ignore */
    }
  }, []);

  const close = useCallback(() => {
    getCurrentWindow()
      .close()
      .catch(() => {});
  }, []);

  return { isMaximized, isFocused, minimize, toggleMaximize, close };
}

export default function TitleBar() {
  const { isMaximized, isFocused, minimize, toggleMaximize, close } =
    useWindowControls();

  // Suppress double-click bubbling when clicking buttons
  const handleDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-titlebar-button]")) return;
    toggleMaximize();
  };

  return (
    <div
      data-tauri-drag-region
      onDoubleClick={handleDoubleClick}
      className="flex items-center justify-between bg-th-overlay border-b border-th-border-subtle select-none shrink-0"
      style={{ height: TITLEBAR_HEIGHT }}
    >
      {/* Left zone: app icon + wordmark (also draggable) */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 pl-3 pr-4 h-full"
      >
        <img
          src="/sone-icon.png"
          alt=""
          width={16}
          height={16}
          draggable={false}
          className={`pointer-events-none transition-opacity ${
            isFocused ? "opacity-100" : "opacity-50"
          }`}
        />
        <span
          className={`text-[11px] font-semibold tracking-wider text-th-text-secondary transition-opacity ${
            isFocused ? "opacity-100" : "opacity-50"
          }`}
        >
          SONE
        </span>
      </div>

      {/* Middle zone (flex grows to fill — draggable) */}
      <div data-tauri-drag-region className="flex-1 h-full" />

      {/* Right zone: window controls */}
      <div
        className={`flex items-center gap-1 pr-2 h-full transition-opacity ${
          isFocused ? "opacity-100" : "opacity-60"
        }`}
      >
        <button
          data-titlebar-button
          onClick={minimize}
          aria-label="Minimize"
          className="w-7 h-7 rounded-full flex items-center justify-center text-th-text-muted hover:bg-th-button-hover hover:text-th-text-primary transition-colors"
        >
          <Minus size={14} />
        </button>
        <button
          data-titlebar-button
          onClick={toggleMaximize}
          aria-label={isMaximized ? "Restore" : "Maximize"}
          className="w-7 h-7 rounded-full flex items-center justify-center text-th-text-muted hover:bg-th-button-hover hover:text-th-text-primary transition-colors"
        >
          {isMaximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button
          data-titlebar-button
          onClick={close}
          aria-label="Close"
          className="w-7 h-7 rounded-full flex items-center justify-center text-th-text-muted hover:bg-red-500/80 hover:text-white transition-colors"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
