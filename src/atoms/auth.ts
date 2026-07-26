import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { AuthTokens } from "../types";

export const isAuthenticatedAtom = atom(false);
export const isAuthCheckingAtom = atom(true); // true until load_saved_auth resolves
export const authTokensAtom = atom<AuthTokens | null>(null);
export const userNameAtom = atom("TIDAL User");
export const currentUserAvatarAtom = atom<string | null>(null);
export const localOnlyAtom = atomWithStorage(
  "sone.localOnly.v1",
  false,
  undefined,
  { getOnInit: true },
);
