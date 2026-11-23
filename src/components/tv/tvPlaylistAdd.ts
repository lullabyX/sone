import { useCallback } from "react";
import { ListPlus, X } from "lucide-react";
import { useToast } from "../../contexts/ToastContext";
import { type OnDupes, usePlaylists } from "../../hooks/usePlaylists";
import type { Track } from "../../types";
import type { TvMenuSpec } from "./tvMenu";
import { queuePlaylistEdit } from "./tvPlaylistEdits";

/** Names in menu titles and toasts, cut at 32 characters. */
export const menuLabel = (text: string) =>
  text.length > 32 ? `${text.slice(0, 30)}…` : text;

/**
 * Adding a track to a playlist from the TV: behind the playlist's other
 * writes (an open page's removals), marking its pages out of date. As on
 * the desktop, a track already in the playlist is skipped; the choice to add
 * it anyway is a menu, since a toast's button can't be reached by remote.
 */
export function useTvPlaylistAdd(openMenu: (spec: TvMenuSpec) => void) {
  const { addTracksToPlaylist } = usePlaylists();
  const { showToast } = useToast();

  /** Resolves false when the track was already there and skipped. */
  const addToPlaylist = useCallback(
    async (uuid: string, trackId: number, onDupes: OnDupes = "SKIP") => {
      let added: number[] = [];
      await queuePlaylistEdit(uuid, async () => {
        added = await addTracksToPlaylist(uuid, [trackId], onDupes);
      });
      return added.length > 0;
    },
    [addTracksToPlaylist],
  );

  /** Adds `track`; when it is already in `playlist`, opens the "Already in"
   *  menu instead and resolves false. Rejects when the add failed. */
  const addOrOffer = useCallback(
    async (playlist: { uuid: string; title: string }, track: Track) => {
      if (await addToPlaylist(playlist.uuid, track.id)) return true;
      const name = menuLabel(playlist.title);
      openMenu({
        title: `Already in "${name}"`,
        subtitle: track.title,
        items: [
          {
            label: "Add anyway",
            icon: ListPlus,
            onSelect: async () => {
              try {
                await addToPlaylist(playlist.uuid, track.id, "ADD");
                showToast(`Added to "${name}" again`);
              } catch {
                showToast("Couldn't add to playlist", "error");
              }
            },
          },
          { label: "Cancel", icon: X, onSelect: () => {} },
        ],
      });
      return false;
    },
    [addToPlaylist, openMenu, showToast],
  );

  return { addToPlaylist, addOrOffer };
}
