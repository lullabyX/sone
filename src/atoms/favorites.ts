import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { AlbumDetail, ArtistDetail, FavoriteMix } from "../types";

export const favoriteTrackIdsAtom = atom<Set<number>>(new Set<number>());
export const favoriteAlbumIdsAtom = atom<Set<number>>(new Set<number>());
export const favoritePlaylistUuidsAtom = atom<Set<string>>(new Set<string>());
export const followedArtistIdsAtom = atom<Set<number>>(new Set<number>());
export const favoriteMixIdsAtom = atom<Set<string>>(new Set<string>());
export const optimisticFavoriteAlbumsAtom = atom<AlbumDetail[]>([]);
export const optimisticFollowedArtistsAtom = atom<ArtistDetail[]>([]);
export const optimisticFavoriteMixesAtom = atom<FavoriteMix[]>([]);

export type SortOrder = { order: string; direction: string };

const makeSortAtom = (key: string, defaultOrder: string = "DATE") =>
  atomWithStorage<SortOrder>(key, { order: defaultOrder, direction: "DESC" });

export const albumSortAtom = makeSortAtom("sone.albumSort.v1");
export const artistSortAtom = makeSortAtom("sone.artistSort.v1");
export const mixSortAtom = makeSortAtom("sone.mixSort.v1");
export const playlistSortAtom = makeSortAtom(
  "sone.playlistSort.v1",
  "DATE_UPDATED",
);
