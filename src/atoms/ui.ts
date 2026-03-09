import { atom } from "jotai";

export const drawerOpenAtom = atom(false);
export const drawerTabAtom = atom<string>("queue");
export const maximizedPlayerAtom = atom(false);
