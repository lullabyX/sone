import { atom } from "jotai";
import type { DownloadItem, DownloadJob, DownloadQueueEntry } from "../types";

export const downloadQueueAtom = atom<DownloadQueueEntry[]>([]);
export const downloadItemsAtom = atom<Record<string, DownloadItem>>({});
export const downloadJobAtom = atom<DownloadJob>({ status: "idle" });
export const downloadDrawerOpenAtom = atom(false);
