import {
  FolderOpen,
  Plus,
  RefreshCw,
  Trash2,
  Music,
} from "lucide-react";
import { useState, useEffect, useCallback, useRef } from "react";
import { useAtom } from "jotai";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { usePlaybackActions } from "../hooks/usePlaybackActions";
import {
  pickLocalFolder,
  scanLocalFolder,
  getWatchedFolders,
  setWatchedFolders,
  loadLocalTracks,
  saveLocalTracks,
  deltaScan,
  type LocalTrackRaw,
} from "../api/localMusic";
import type { Track } from "../types";
import { watchedFoldersAtom, localTracksAtom, localMusicLoadingAtom } from "../atoms/localMusic";
import TrackList from "./TrackList";
import PageContainer from "./PageContainer";
import { useToast } from "../contexts/ToastContext";

function rawToTrack(raw: LocalTrackRaw): Track {
  return {
    id: raw.id,
    title: raw.title,
    artist: raw.artist
      ? { id: 0, name: raw.artist, artistType: "ARTIST" }
      : undefined,
    album: raw.album
      ? { id: 0, title: raw.album }
      : undefined,
    duration: raw.duration,
    trackNumber: raw.track_number ?? undefined,
    bitDepth: raw.bit_depth ?? undefined,
    sampleRate: raw.sample_rate ?? undefined,
    audioCodec: raw.codec ?? undefined,
    source: "local",
    filePath: raw.file_path,
    localCoverBase64: raw.cover_art_base64 ?? undefined,
    audioQuality: raw.codec ?? undefined,
    streamReady: true,
    allowStreaming: true,
  };
}

export default function LocalMusicView() {
  const { playTrack, playAllFromSource } = usePlaybackActions();
  const { showToast } = useToast();
  const [folders, setFolders] = useAtom(watchedFoldersAtom);
  const [tracks, setTracks] = useAtom(localTracksAtom);
  const [, setLoading] = useAtom(localMusicLoadingAtom);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanTotal, setScanTotal] = useState(0);
  const [scanCurrent, setScanCurrent] = useState(0);
  const [scanCurrentPath, setScanCurrentPath] = useState("");
  const unlistenRef = useRef<UnlistenFn[]>([]);

  useEffect(() => {
    let active = true;
    const regs: UnlistenFn[] = [];

    Promise.all([
      listen<number>("local-music:scan-start", (e) => {
        if (!active) return;
        setScanTotal(e.payload);
        setScanCurrent(0);
        setScanning(true);
        setLoading(true);
        setError(null);
      }),
      listen<{ index: number; path: string }>(
        "local-music:scan-progress",
        (e) => {
          if (!active) return;
          setScanCurrent(e.payload.index);
          setScanCurrentPath(e.payload.path);
        },
      ),
      listen<number>("local-music:scan-complete", (e) => {
        if (!active) return;
        setScanCurrent(e.payload);
        setScanTotal(e.payload);
        setScanning(false);
        setLoading(false);
      }),
    ]).then(([u1, u2, u3]) => {
      regs.push(u1, u2, u3);
    });

    unlistenRef.current = regs;
    return () => {
      active = false;
      regs.forEach((u) => u());
    };
  }, []);

  // Instant restore from disk → background delta sync
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // 1. Load cached tracks instantly
        const cached = await loadLocalTracks();
        if (cancelled) return;
        const tracks = cached.map(rawToTrack);
        if (tracks.length > 0) {
          setTracks(tracks);
        }
      } catch {
        // cache miss or corrupted — delta scan will rebuild
      }

      // 2. Background delta sync (non-blocking, fires
      //    local-music:scan-progress + scan-complete events)
      try {
        const updated = await deltaScan();
        if (cancelled) return;
        const tracks = updated.map(rawToTrack);
        setTracks(tracks);
      } catch {
        // delta scan failed — user can manually rescan
      }
    })();

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let active = true;
    getWatchedFolders()
      .then((f) => {
        if (active && f.length > 0) setFolders(f);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const scanAllFolders = useCallback(async () => {
    const toScan = folders.length > 0 ? folders : [];
    if (toScan.length === 0) {
      showToast("Add a music folder first", "info");
      return;
    }
    const allTracks: Track[] = [];
    const allRaw: LocalTrackRaw[] = [];
    for (const folder of toScan) {
      try {
        const raw = await scanLocalFolder(folder);
        allRaw.push(...raw);
        for (const r of raw) {
          allTracks.push(rawToTrack(r));
        }
      } catch (e: any) {
        setError(`Failed to scan ${folder}: ${e}`);
      }
    }
    setTracks(allTracks);
    saveLocalTracks(allRaw).catch(() => {});
  }, [folders, setTracks, showToast]);

  const handleAddFolder = useCallback(async () => {
    const folder = await pickLocalFolder();
    if (!folder) return;
    const withoutDupe = folders.filter((f) => f !== folder);
    const updated = [...withoutDupe, folder];
    setFolders(updated);
    try {
      await setWatchedFolders(updated);
      const raw = await scanLocalFolder(folder);
      const newTracks = raw.map(rawToTrack);
      setTracks((prev) => {
        const existing = new Set(prev.map((t) => t.filePath));
        const added = newTracks.filter((t) => !existing.has(t.filePath!));
        return [...prev, ...added];
      });
      // Persist full list after merge
      const prev = await loadLocalTracks();
      const merged = [...prev.filter((t) => !t.file_path.startsWith(folder)), ...raw];
      saveLocalTracks(merged).catch(() => {});
    } catch (e: any) {
      showToast(`Failed to scan: ${e}`, "error");
    }
  }, [folders, setFolders, setTracks, showToast]);

  const handleRemoveFolder = useCallback((folder: string) => {
    const updated = folders.filter((f) => f !== folder);
    setFolders(updated);
    setWatchedFolders(updated).catch(() => {});
    setTracks((prev) =>
      prev.filter((t) => {
        const fp = t.filePath ?? "";
        return !fp.startsWith(folder);
      }),
    );
  }, [folders, setFolders, setTracks]);

  const handlePlayTrack = useCallback(
    (track: Track, _index: number) => {
      playTrack(track);
    },
    [playTrack],
  );

  const handlePlayAll = useCallback(() => {
    if (tracks.length > 0) {
      playAllFromSource(
        tracks.map((t) => ({ ...t, _qid: t._qid ?? `local-${t.id}` })),
        {
          source: {
            type: "local",
            id: "local-music",
            name: "Local Music",
            allTracks: tracks,
          },
        },
      );
    }
  }, [tracks, playAllFromSource]);

  return (
    <PageContainer>
      <div className="flex flex-col gap-4 px-4 pt-4">
        {/* Header */}
        <div className="flex items-center gap-4">
          <div className="flex h-48 w-48 items-center justify-center rounded-lg bg-th-surface">
            <Music size={64} className="text-th-accent/60" />
          </div>
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-bold text-th-text">Local Music</h1>
            <p className="text-sm text-th-subtitle">
              {tracks.length > 0
                ? `${tracks.length} track${tracks.length !== 1 ? "s" : ""} from ${folders.length} folder${folders.length !== 1 ? "s" : ""}`
                : "Import music from your hard drive"}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={handlePlayAll}
                disabled={tracks.length === 0}
                className="flex items-center gap-2 rounded-full bg-th-accent px-6 py-2 text-sm font-semibold text-th-accent-text transition hover:brightness-110 disabled:opacity-40"
              >
                <Music size={16} />
                Play All
              </button>
              <button
                onClick={scanAllFolders}
                disabled={scanning || folders.length === 0}
                className="flex items-center gap-2 rounded-full border border-th-border px-6 py-2 text-sm font-semibold text-th-text transition hover:bg-th-surface disabled:opacity-40"
              >
                <RefreshCw
                  size={16}
                  className={scanning ? "animate-spin" : ""}
                />
                Rescan
              </button>
            </div>
          </div>
        </div>

        {/* Folder management */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-th-text">
              Watched Folders
            </h2>
            <button
              onClick={handleAddFolder}
              className="flex items-center gap-1 rounded-full bg-th-accent/10 px-3 py-1 text-xs font-medium text-th-accent transition hover:bg-th-accent/20"
            >
              <Plus size={14} />
              Add Folder
            </button>
          </div>
          {folders.length === 0 && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-th-border py-10 text-th-subtitle">
              <FolderOpen size={40} className="opacity-40" />
              <p className="text-sm">No folders added yet</p>
              <button
                onClick={handleAddFolder}
                className="rounded-full bg-th-accent px-4 py-1.5 text-sm font-medium text-th-accent-text transition hover:brightness-110"
              >
                Add Music Folder
              </button>
            </div>
          )}
          {folders.map((folder) => (
            <div
              key={folder}
              className="flex items-center gap-2 rounded-lg border border-th-border bg-th-background px-3 py-2 text-sm"
            >
              <FolderOpen size={16} className="text-th-accent/60 shrink-0" />
              <span className="flex-1 truncate text-th-text">{folder}</span>
              <button
                onClick={() => handleRemoveFolder(folder)}
                className="rounded p-1 text-th-subtitle transition hover:text-red-400 hover:bg-th-surface"
                title="Remove folder"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>

        {/* Error banner */}
        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Scan progress */}
        {scanning && (
          <div className="flex flex-col gap-3 py-6">
            <div className="flex items-center justify-between text-sm text-th-subtitle">
              <span>
                Scanning files{" "}
                {scanTotal > 0
                  ? `(${scanCurrent} / ${scanTotal})`
                  : ""}
              </span>
              {scanTotal > 0 && (
                <span>
                  {Math.round((scanCurrent / scanTotal) * 100)}%
                </span>
              )}
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-th-surface">
              <div
                className="h-full rounded-full bg-th-accent transition-all duration-200"
                style={{
                  width: `${scanTotal > 0 ? (scanCurrent / scanTotal) * 100 : 0}%`,
                }}
              />
            </div>
            {scanCurrentPath && (
              <p className="truncate text-xs text-th-text-disabled">
                {scanCurrentPath}
              </p>
            )}
          </div>
        )}

        {!scanning && tracks.length === 0 && folders.length > 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-th-subtitle">
            <Music size={32} className="opacity-40" />
            <p className="text-sm">No supported music files found</p>
            <p className="text-xs opacity-60">
              Supported formats: FLAC, MP3
            </p>
          </div>
        )}

        {tracks.length > 0 && (
          <div className="flex flex-col">
            <TrackList
              tracks={tracks}
              onPlay={handlePlayTrack}
              showAlbum
              showCover
              showArtist
              context="favorites"
            />
          </div>
        )}
      </div>
    </PageContainer>
  );
}
