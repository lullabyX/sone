import { invoke } from "@tauri-apps/api/core";

export interface LocalTrackRaw {
  id: number;
  file_path: string;
  title: string;
  artist: string | null;
  album: string | null;
  duration: number;
  track_number: number | null;
  bit_depth: number | null;
  sample_rate: number | null;
  codec: string | null;
  cover_art_mime: string | null;
  cover_art_base64: string | null;
}

export async function pickLocalFolder(): Promise<string | null> {
  return invoke<string | null>("pick_local_folder");
}

export async function scanLocalFolder(path: string): Promise<LocalTrackRaw[]> {
  return invoke<LocalTrackRaw[]>("scan_local_folder", { path });
}

export async function getLocalCoverArt(path: string): Promise<string | null> {
  return invoke<string | null>("get_local_cover_art", { path });
}

export async function getWatchedFolders(): Promise<string[]> {
  return invoke<string[]>("get_watched_folders");
}

export async function setWatchedFolders(folders: string[]): Promise<void> {
  return invoke("set_watched_folders", { payload: { folders } });
}

export async function playLocalFile(
  path: string,
  fileId: number,
): Promise<void> {
  return invoke("play_local_file", { path, fileId });
}

export async function setNextLocalFile(
  path: string,
  fileId: number,
  qid: string,
): Promise<void> {
  return invoke("set_next_local_file", { path, fileId, qid });
}

export async function loadLocalTracks(): Promise<LocalTrackRaw[]> {
  return invoke<LocalTrackRaw[]>("load_local_tracks");
}

export async function saveLocalTracks(
  tracks: LocalTrackRaw[],
): Promise<void> {
  return invoke("save_local_tracks", { tracks });
}

export async function deltaScan(): Promise<LocalTrackRaw[]> {
  return invoke<LocalTrackRaw[]>("delta_scan");
}
