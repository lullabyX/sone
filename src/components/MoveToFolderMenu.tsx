import { Plus, Search, X, Loader2, FolderOpen, FolderInput } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { useAtom, useSetAtom } from "jotai";
import { useToast } from "../contexts/ToastContext";
import { useFolders, getRecentFolderIds } from "../hooks/useFolders";
import { useContextMenu } from "../hooks/useContextMenu";
import { getPlaylistFolders, normalizePlaylistFolders } from "../api/tidal";
import { folderSubtitle } from "../utils/itemHelpers";
import { allFoldersAtom, allFoldersFetchedAtom, folderCountAdjustmentsAtom, addedToFolderAtom, movedPlaylistsAtom } from "../atoms/playlists";
import type { Folder } from "../types";
import MenuPortal from "./MenuPortal";

// ─── Public API ────────────────────────────────────────────────

interface MoveToFolderMenuProps {
  playlistUuid: string;
  playlistTitle: string;
  playlistImage?: string;
  playlistCreatorName?: string;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  sourceFolderId?: string;
  onClose: () => void;
}

// ─── Create-folder modal ──────────────────────────────────────

function CreateFolderModal({
  playlistUuid,
  playlistTitle,
  onClose,
  onCreated,
}: {
  playlistUuid: string;
  playlistTitle: string;
  onClose: () => void;
  onCreated: (folderName: string, folderId?: string) => void;
}) {
  const { createFolder } = useFolders();
  const { showToast } = useToast();

  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Auto-focus name input
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleSave = useCallback(async () => {
    if (!name.trim() || saving) return;
    setError(null);
    setSaving(true);
    try {
      const result = await createFolder(name.trim(), "root", `trn:playlist:${playlistUuid}`);
      const label =
        playlistTitle.length > 25
          ? playlistTitle.slice(0, 23) + "\u2026"
          : playlistTitle;
      const folderLabel =
        name.trim().length > 25
          ? name.trim().slice(0, 23) + "\u2026"
          : name.trim();
      showToast(`Moved "${label}" to "${folderLabel}"`);
      onCreated(name.trim(), result?.id);
    } catch {
      setError("Failed to create folder");
      setSaving(false);
    }
  }, [name, saving, createFolder, playlistUuid, playlistTitle, showToast, onCreated]);

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
            Create folder
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
          {/* Name input */}
          <div>
            <input
              ref={nameRef}
              type="text"
              placeholder="Folder name"
              value={name}
              onChange={(e) => setName(e.target.value)}
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
            disabled={!name.trim() || saving}
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

// ─── Main context-menu component ───────────────────────────────

export default function MoveToFolderMenu({
  playlistUuid,
  playlistTitle,
  playlistImage,
  playlistCreatorName,
  anchorRef,
  sourceFolderId,
  onClose,
}: MoveToFolderMenuProps) {
  const { movePlaylistTo } = useFolders();
  const { showToast } = useToast();
  const setCountAdjustments = useSetAtom(folderCountAdjustmentsAtom);
  const setAddedToFolder = useSetAtom(addedToFolderAtom);
  const setMovedPlaylists = useSetAtom(movedPlaylistsAtom);

  const [showAll, setShowAll] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [movingTo, setMovingTo] = useState<string | null>(null);
  const [movedTo, setMovedTo] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Folder data
  const [allFolders, setAllFolders] = useAtom(allFoldersAtom);
  const [foldersFetched, setFoldersFetched] = useAtom(allFoldersFetchedAtom);
  const [foldersLoading, setFoldersLoading] = useState(!foldersFetched);

  const searchRef = useRef<HTMLInputElement>(null);

  // Read recent IDs once on mount
  const [recentIds] = useState(() => getRecentFolderIds());

  const { menuRef, style } = useContextMenu({
    anchorRef,
    anchorGap: 6,
    suppressClose: showCreateModal,
    onClose,
  });

  // Fetch all folders on mount — paginate through all items
  useEffect(() => {
    if (foldersFetched) {
      setFoldersLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const folders: Folder[] = [];
      let cursor: string | undefined;
      try {
        do {
          const resp = await getPlaylistFolders("root", 0, 50, "DATE_UPDATED", "DESC", undefined, cursor);
          if (cancelled) return;
          const normalized = normalizePlaylistFolders(resp);
          for (const item of normalized.items) {
            if (item.kind === "folder") folders.push(item.data);
          }
          cursor = normalized.cursor ?? undefined;
        } while (cursor);
      } catch (err) {
        console.error("[MoveToFolderMenu] failed to fetch folders:", err);
      }
      if (!cancelled) {
        const sorted = folders.sort((a, b) => a.name.localeCompare(b.name));
        setAllFolders(sorted);
        setFoldersFetched(true);
        setFoldersLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [foldersFetched, setAllFolders, setFoldersFetched]);

  // Focus search when showing all
  useEffect(() => {
    if (showAll && searchRef.current) {
      searchRef.current.focus();
    }
  }, [showAll]);

  // Resolve recent folder IDs to folder objects
  const recentFolders = recentIds
    .map((id) => allFolders.find((f) => f.id === id))
    .filter((f): f is Folder => !!f);

  // Filtered folders for "show all" view
  const filteredFolders = searchQuery
    ? allFolders.filter((f) =>
        f.name.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : allFolders;

  const handleMoveToFolder = useCallback(
    async (folder: Folder) => {
      setError(null);
      setMovingTo(folder.id);
      try {
        await movePlaylistTo({
          playlistUuid,
          targetFolderId: folder.id,
          sourceFolderId,
          playlistSnapshot: { title: playlistTitle, image: playlistImage, creatorName: playlistCreatorName },
        });
        setMovedTo((prev) => new Set([...prev, folder.id]));
        const playlistLabel =
          playlistTitle.length > 25
            ? playlistTitle.slice(0, 23) + "\u2026"
            : playlistTitle;
        const folderLabel =
          folder.name.length > 25
            ? folder.name.slice(0, 23) + "\u2026"
            : folder.name;
        showToast(`Moved "${playlistLabel}" to "${folderLabel}"`);
        setTimeout(onClose, 500);
      } catch {
        setError("Failed to move playlist");
      } finally {
        setMovingTo(null);
      }
    },
    [movePlaylistTo, playlistUuid, playlistTitle, playlistImage, playlistCreatorName, sourceFolderId, onClose, showToast],
  );

  const handleMoveToRoot = useCallback(async () => {
    setError(null);
    setMovingTo("root");
    try {
      await movePlaylistTo({
        playlistUuid,
        targetFolderId: "root",
        sourceFolderId,
        playlistSnapshot: { title: playlistTitle, image: playlistImage, creatorName: playlistCreatorName },
      });
      setMovedTo((prev) => new Set([...prev, "root"]));
      const playlistLabel =
        playlistTitle.length > 25
          ? playlistTitle.slice(0, 23) + "\u2026"
          : playlistTitle;
      showToast(`Moved "${playlistLabel}" to Playlists`);
      setTimeout(onClose, 500);
    } catch {
      setError("Failed to move playlist");
    } finally {
      setMovingTo(null);
    }
  }, [movePlaylistTo, playlistUuid, playlistTitle, playlistImage, playlistCreatorName, sourceFolderId, onClose, showToast]);

  // ── Row components ──

  /** Compact row for the recent section (folder icon + name + status) */
  const CompactFolderRow = ({ folder }: { folder: Folder }) => {
    const isMoving = movingTo === folder.id;
    const isMoved = movedTo.has(folder.id);

    return (
      <button
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-th-hl-faint transition-colors text-left group/row"
        onClick={() => handleMoveToFolder(folder)}
        disabled={isMoving || isMoved}
      >
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <FolderOpen
            size={16}
            className="shrink-0 text-th-text-faint group-hover/row:text-th-text-primary transition-colors"
          />
          <span className="text-[14px] text-th-text-secondary truncate group-hover/row:text-th-text-primary transition-colors">
            {folder.name}
          </span>
        </div>
        <div className="shrink-0 ml-2 flex items-center justify-center">
          {isMoving ? (
            <Loader2 size={16} className="text-th-text-muted animate-spin" />
          ) : isMoved ? (
            <span className="text-th-accent text-[11px] font-semibold">
              Moved
            </span>
          ) : null}
        </div>
      </button>
    );
  };

  /** Rich row for the "show all" view (folder icon box + name + "Folder" subtitle + status) */
  const DetailedFolderRow = ({ folder }: { folder: Folder }) => {
    const isMoving = movingTo === folder.id;
    const isMoved = movedTo.has(folder.id);

    return (
      <button
        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-th-hl-faint transition-colors text-left group/row"
        onClick={() => handleMoveToFolder(folder)}
        disabled={isMoving || isMoved}
      >
        {/* Folder icon box */}
        <div className="w-10 h-10 shrink-0 rounded bg-th-surface-hover flex items-center justify-center">
          <FolderOpen size={20} className="text-th-text-faint" />
        </div>

        {/* Name + subtitle */}
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-[14px] text-th-text-secondary truncate group-hover/row:text-th-text-primary transition-colors leading-snug">
            {folder.name}
          </span>
          <span className="text-[12px] text-th-text-faint leading-snug">
            {folderSubtitle(folder.totalNumberOfItems)}
          </span>
        </div>

        {/* Action */}
        <div className="shrink-0 w-5 flex items-center justify-center">
          {isMoving ? (
            <Loader2 size={16} className="text-th-text-muted animate-spin" />
          ) : isMoved ? (
            <span className="text-th-accent text-[11px] font-semibold">
              Moved
            </span>
          ) : null}
        </div>
      </button>
    );
  };

  // ── Render ──

  return (
    <MenuPortal>
      {/* Context menu */}
      <div
        ref={menuRef}
        className="z-[9999] w-[320px] max-h-[420px] bg-th-surface rounded-xl shadow-2xl overflow-hidden flex flex-col"
        style={style}
        onClick={(e) => e.stopPropagation()}
      >
        {showAll ? (
          /* ── Show-all view ── */
          <>
            {/* Search bar */}
            <div className="px-4 pt-4 pb-2">
              <div className="relative">
                <Search
                  size={14}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-th-text-faint"
                />
                <input
                  ref={searchRef}
                  type="text"
                  placeholder="Find a folder"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-th-inset text-th-text-primary text-[13px] pl-9 pr-8 py-2 rounded-md focus:outline-none placeholder-th-text-disabled"
                />
                {searchQuery && (
                  <button
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-th-text-faint hover:text-th-text-primary"
                    onClick={() => setSearchQuery("")}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>

            {/* Back link */}
            <button
              className="px-5 py-2 text-[12px] text-th-text-primary hover:text-th-accent text-left transition-colors"
              onClick={() => {
                setShowAll(false);
                setSearchQuery("");
              }}
            >
              &larr; Back
            </button>

            {/* Filtered list */}
            <div className="flex-1 overflow-y-auto custom-scrollbar pb-2">
              {foldersLoading ? (
                <div className="px-5 py-8 flex items-center justify-center">
                  <Loader2 size={20} className="text-th-text-muted animate-spin" />
                </div>
              ) : filteredFolders.length === 0 ? (
                <div className="px-5 py-8 text-center text-[13px] text-th-text-disabled">
                  {searchQuery ? "No folders found" : "No folders yet"}
                </div>
              ) : (
                filteredFolders.map((f) => (
                  <DetailedFolderRow key={f.id} folder={f} />
                ))
              )}
            </div>
          </>
        ) : (
          /* ── Default view ── */
          <>
            {/* Create new folder */}
            <button
              className="w-full flex items-center gap-3 px-5 py-4 hover:bg-th-hl-faint transition-colors"
              onClick={() => setShowCreateModal(true)}
            >
              <div className="w-8 h-8 rounded-full bg-th-inset flex items-center justify-center shrink-0">
                <Plus size={18} className="text-th-text-primary" />
              </div>
              <span className="text-[15px] text-th-text-primary font-medium">
                Create new folder
              </span>
            </button>

            {/* Show all folders */}
            <button
              className="w-full flex items-center gap-3 px-5 py-3 hover:bg-th-hl-faint transition-colors"
              onClick={() => setShowAll(true)}
            >
              <span className="text-[14px] text-th-text-muted hover:text-th-text-primary transition-colors">
                Show all folders
              </span>
            </button>

            {/* RECENT section */}
            {!foldersLoading && recentFolders.length > 0 && (
              <div className="flex flex-col mt-1">
                <div className="px-5 pt-2 pb-1">
                  <span className="text-[11px] font-bold text-th-text-muted uppercase tracking-[0.12em]">
                    Recent
                  </span>
                </div>
                <div className="overflow-y-auto custom-scrollbar max-h-[240px]">
                  {recentFolders.map((f) => (
                    <CompactFolderRow key={f.id} folder={f} />
                  ))}
                </div>
              </div>
            )}

            {/* Divider */}
            <div className="mx-4 my-1 border-t border-th-hl-faint" />

            {/* Move to root (Playlists) */}
            <button
              className="w-full flex items-center justify-between px-5 py-3 hover:bg-th-hl-faint transition-colors text-left group/row"
              onClick={handleMoveToRoot}
              disabled={movingTo === "root" || movedTo.has("root")}
            >
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <FolderInput
                  size={16}
                  className="shrink-0 text-th-text-faint group-hover/row:text-th-text-primary transition-colors"
                />
                <span className="text-[14px] text-th-text-secondary group-hover/row:text-th-text-primary transition-colors">
                  Playlists
                </span>
              </div>
              <div className="shrink-0 ml-2 flex items-center justify-center">
                {movingTo === "root" ? (
                  <Loader2 size={16} className="text-th-text-muted animate-spin" />
                ) : movedTo.has("root") ? (
                  <span className="text-th-accent text-[11px] font-semibold">
                    Moved
                  </span>
                ) : null}
              </div>
            </button>
          </>
        )}

        {/* Error bar */}
        {error && (
          <div className="px-5 py-2.5 bg-th-error/10 border-t border-th-error/20">
            <span className="text-[12px] text-th-error">{error}</span>
          </div>
        )}
      </div>

      {/* Create folder modal */}
      {showCreateModal && (
        <CreateFolderModal
          playlistUuid={playlistUuid}
          playlistTitle={playlistTitle}
          onClose={() => setShowCreateModal(false)}
          onCreated={(folderName, realFolderId) => {
            // Optimistic: add new folder to sidebar
            const folderId = realFolderId ?? `optimistic-${Date.now()}`;
            setAddedToFolder((prev) => {
              const next = new Map(prev);
              const list = next.get("root") ?? [];
              next.set("root", [...list, {
                kind: "folder" as const,
                data: { id: folderId, name: folderName, parent: null, addedAt: new Date().toISOString(), lastModifiedAt: new Date().toISOString(), totalNumberOfItems: 1 },
              }]);
              return next;
            });
            // Optimistic: hide playlist from source
            if (sourceFolderId) {
              setMovedPlaylists((prev) => {
                const next = new Map(prev);
                next.set(playlistUuid, sourceFolderId);
                return next;
              });
              setCountAdjustments((prev) => {
                const next = new Map(prev);
                next.set(sourceFolderId, (next.get(sourceFolderId) ?? 0) - 1);
                return next;
              });
            }
            setShowCreateModal(false);
            onClose();
          }}
        />
      )}
    </MenuPortal>
  );
}
