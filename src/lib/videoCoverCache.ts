import { invoke } from "@tauri-apps/api/core";

// WebKitGTK re-downloads a remote <video loop> on every wrap, stalling the
// loop. Holding the bytes as a blob makes the wrap an in-memory seek.

const MAX_BYTES = 96 * 1024 * 1024;

interface Entry {
  promise: Promise<string>;
  url?: string;
  size: number;
  refs: number;
  lastUsed: number;
}

const entries = new Map<string, Entry>();
let totalBytes = 0;
let clock = 0;

function evict() {
  if (totalBytes <= MAX_BYTES) return;
  const idle = [...entries.entries()]
    .filter(([, e]) => e.refs === 0 && e.url)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [key, e] of idle) {
    if (totalBytes <= MAX_BYTES) break;
    URL.revokeObjectURL(e.url!);
    totalBytes -= e.size;
    entries.delete(key);
  }
}

/** Resolve a blob URL for `src`; pair every call with `releaseVideoCover`. */
export function acquireVideoCover(src: string): Promise<string> {
  const existing = entries.get(src);
  if (existing) {
    existing.refs++;
    existing.lastUsed = ++clock;
    return existing.promise;
  }
  const entry: Entry = {
    refs: 1,
    size: 0,
    lastUsed: ++clock,
    promise: Promise.resolve(
      invoke<ArrayBuffer>("get_video_cover_bytes", { url: src }),
    ).then(
      (buf) => {
        const url = URL.createObjectURL(new Blob([buf], { type: "video/mp4" }));
        entry.url = url;
        entry.size = buf.byteLength;
        totalBytes += entry.size;
        evict();
        return url;
      },
      (err) => {
        entries.delete(src);
        throw err;
      },
    ),
  };
  entries.set(src, entry);
  return entry.promise;
}

export function releaseVideoCover(src: string): void {
  const e = entries.get(src);
  if (!e) return;
  e.refs = Math.max(0, e.refs - 1);
  e.lastUsed = ++clock;
  evict();
}

export function _resetVideoCoverCache(): void {
  for (const e of entries.values()) if (e.url) URL.revokeObjectURL(e.url);
  entries.clear();
  totalBytes = 0;
}
