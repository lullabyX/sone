import { Download, Trash2, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import {
  downloadDrawerOpenAtom,
  downloadItemsAtom,
  downloadJobAtom,
  downloadQueueAtom,
} from "../atoms/downloads";
import { checkTiddl, startDownloadJob } from "../api/tidal";

type EventPayload = Record<string, any>;

export default function DownloadQueueDrawer() {
  const [openDrawer, setOpenDrawer] = useAtom(downloadDrawerOpenAtom);
  const [queue, setQueue] = useAtom(downloadQueueAtom);
  const [items, setItems] = useAtom(downloadItemsAtom);
  const [job, setJob] = useAtom(downloadJobAtom);
  const [error, setError] = useState<string | null>(null);
  const [eventsReady, setEventsReady] = useState(false);
  const running = job.status === "checking" || job.status === "choosing-folder" || job.status === "downloading";
  const progressItems = Object.values(items);
  const completedItemCount = progressItems.filter((item) => ["success", "skipped", "error"].includes(item.status)).length;
  const remainingItemCount = progressItems.length - completedItemCount;

  useEffect(() => {
    if (!openDrawer) return;
    let active = true;
    setEventsReady(false);
    const event = (name: string, callback: (payload: EventPayload) => void) =>
      listen<EventPayload>(name, ({ payload }) => callback(payload));
    const listeners = [
      event("download:item-discovered", (payload) => {
        const item = payload.item ?? {};
        if (!item.item_instance_id) return;
        setItems((current) => ({ ...current, [item.item_instance_id]: { itemInstanceId: item.item_instance_id, title: item.title ?? "Unknown item", artist: item.artist ?? undefined, itemType: item.type, status: "discovering" } }));
      }),
      event("download:item-started", (payload) => setItems((current) => ({ ...current, [payload.item_instance_id]: { ...current[payload.item_instance_id], itemInstanceId: payload.item_instance_id, title: payload.title ?? current[payload.item_instance_id]?.title ?? "Unknown item", status: "downloading", outputPath: payload.output_path } }))),
      event("download:item-progress", (payload) => setItems((current) => ({ ...current, [payload.item_instance_id]: { ...current[payload.item_instance_id], itemInstanceId: payload.item_instance_id, title: current[payload.item_instance_id]?.title ?? "Unknown item", status: "downloading", bytesDownloaded: payload.bytes_downloaded, bytesTotal: payload.bytes_total, progress: payload.progress } }))),
      event("download:item-completed", (payload) => setItems((current) => ({ ...current, [payload.item_instance_id]: { ...current[payload.item_instance_id], itemInstanceId: payload.item_instance_id, title: payload.title ?? current[payload.item_instance_id]?.title ?? "Unknown item", status: "success", outputPath: payload.output_path } }))),
      event("download:item-skipped", (payload) => setItems((current) => ({ ...current, [payload.item_instance_id]: { ...current[payload.item_instance_id], itemInstanceId: payload.item_instance_id, title: payload.title ?? current[payload.item_instance_id]?.title ?? "Unknown item", status: "skipped", outputPath: payload.output_path } }))),
      event("download:item-failed", (payload) => setItems((current) => ({ ...current, [payload.item_instance_id]: { ...current[payload.item_instance_id], itemInstanceId: payload.item_instance_id, title: payload.title ?? current[payload.item_instance_id]?.title ?? "Unknown item", status: "error", error: payload.error?.message } }))),
      event("download:job-failed", (payload) => { setJob((current) => ({ ...current, status: "failed", error: payload.error?.message ?? "Download failed" })); }),
      event("download:job-completed", (payload) => { if (payload.success) setJob((current) => ({ ...current, status: "complete" })); }),
    ];
    void Promise.all(listeners).then(() => {
      if (active) setEventsReady(true);
    });
    return () => {
      active = false;
      setEventsReady(false);
      listeners.forEach((listener) => listener.then((unlisten) => unlisten()));
    };
  }, [openDrawer, setItems, setJob]);

  const start = async () => {
    if (queue.length === 0 || running || !eventsReady) return;
    setError(null);
    setJob({ status: "checking" });
    try {
      await checkTiddl();
      setJob({ status: "choosing-folder" });
      const destination = await open({ directory: true, multiple: false, title: "Choose download folder" });
      if (!destination || Array.isArray(destination)) {
        setJob({ status: "idle" });
        return;
      }
      setItems({});
      setJob({ status: "downloading", destination });
      await startDownloadJob(destination, queue);
    } catch (reason) {
      const message = reason instanceof Error
        ? reason.message
        : typeof reason === "string"
          ? reason
          : "Could not start tiddl. Install tiddl-headless and run `tiddl auth login`.";
      setError(message);
      setJob({ status: "failed", error: message });
    }
  };

  const clear = () => {
    setQueue([]);
    setItems({});
    setJob({ status: "idle" });
    setError(null);
  };

  if (!openDrawer) return null;
  return (
    <div className="fixed inset-0 bottom-[90px] z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/80" onClick={() => setOpenDrawer(false)} />
      <aside className="relative w-full max-w-[480px] bg-th-base border-l border-th-border-subtle shadow-2xl flex flex-col">
        <header className="px-6 py-5 flex items-center justify-between border-b border-th-border-subtle">
          <div><h2 className="text-lg font-bold">Download queue</h2><p className="text-xs text-th-text-muted">tiddl-headless downloads to your selected folder</p></div>
          <button onClick={() => setOpenDrawer(false)} className="text-th-text-muted hover:text-th-text-primary" title="Close download queue"><X size={20} /></button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5 custom-scrollbar">
          {error && <p className="rounded-md bg-th-error/15 text-th-error px-3 py-2 text-sm">{error}</p>}
          {job.error && job.error !== error && <p className="rounded-md bg-th-error/15 text-th-error px-3 py-2 text-sm">{job.error}</p>}
          <section><h3 className="text-xs font-bold uppercase tracking-wider text-th-text-muted mb-2">Queued resources</h3>
            {queue.length === 0 ? <p className="py-10 text-center text-sm text-th-text-disabled">No downloads queued</p> : queue.map((entry) => <div key={entry.id} className="py-2 border-b border-th-border-subtle"><p className="text-sm font-medium truncate">{entry.title}</p><p className="text-xs text-th-text-muted capitalize">{entry.sourceType}{entry.subtitle ? ` · ${entry.subtitle}` : ""}</p>{entry.previewStatus === "loading" && <p className="mt-1 text-xs text-th-text-disabled">Loading tracks...</p>}{entry.previewStatus === "error" && <p className="mt-1 text-xs text-th-error">Could not load the track list. tiddl will still resolve this resource.</p>}{entry.previewItems && <div className="mt-2 ml-2 border-l border-th-border-subtle pl-3 space-y-1">{entry.previewItems.map((track, index) => <p key={`${track.id}-${index}`} className="text-xs text-th-text-muted truncate">{track.title}{track.artist?.name ? ` · ${track.artist.name}` : ""}</p>)}</div>}</div>)}
          </section>
          {progressItems.length > 0 && <section><h3 className="text-xs font-bold uppercase tracking-wider text-th-text-muted mb-2">Download progress</h3><p className="mb-2 text-xs text-th-text-muted">{completedItemCount} of {progressItems.length} complete{running && ` · ${remainingItemCount} remaining`}</p>{progressItems.map((item) => <div key={item.itemInstanceId} className="py-2 border-b border-th-border-subtle"><div className="flex justify-between gap-3"><p className="text-sm truncate">{item.title}</p><span className="text-xs capitalize text-th-text-muted">{item.status}</span></div>{item.progress != null && <div className="mt-1 h-1 rounded bg-th-slider-track"><div className="h-full rounded bg-th-accent" style={{ width: `${item.progress * 100}%` }} /></div>}{item.outputPath && <p className="mt-1 text-xs text-th-text-muted break-all">{item.outputPath}</p>}{item.error && <p className="text-xs text-th-error mt-1">{item.error}</p>}</div>)}</section>}
        </div>
        <footer className="px-6 py-4 border-t border-th-border-subtle flex gap-3">
          <button onClick={start} disabled={queue.length === 0 || running || !eventsReady} className="flex-1 flex items-center justify-center gap-2 rounded-full bg-th-accent text-th-on-accent py-2.5 text-sm font-bold disabled:opacity-50"><Download size={16} />{running ? "Downloading..." : "Download"}</button>
          <button onClick={clear} disabled={running || queue.length === 0} className="flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm text-th-text-secondary hover:bg-th-hl-med disabled:opacity-50" title="Clear download queue"><Trash2 size={16} />Clear</button>
        </footer>
      </aside>
    </div>
  );
}
