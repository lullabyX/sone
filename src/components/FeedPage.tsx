import { useState, useEffect, useMemo, type MouseEvent } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { MoreHorizontal, Music, Play } from "lucide-react";
import { getFeed, markFeedSeen } from "../api/tidal";
import { authTokensAtom } from "../atoms/auth";
import { feedUnseenCountAtom } from "../atoms/ui";
import { safeErrorMessage } from "../lib/errorUtils";
import { groupFeedByPeriod } from "../lib/feedGrouping";
import {
  buildMediaItem,
  getItemImage,
  getItemSubtitle,
  getItemTitle,
} from "../utils/itemHelpers";
import { useMediaPlay } from "../hooks/useMediaPlay";
import { useNavigation } from "../hooks/useNavigation";
import type { FeedItem, MediaItemType } from "../types";
import MediaContextMenu from "./MediaContextMenu";
import { MediaGridError, MediaGridEmpty } from "./MediaGrid";
import PageContainer from "./PageContainer";

/** Album rows read "Single by Artist" / "Album by Artist"; everything else
 *  falls back to the shared subtitle helper. */
function feedSubtitle(entry: FeedItem): string {
  if (entry.kind === "album") {
    const artists = Array.isArray(entry.item?.artists)
      ? (entry.item.artists as Array<{ name?: string }>)
          .map((a) => a.name)
          .filter(Boolean)
          .join(", ")
      : "";
    const rawType = typeof entry.item?.type === "string" ? entry.item.type : "";
    const label =
      rawType === "EP"
        ? "EP"
        : rawType.charAt(0) + rawType.slice(1).toLowerCase();
    if (label && artists) return `${label} by ${artists}`;
    if (artists) return artists;
  }
  return getItemSubtitle(entry.item);
}

function FeedRow({
  entry,
  menuOpen,
  onOpenMenu,
}: {
  entry: FeedItem;
  menuOpen: boolean;
  onOpenMenu: (item: MediaItemType, position: { x: number; y: number }) => void;
}) {
  const { navigateToMix, navigateToAlbum } = useNavigation();
  const playMedia = useMediaPlay();

  const image = getItemImage(entry.item, 160);
  const title = getItemTitle(entry.item);
  const subtitle = feedSubtitle(entry);
  const isInert = entry.kind === "unknown";

  // Drives playback and the context menu alike. Gated on `isInert` rather than
  // on a null return: `buildMediaItem` falls through to its `item.id &&
  // !isTrackItem` branch for an unrecognised payload and hands back a bogus
  // album, so the kind check is the only thing that keeps unknown rows inert.
  // The type hint keeps this deterministic: without it `buildMediaItem`
  // re-sniffs the payload via `isMixItem` (which keys on `mixType`), a
  // different signal from the `historyMix` payload key the backend derives
  // `kind` from. A mix arriving without `mixType` would otherwise fall into
  // the same album branch that already caught us on unknown rows.
  const mediaItem = useMemo(
    () =>
      isInert
        ? null
        : buildMediaItem(
            entry.item,
            entry.kind === "mix" ? "MIX_LIST" : "ALBUM_LIST",
          ),
    [isInert, entry.kind, entry.item],
  );

  const handleOpen = () => {
    if (entry.kind === "mix") {
      navigateToMix(String(entry.item.id), {
        title,
        image: image || undefined,
        subtitle,
        mixType: entry.item.mixType,
      });
    } else if (entry.kind === "album") {
      navigateToAlbum(Number(entry.item.id), {
        title,
        cover: entry.item.cover,
      });
    }
  };

  const handlePlay = (e: MouseEvent) => {
    e.stopPropagation();
    if (mediaItem) playMedia(mediaItem);
  };

  const openMenu = (e: MouseEvent) => {
    if (!mediaItem) return;
    e.preventDefault();
    e.stopPropagation();
    onOpenMenu(mediaItem, { x: e.clientX, y: e.clientY });
  };

  return (
    <div
      onClick={isInert ? undefined : handleOpen}
      onContextMenu={openMenu}
      className={`group flex items-center gap-4 px-2 py-2 rounded-md transition-colors duration-150 ${
        isInert ? "" : "cursor-pointer hover:bg-th-surface-hover"
      }`}
    >
      <div className="relative w-14 h-14 shrink-0 rounded-md overflow-hidden bg-th-surface-hover shadow">
        {image ? (
          <img
            src={image}
            alt={title}
            className="w-full h-full object-cover"
            loading="lazy"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-th-button to-th-surface">
            <Music size={20} className="text-th-text-faint" />
          </div>
        )}
        {!isInert && (
          <>
            <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity duration-200" />
            <button
              onClick={handlePlay}
              aria-label={`Play ${title}`}
              className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 cursor-pointer"
            >
              <Play size={20} fill="white" className="text-white ml-0.5" />
            </button>
          </>
        )}
      </div>

      {/* flex-1 so the trailing menu button is pushed to the far right */}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-th-text-primary truncate">
          {title}
        </div>
        {subtitle && (
          <div className="text-sm text-th-text-secondary truncate">
            {subtitle}
          </div>
        )}
      </div>

      {mediaItem && (
        <button
          onClick={openMenu}
          aria-label={`More options for ${title}`}
          title="More options"
          className={`shrink-0 p-1.5 rounded-full transition-colors cursor-pointer ${
            menuOpen
              ? "text-th-text-primary opacity-100"
              : "text-th-text-muted hover:text-th-text-primary opacity-0 group-hover:opacity-100"
          }`}
        >
          <MoreHorizontal size={18} />
        </button>
      )}
    </div>
  );
}

export default function FeedPage() {
  const userId = useAtomValue(authTokensAtom)?.user_id;
  const setUnseenCount = useSetAtom(feedUnseenCountAtom);

  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;

    let active = true;

    getFeed(userId)
      .then((feed) => {
        if (!active) return;
        setItems(feed.items);
        setError(null);
      })
      .catch((err) => {
        console.error("[FeedPage] Failed:", err);
        if (!active) return;
        setError(safeErrorMessage(err, "Failed to load feed"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [userId]);

  // Separate from the fetch: opening the page is what marks the feed seen, so
  // this must fire even when the list fails to load.
  useEffect(() => {
    if (!userId) return;
    setUnseenCount(0);
    markFeedSeen(userId).catch((err) =>
      console.error("[FeedPage] mark seen failed:", err),
    );
  }, [userId, setUnseenCount]);

  const groups = useMemo(() => groupFeedByPeriod(items, new Date()), [items]);

  // Held here, not in FeedRow: MediaContextMenu renders through a portal, and
  // React portals bubble events up the REACT tree. Nested inside a row, a click
  // dismissing one of its sub-modals (Add to playlist -> Create playlist ->
  // backdrop) would reach the row's onClick and navigate. Every other
  // MediaContextMenu call site renders at container level for the same reason.
  const [contextMenu, setContextMenu] = useState<{
    rowKey: string;
    item: MediaItemType;
    position: { x: number; y: number };
  } | null>(null);

  return (
    <div className="flex-1 bg-gradient-to-b from-th-surface to-th-base min-h-full">
      <PageContainer className="px-8 py-10">
        <h1 className="text-[32px] font-bold text-th-text-primary tracking-tight mb-10">
          Feed
        </h1>

        {error && <MediaGridError error={error} />}

        {!loading && !error && groups.length === 0 && (
          <MediaGridEmpty message="Nothing here yet" />
        )}

        {!error && groups.length > 0 && (
          <div className="space-y-8">
            {groups.map((group) => (
              <section key={group.label}>
                <h2 className="text-sm font-semibold text-th-text-secondary mb-3">
                  {group.label}
                </h2>
                <div className="space-y-1">
                  {group.items.map((entry, idx) => {
                    const rowKey = `${entry.occurredAt}-${entry.kind}-${idx}`;
                    return (
                      <FeedRow
                        key={rowKey}
                        entry={entry}
                        menuOpen={contextMenu?.rowKey === rowKey}
                        onOpenMenu={(item, position) =>
                          setContextMenu({ rowKey, item, position })
                        }
                      />
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </PageContainer>

      {contextMenu && (
        <MediaContextMenu
          item={contextMenu.item}
          cursorPosition={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
