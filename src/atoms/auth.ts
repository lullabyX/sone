import { atom } from "jotai";
import type { AuthTokens } from "../types";

export const isAuthenticatedAtom = atom(false);
export const isAuthCheckingAtom = atom(true); // true until load_saved_auth resolves
export const authTokensAtom = atom<AuthTokens | null>(null);
export const userNameAtom = atom("TIDAL User");
