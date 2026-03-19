import { Pencil, Trash2, ListMusic, Loader2, X } from "lucide-react";
import { useState, useRef, useEffect, useCallback, startTransition } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { useToast } from "../contexts/ToastContext";
import { useFolders } from "../hooks/useFolders";
import { useContextMenu } from "../hooks/useContextMenu";
import { currentViewAtom } from "../atoms/navigation";
import { CreatePlaylistModal } from "./AddToPlaylistMenu";
import MenuPortal from "./MenuPortal";

interface FolderContextMenuProps {
  folderId: string;
  folderName: string;
  cursorPosition: { x: number; y: number };
  onClose: () => void;
}

// ─── Rename folder modal ──────────────────────────────────────

function RenameFolderModal({
  folderId,
  currentName,
  onClose,
}: {
  folderId: string;
  currentName: string;
  onClose: () => void;
}) {
  const { renameFolder } = useFolders();
  const { showToast } = useToast();

  const [name, setName] = useState(currentName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus and select text
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canSave = name.trim().length > 0 && name.trim() !== currentName;

  const handleSave = useCallback(async () => {
    if (!canSave || saving) return;
    setError(null);
    setSaving(true);
    try {
      await renameFolder(folderId, name.trim());
      showToast(`Renamed to "${name.trim()}"`);
      onClose();
    } catch {
      setError("Failed to rename folder");
      setSaving(false);
    }
  }, [canSave, saving, renameFolder, folderId, name, showToast, onClose]);

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center"
      style={{ animation: "fadeIn 0.15s ease-out" }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal panel */}
      <div
        className="relative w-full max-w-[520px] bg-th-surface rounded-xl shadow-2xl overflow-hidden mx-4"
        style={{ animation: "slideUp 0.2s ease-out" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <h2 className="text-[18px] font-semibold text-th-text-primary">
            Rename folder
          </h2>
          <button
            className="p-1 text-th-text-muted hover:text-th-text-primary rounded-full transition-colors"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 pb-2 flex flex-col gap-4">
          <div>
            <input
              ref={inputRef}
              type="text"
              placeholder="Folder name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
              }}
              disabled={saving}
              className="w-full bg-transparent text-th-text-primary text-[15px] px-4 py-3.5 rounded-lg border border-th-inset-hover focus:border-th-text-faint focus:outline-none placeholder-th-text-faint transition-colors"
            />
          </div>

          {/* Error */}
          {error && <p className="text-[13px] text-th-error">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex justify-end px-6 pt-2 pb-6">
          <button
            onClick={handleSave}
            disabled={!canSave || saving}
            className="px-6 py-2.5 bg-th-accent text-black text-[14px] font-semibold rounded-full hover:bg-th-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {saving && <Loader2 size={16} className="animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Folder context menu ──────────────────────────────────────

export default function FolderContextMenu({
  folderId,
  folderName,
  cursorPosition,
  onClose,
}: FolderContextMenuProps) {
  const { deleteFolder, movePlaylistTo } = useFolders();
  const { showToast } = useToast();
  const currentView = useAtomValue(currentViewAtom);
  const setCurrentView = useSetAtom(currentViewAtom);

  const [showRename, setShowRename] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showCreatePlaylist, setShowCreatePlaylist] = useState(false);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);

  const { menuRef, style } = useContextMenu({
    cursorPosition,
    suppressClose: showRename || showDeleteConfirm || showCreatePlaylist,
    onClose,
  });

  const isLoading = (action: string) => loadingAction === action;

  const handleDeleteFolder = useCallback(async () => {
    setLoadingAction("delete");
    try {
      await deleteFolder(folderId);
      showToast(`Deleted "${folderName}"`);
      if (
        currentView.type === "libraryViewAll" &&
        currentView.folderId === folderId
      ) {
        const homeView = { type: "home" as const };
        window.history.replaceState(homeView, "");
        startTransition(() => setCurrentView(homeView));
      }
    } catch {
      showToast("Failed to delete folder", "error");
    }
    setLoadingAction(null);
    onClose();
  }, [
    deleteFolder,
    folderId,
    folderName,
    currentView,
    setCurrentView,
    onClose,
    showToast,
  ]);

  const menuItemClass =
    "w-full flex items-center gap-3 px-4 py-2.5 hover:bg-th-hl-faint transition-colors text-left text-[14px] text-th-text-secondary hover:text-th-text-primary";

  return (
    <MenuPortal>
      <div
        ref={menuRef}
        className="z-[9999] w-[240px] bg-th-surface rounded-xl shadow-2xl overflow-hidden flex flex-col py-1"
        style={style}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        {/* Rename */}
        <button
          className={menuItemClass}
          onClick={() => setShowRename(true)}
        >
          <Pencil size={18} className="shrink-0 text-th-text-muted" />
          <span>Rename</span>
        </button>

        {/* Create playlist */}
        <button
          className={menuItemClass}
          onClick={() => setShowCreatePlaylist(true)}
        >
          <ListMusic size={18} className="shrink-0 text-th-text-muted" />
          <span>Create playlist</span>
        </button>

        {/* Divider */}
        <div className="my-1 border-t border-th-inset" />

        {/* Delete folder */}
        <button
          className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-th-hl-faint transition-colors text-left text-[14px] text-th-error hover:text-th-error"
          onClick={() => setShowDeleteConfirm(true)}
          disabled={!!loadingAction}
        >
          <Trash2 size={18} className="shrink-0" />
          <span>Delete folder</span>
        </button>
      </div>

      {/* Rename modal */}
      {showRename && (
        <RenameFolderModal
          folderId={folderId}
          currentName={folderName}
          onClose={() => {
            setShowRename(false);
            onClose();
          }}
        />
      )}

      {/* Create playlist modal */}
      {showCreatePlaylist && (
        <CreatePlaylistModal
          trackIds={[]}
          onClose={() => {
            setShowCreatePlaylist(false);
            onClose();
          }}
          onCreated={async (playlist) => {
            setShowCreatePlaylist(false);
            try {
              await movePlaylistTo({
                playlistUuid: playlist.uuid,
                targetFolderId: folderId,
                playlistSnapshot: {
                  title: playlist.title,
                  image: playlist.image,
                  creatorName: playlist.creator?.name,
                },
              });
            } catch {
              showToast(
                "Playlist created but could not be moved to folder",
                "error",
              );
            }
            onClose();
          }}
        />
      )}

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-[10000] bg-black/60 backdrop-blur-sm flex items-center justify-center"
          onClick={() => setShowDeleteConfirm(false)}
        >
          <div
            className="bg-th-elevated rounded-xl shadow-2xl max-w-[400px] w-[90%] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-th-text-primary mb-2">
              Delete folder?
            </h3>
            <p className="text-sm text-th-text-secondary mb-6">
              Are you sure you want to delete "{folderName}"? This can't be
              undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                className="px-4 py-2 rounded-lg text-sm font-medium text-th-text-secondary hover:text-th-text-primary hover:bg-th-hl-med transition-colors"
                onClick={() => setShowDeleteConfirm(false)}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 rounded-lg text-sm font-medium bg-th-error text-white hover:brightness-110 transition-all disabled:opacity-50"
                onClick={handleDeleteFolder}
                disabled={!!loadingAction}
              >
                {isLoading("delete") ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </MenuPortal>
  );
}
