import { memo, useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ListMusic, Play, User } from "lucide-react";

// In-memory blob URL cache — size-based LRU (50 MB) with revokeObjectURL on eviction.
const MAX_BLOB_BYTES = 200 * 1024 * 1024; // 200 MB
let blobTotalBytes = 0;
let blobAccessCounter = 0;

interface BlobEntry {
  url: string;
  size: number;
  accessOrder: number;
}

const blobCache = new Map<string, BlobEntry>();

function evictBlobsIfNeeded(requiredBytes: number): void {
  if (blobTotalBytes + requiredBytes <= MAX_BLOB_BYTES) return;
  const entries = [...blobCache.entries()].sort(
    (a, b) => a[1].accessOrder - b[1].accessOrder,
  );
  const target = MAX_BLOB_BYTES * 0.9;
  for (const [key, entry] of entries) {
    if (blobTotalBytes + requiredBytes <= target) break;
    URL.revokeObjectURL(entry.url);
    blobTotalBytes -= entry.size;
    blobCache.delete(key);
  }
}

const inflight = new Map<string, Promise<string>>();

export function fetchCachedImageUrl(src: string): Promise<string> {
  const entry = blobCache.get(src);
  if (entry) {
    entry.accessOrder = ++blobAccessCounter;
    return Promise.resolve(entry.url);
  }

  const existing = inflight.get(src);
  if (existing) return existing;

  const promise = invoke<ArrayBuffer>("get_image_bytes", { url: src })
    .then((buffer) => {
      const arr = new Uint8Array(buffer);
      const blob = new Blob([arr], { type: "image/jpeg" });
      const blobUrl = URL.createObjectURL(blob);
      const size = arr.byteLength;
      evictBlobsIfNeeded(size);
      blobCache.set(src, {
        url: blobUrl,
        size,
        accessOrder: ++blobAccessCounter,
      });
      blobTotalBytes += size;
      inflight.delete(src);
      return blobUrl;
    })
    .catch((err) => {
      inflight.delete(src);
      throw err;
    });

  inflight.set(src, promise);
  return promise;
}

interface TidalImageProps {
  src: string | undefined;
  alt: string;
  className?: string;
  type?: "album" | "playlist" | "artist";
  onLoad?: () => void;
}

function TidalImageComponent({
  src,
  alt,
  className = "",
  type = "album",
  onLoad,
}: TidalImageProps) {
  const [hasError, setHasError] = useState(false);
  // Synchronous cache check — if the blob is already in memory, skip loading entirely
  const [blobUrl, setBlobUrl] = useState<string | undefined>(() => {
    if (!src) return undefined;
    const entry = blobCache.get(src);
    if (entry) {
      entry.accessOrder = ++blobAccessCounter;
      return entry.url;
    }
    return undefined;
  });
  const [isLoading, setIsLoading] = useState(blobUrl === undefined);

  useEffect(() => {
    if (!src) return;

    // Sync cache hit — skip loading shimmer
    const cached = blobCache.get(src);
    if (cached) {
      cached.accessOrder = ++blobAccessCounter;
      setBlobUrl(cached.url);
      setIsLoading(false);
      setHasError(false);
      return;
    }

    // Not cached — fetch silently, keep old image visible until ready
    setHasError(false);

    let cancelled = false;
    fetchCachedImageUrl(src)
      .then((url) => {
        if (!cancelled) setBlobUrl(url);
      })
      .catch(() => {
        if (!cancelled) setHasError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [src]);

  if (!src || hasError) {
    return (
      <div
        className={`bg-gradient-to-br from-th-button to-th-surface flex items-center justify-center ${className}`}
      >
        {type === "playlist" ? (
          <Play size={24} className="text-gray-600" />
        ) : type === "artist" ? (
          <User size={24} className="text-gray-600" />
        ) : (
          <ListMusic size={24} className="text-gray-600" />
        )}
      </div>
    );
  }

  if (!blobUrl) {
    return (
      <div className={`relative ${className}`}>
        <div className="absolute inset-0 bg-th-surface-hover animate-pulse" />
      </div>
    );
  }

  return (
    <div className={`relative ${className}`}>
      {isLoading && (
        <div className="absolute inset-0 bg-th-surface-hover animate-pulse" />
      )}
      <img
        src={blobUrl}
        alt={alt}
        className={`w-full h-full object-cover ${
          isLoading ? "opacity-0" : "opacity-100"
        } transition-opacity`}
        onError={() => setHasError(true)}
        onLoad={() => { setIsLoading(false); onLoad?.(); }}
      />
    </div>
  );
}

const TidalImage = memo(TidalImageComponent);
TidalImage.displayName = "TidalImage";

export default TidalImage;

export function preloadImage(url: string): void {
  if (!url) return;
  fetchCachedImageUrl(url).catch(() => {});
}
