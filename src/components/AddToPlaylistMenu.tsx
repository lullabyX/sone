import { Plus, Search, X, Loader2 } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { useSetAtom } from "jotai";
import { useToast } from "../contexts/ToastContext";
import { usePlaylists } from "../hooks/usePlaylists";
import { addedToFolderAtom } from "../atoms/playlists";
import { useContextMenu } from "../hooks/useContextMenu";
import { type Playlist, getTidalImageUrl } from "../types";
import TidalImage from "./TidalImage";
import MenuPortal from "./MenuPortal";

// ─── Public API ────────────────────────────────────────────────

interface AddToPlaylistMenuProps {
  trackIds: number[];
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

// ─── Recent-playlist persistence ───────────────────────────────

const RECENT_PLAYLISTS_KEY = "sone.recent-playlists.v1";
const MAX_RECENT = 8;
const DESC_MAX_LEN = 500;

function getRecentPlaylistIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_PLAYLISTS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function pushRecentPlaylistId(playlistId: string) {
  const ids = getRecentPlaylistIds().filter((id) => id !== playlistId);
  ids.unshift(playlistId);
  if (ids.length > MAX_RECENT) ids.length = MAX_RECENT;
  try {
    localStorage.setItem(RECENT_PLAYLISTS_KEY, JSON.stringify(ids));
  } catch {}
}

// ─── Create-playlist modal ─────────────────────────────────────

export function CreatePlaylistModal({
  trackIds,
  onClose,
  onCreated,
}: {
  trackIds: number[];
  onClose: () => void;
  onCreated: (playlist: Playlist) => void;
}) {
  const { createPlaylist, addTracksToPlaylist } = usePlaylists();
  const { showToast } = useToast();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // Auto-focus title input
  useEffect(() => {
    titleRef.current?.focus();
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
    if (!title.trim() || saving) return;
    setError(null);
    setSaving(true);
    try {
      const playlist = await createPlaylist(title.trim(), description.trim());
      if (trackIds.length > 0) {
        await addTracksToPlaylist(playlist.uuid, trackIds);
      }
      pushRecentPlaylistId(playlist.uuid);
      showToast(`Created playlist "${title.trim()}"`);
      onCreated(playlist);
    } catch {
      setError("Failed to create playlist");
      setSaving(false);
    }
  }, [
    title,
    description,
    saving,
    createPlaylist,
    addTracksToPlaylist,
    trackIds,
    showToast,
    onCreated,
  ]);

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
            Create playlist
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
          {/* Title input */}
          <div>
            <input
              ref={titleRef}
              type="text"
              placeholder="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={saving}
              className="w-full bg-transparent text-th-text-primary text-[15px] px-4 py-3.5 rounded-lg border border-th-inset-hover focus:border-th-text-faint focus:outline-none placeholder-th-text-faint transition-colors"
            />
          </div>

          {/* Description textarea */}
          <div>
            <textarea
              placeholder="Write a description"
              value={description}
              onChange={(e) => {
                if (e.target.value.length <= DESC_MAX_LEN)
                  setDescription(e.target.value);
              }}
              disabled={saving}
              rows={4}
              className="w-full bg-transparent text-th-text-primary text-[14px] px-4 py-3 rounded-lg border border-th-inset-hover focus:border-th-text-faint focus:outline-none placeholder-th-text-faint resize-none transition-colors"
            />
            <div className="text-right mt-1">
              <span className="text-[12px] text-th-text-faint">
                {description.length}/{DESC_MAX_LEN} characters
              </span>
            </div>
          </div>

          {/* Error */}
          {error && <p className="text-[13px] text-th-error">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex justify-end px-6 pt-2 pb-6">
          <button
            onClick={handleSave}
            disabled={!title.trim() || saving}
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

export default function AddToPlaylistMenu({
  trackIds,
  anchorRef,
  onClose,
}: AddToPlaylistMenuProps) {
  const { userPlaylists, addTracksToPlaylist } = usePlaylists();
  const { showToast } = useToast();
  const setAddedToFolder = useSetAtom(addedToFolderAtom);

  const [showAll, setShowAll] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [addedTo, setAddedTo] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  const { menuRef, style } = useContextMenu({
    anchorRef,
    anchorGap: 6,
    suppressClose: showCreateModal,
    onClose,
  });

  // Focus search when showing all
  useEffect(() => {
    if (showAll && searchRef.current) {
      searchRef.current.focus();
    }
  }, [showAll]);

  // Recent playlists
  const recentIds = getRecentPlaylistIds();
  const recentPlaylists = recentIds
    .map((id) => userPlaylists.find((p) => p.uuid === id))
    .filter((p): p is Playlist => !!p);

  // Filtered playlists for "show all" view
  const filteredPlaylists = searchQuery
    ? userPlaylists.filter((p) =>
        p.title.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : userPlaylists;

  const handleAddToPlaylist = useCallback(
    async (playlist: Playlist) => {
      setError(null);
      setAddingTo(playlist.uuid);
      try {
        await addTracksToPlaylist(playlist.uuid, trackIds);
        pushRecentPlaylistId(playlist.uuid);
        setAddedTo((prev) => new Set([...prev, playlist.uuid]));
        const label =
          playlist.title.length > 25
            ? playlist.title.slice(0, 23) + "…"
            : playlist.title;
        showToast(
          trackIds.length > 1
            ? `Added ${trackIds.length} tracks to "${label}"`
            : `Added to "${label}"`,
        );
        setTimeout(onClose, 500);
      } catch (err: any) {
        const isDuplicateError = (e: unknown): boolean => {
          try {
            const parsed = typeof e === "string" ? JSON.parse(e) : e;
            if (parsed?.kind === "Api" && parsed?.message?.status === 409)
              return true;
          } catch {}
          return (
            String(e).includes("409") ||
            String(e).toLowerCase().includes("dupe")
          );
        };

        if (isDuplicateError(err)) {
          setError(
            trackIds.length > 1
              ? "Some tracks already in this playlist"
              : "Track already in this playlist",
          );
        } else {
          setError(
            trackIds.length > 1
              ? "Failed to add tracks"
              : "Failed to add track",
          );
        }
      } finally {
        setAddingTo(null);
      }
    },
    [addTracksToPlaylist, trackIds, onClose, showToast],
  );

  // ── Playlist rows ──

  /** Compact row for the recent section (name + plus icon only) */
  const CompactPlaylistRow = ({ playlist }: { playlist: Playlist }) => {
    const isAdding = addingTo === playlist.uuid;
    const isAdded = addedTo.has(playlist.uuid);

    return (
      <button
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-th-hl-faint transition-colors text-left group/row"
        onClick={() => handleAddToPlaylist(playlist)}
        disabled={isAdding || isAdded}
      >
        <span className="text-[14px] text-th-text-secondary truncate pr-3 group-hover/row:text-th-text-primary transition-colors">
          {playlist.title}
        </span>
        <div className="shrink-0 w-5 flex items-center justify-center">
          {isAdding ? (
            <Loader2 size={16} className="text-th-text-muted animate-spin" />
          ) : isAdded ? (
            <span className="text-th-accent text-[11px] font-semibold">
              Added
            </span>
          ) : (
            <Plus
              size={18}
              className="text-th-text-faint group-hover/row:text-th-text-primary transition-colors"
            />
          )}
        </div>
      </button>
    );
  };

  /** Rich row for the "show all" view (image + title + track count + plus icon) */
  const DetailedPlaylistRow = ({ playlist }: { playlist: Playlist }) => {
    const isAdding = addingTo === playlist.uuid;
    const isAdded = addedTo.has(playlist.uuid);

    return (
      <button
        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-th-hl-faint transition-colors text-left group/row"
        onClick={() => handleAddToPlaylist(playlist)}
        disabled={isAdding || isAdded}
      >
        {/* Thumbnail */}
        <div className="w-10 h-10 shrink-0 rounded bg-th-surface-hover overflow-hidden">
          <TidalImage
            src={getTidalImageUrl(playlist.image, 160)}
            alt={playlist.title}
            type="playlist"
            className="w-full h-full"
          />
        </div>

        {/* Title + track count */}
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-[14px] text-th-text-secondary truncate group-hover/row:text-th-text-primary transition-colors leading-snug">
            {playlist.title}
          </span>
          <span className="text-[12px] text-th-text-faint leading-snug">
            {playlist.numberOfTracks != null
              ? `${playlist.numberOfTracks} track${playlist.numberOfTracks !== 1 ? "s" : ""}`
              : "Playlist"}
          </span>
        </div>

        {/* Action */}
        <div className="shrink-0 w-5 flex items-center justify-center">
          {isAdding ? (
            <Loader2 size={16} className="text-th-text-muted animate-spin" />
          ) : isAdded ? (
            <span className="text-th-accent text-[11px] font-semibold">
              Added
            </span>
          ) : (
            <Plus
              size={18}
              className="text-th-text-faint group-hover/row:text-th-text-primary transition-colors"
            />
          )}
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
                  placeholder="Find a playlist"
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
              {filteredPlaylists.length === 0 ? (
                <div className="px-5 py-8 text-center text-[13px] text-th-text-disabled">
                  {searchQuery ? "No playlists found" : "No playlists yet"}
                </div>
              ) : (
                filteredPlaylists.map((p) => (
                  <DetailedPlaylistRow key={p.uuid} playlist={p} />
                ))
              )}
            </div>
          </>
        ) : (
          /* ── Default view ── */
          <>
            {/* Create new playlist */}
            <button
              className="w-full flex items-center gap-3 px-5 py-4 hover:bg-th-hl-faint transition-colors"
              onClick={() => setShowCreateModal(true)}
            >
              <div className="w-8 h-8 rounded-full bg-th-inset flex items-center justify-center shrink-0">
                <Plus size={18} className="text-th-text-primary" />
              </div>
              <span className="text-[15px] text-th-text-primary font-medium">
                Create new playlist
              </span>
            </button>

            {/* Show all playlists */}
            <button
              className="w-full flex items-center gap-3 px-5 py-3 hover:bg-th-hl-faint transition-colors"
              onClick={() => setShowAll(true)}
            >
              <span className="text-[14px] text-th-text-muted hover:text-th-text-primary transition-colors">
                Show all playlists
              </span>
            </button>

            {/* RECENT section */}
            {recentPlaylists.length > 0 ? (
              <div className="flex flex-col mt-1">
                <div className="px-5 pt-2 pb-1">
                  <span className="text-[11px] font-bold text-th-text-muted uppercase tracking-[0.12em]">
                    Recent
                  </span>
                </div>
                <div className="overflow-y-auto custom-scrollbar max-h-[240px] pb-2">
                  {recentPlaylists.map((p) => (
                    <CompactPlaylistRow key={p.uuid} playlist={p} />
                  ))}
                </div>
              </div>
            ) : userPlaylists.length > 0 ? (
              <div className="flex flex-col mt-1">
                <div className="px-5 pt-2 pb-1">
                  <span className="text-[11px] font-bold text-th-text-muted uppercase tracking-[0.12em]">
                    Recent
                  </span>
                </div>
                <div className="overflow-y-auto custom-scrollbar max-h-[240px] pb-2">
                  {userPlaylists.slice(0, MAX_RECENT).map((p) => (
                    <CompactPlaylistRow key={p.uuid} playlist={p} />
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}

        {/* Error bar */}
        {error && (
          <div className="px-5 py-2.5 bg-th-error/10 border-t border-th-error/20">
            <span className="text-[12px] text-th-error">{error}</span>
          </div>
        )}
      </div>

      {/* Create playlist modal (portal-like, rendered above everything) */}
      {showCreateModal && (
        <CreatePlaylistModal
          trackIds={trackIds}
          onClose={() => setShowCreateModal(false)}
          onCreated={(playlist) => {
            setAddedToFolder((prev) => {
              const next = new Map(prev);
              const list = next.get("root") ?? [];
              next.set("root", [...list, {
                kind: "playlist" as const,
                data: { ...playlist, numberOfTracks: trackIds.length },
              }]);
              return next;
            });
            setShowCreateModal(false);
            onClose();
          }}
        />
      )}
    </MenuPortal>
  );
}
