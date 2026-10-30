import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useAtom, useAtomValue, useStore } from "jotai";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Heart,
  ListStart,
  ListX,
  Maximize2,
  Mic2,
  MoreHorizontal,
  Volume1,
  Volume2,
  VolumeX,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Trash2,
} from "lucide-react";
import TidalImage from "../TidalImage";
import SignalPathPanel from "../SignalPathPanel";
import TvNativeLayer from "./TvNativeLayer";
import {
  contextSourceAtom,
  currentTrackAtom,
  historyAtom,
  isPlayingAtom,
  manualQueueAtom,
  playbackSourceAtom,
  queueAtom,
  repeatAtom,
  shuffleAtom,
  streamInfoAtom,
  volumeAtom,
} from "../../atoms/playback";
import {
  currentVideoAtom,
  videoExpandedAtom,
  videoPlayingAtom,
} from "../../atoms/video";
import {
  tvLyricsAtom,
  tvNowPlayingTabAtom,
  type TvNowPlayingTab,
} from "../../atoms/tv";
import { useFavorites } from "../../hooks/useFavorites";
import { usePlaybackActions } from "../../hooks/usePlaybackActions";
import { useSuggestedTracks } from "../../hooks/useSuggestedTracks";
import { useTrackCredits } from "../../hooks/useTrackCredits";
import { useVolumeLocked } from "../../hooks/useVolumeLocked";
import { formatTime } from "../../lib/format";
import { getInterpolatedPosition } from "../../lib/playbackPosition";
import {
  getTidalImageUrl,
  getTrackDisplayTitle,
  type Credit,
  type Track,
} from "../../types";
import {
  formatStreamQuality,
  getTrackArtistDisplay,
  trackCoverId,
} from "../../utils/itemHelpers";
import { TvScreenContext, useTvInitialFocus, useTvNav } from "./TvNavContext";
import { focusElement, focusFirstIn } from "../../lib/spatialNav";
import { useToast } from "../../contexts/ToastContext";
import { TvButton, TvSpinner, TvTrackRow } from "./TvParts";
import type { TvMenuItem } from "./tvMenu";
import { moveInQueue, queueIndexOf } from "./tvQueue";
import { viewForSource } from "./tvItems";
import { TvLyricsPanel } from "./TvLyrics";
import { useTvLyrics } from "./useTvLyrics";
import { useTvMiniVideo, useTvVideoAspect } from "./useTvMiniVideo";
import { TV_SEEK_STEP_S, TV_VOLUME_STEP } from "./tvKeys";
import { useTvMediaCommands } from "./useTvMediaCommands";
import { useTvProgressive } from "./useTvProgressive";
import { useTvGrowOnFocus } from "./useTvGrowOnFocus";

/** The playing video's element (the video player's, wherever it is shown). */
function videoElement(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>("[role='dialog'] video");
}

/** Re-reads the playback position a few times a second while the screen is
 *  shown: the audio player's interpolated one, or a video's from its own
 *  element. */
function usePosition(video: boolean, active: boolean): number {
  const read = useCallback(
    () =>
      video ? (videoElement()?.currentTime ?? 0) : getInterpolatedPosition(),
    [video],
  );
  const [pos, setPos] = useState(read);
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setPos(read());
  }
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setPos(read()), 250);
    return () => clearInterval(id);
  }, [read, active]);
  return pos;
}

/** Volume bar: Left/Right change it in 5% steps, Enter mutes (once per
 *  press). Locked while bit-perfect audio plays, since the DAC must get
 *  unscaled samples; a video's volume stays adjustable. */
function VolumeControl() {
  const volume = useAtomValue(volumeAtom);
  const locked = useVolumeLocked();
  const media = useTvMediaCommands();
  const pct = Math.round(volume * 100);
  const Icon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  if (locked) {
    return (
      <span className="inline-flex items-center gap-[0.5rem] text-[0.75rem] text-th-text-muted">
        <Volume2 className="w-[1.1rem] h-[1.1rem]" />
        Volume fixed (bit-perfect)
      </span>
    );
  }

  const toggleMute = () => media({ kind: "mute" });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      media({
        kind: "volume",
        by: e.key === "ArrowLeft" ? -TV_VOLUME_STEP : TV_VOLUME_STEP,
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!e.repeat) toggleMute();
    }
  };

  return (
    <div
      data-tv-focusable
      tabIndex={0}
      role="slider"
      aria-label="Volume"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      onKeyDown={onKeyDown}
      onClick={toggleMute}
      className="tv-progress inline-flex items-center gap-[0.6rem] h-[2.6rem] px-[0.9rem] rounded-full bg-th-button outline-none"
    >
      <Icon className="w-[1.1rem] h-[1.1rem] text-th-text-primary shrink-0" />
      <span className="relative w-[7rem] h-[0.3rem] rounded-full bg-th-slider-track">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-th-accent"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="w-[2.2rem] text-right text-[0.75rem] text-th-text-secondary tabular-nums">
        {pct}%
      </span>
    </div>
  );
}

/** How long after the last Left/Right press the seek is actually sent. */
const SEEK_SETTLE_MS = 350;
/** How long the target keeps showing after the seek, while the playback
 *  position catches up, so the bar does not snap back and forth. */
const SEEK_HOLD_MS = 700;

function Progress({
  duration,
  video,
}: {
  duration: number;
  /** A video: position, play state and seeking go through its element. */
  video: boolean;
}) {
  const { active } = useContext(TvScreenContext);
  const live = Math.min(usePosition(video, active), duration || Infinity);
  const audioPlaying = useAtomValue(isPlayingAtom);
  const videoPlaying = useAtomValue(videoPlayingAtom);
  const isPlaying = video ? videoPlaying : audioPlaying;
  const { seekTo: seekAudio } = usePlaybackActions();
  const seekTo = async (secs: number) => {
    if (!video) return seekAudio(secs);
    const el = videoElement();
    if (el) el.currentTime = secs;
  };
  // While seeking with the remote the bar shows where it is going, and the
  // seek itself goes out once the presses stop: one smooth jump instead of a
  // thumb that bounces between each request and the real position.
  const [target, setTarget] = useState<number | null>(null);
  const targetRef = useRef<number | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(
    () => () => timers.current.forEach((t) => window.clearTimeout(t)),
    [],
  );
  const position = target ?? live;
  const pct = duration > 0 ? (position / duration) * 100 : 0;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (duration <= 0) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const delta = e.key === "ArrowLeft" ? -TV_SEEK_STEP_S : TV_SEEK_STEP_S;
    const next = Math.max(
      0,
      Math.min(duration - 1, (targetRef.current ?? live) + delta),
    );
    targetRef.current = next;
    setTarget(next);
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [
      window.setTimeout(() => {
        void seekTo(next).finally(() => {
          timers.current.push(
            window.setTimeout(() => {
              targetRef.current = null;
              setTarget(null);
            }, SEEK_HOLD_MS),
          );
        });
      }, SEEK_SETTLE_MS),
    ];
  };

  // Between position samples the bar glides instead of stepping.
  const glide = target === null && isPlaying ? "250ms linear" : "0ms linear";

  return (
    <div className="w-full">
      <div
        data-tv-focusable
        tabIndex={0}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(position)}
        onKeyDown={onKeyDown}
        className="tv-progress relative h-[0.35rem] w-full rounded-full bg-th-slider-track outline-none"
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-th-accent"
          style={{ width: `${pct}%`, transition: `width ${glide}` }}
        />
        <div
          className="tv-progress-thumb absolute top-1/2 h-[0.9rem] w-[0.9rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-th-text-primary opacity-0"
          style={{ left: `${pct}%`, transition: `left ${glide}` }}
        />
      </div>
      <div className="mt-[0.4rem] flex justify-between text-[0.75rem] text-th-text-muted tabular-nums">
        <span className={target !== null ? "text-th-text-primary" : ""}>
          {formatTime(position)}
        </span>
        <span>{duration > 0 ? formatTime(duration) : ""}</span>
      </div>
    </div>
  );
}

/** Back up to the player (Play/Pause) once the row just played has left
 *  the list or moved, instead of losing focus. */
function focusPlayerSoon(element: () => HTMLElement | null) {
  requestAnimationFrame(() => {
    const el = element();
    if (el) focusFirstIn(el);
  });
}

/** Focuses the queue row with this queue id; false when it is not shown. */
function focusQueueRow(list: HTMLElement | null, qid: string | undefined) {
  const row = qid
    ? list?.querySelector<HTMLElement>(
        `[data-tv-row-id="${qid}"] [data-tv-focusable]`,
      )
    : null;
  if (row) focusElement(row);
  return !!row;
}

/** Up next: the manual queue, then the rest of the source, rendered a
 *  chunk at a time as focus nears the end. Every action finds its track by
 *  queue id when it runs, so a queue that moved on while the menu was open
 *  never hits another track. */
function QueuePanel() {
  const store = useStore();
  const queue = useAtomValue(queueAtom);
  const manualQueue = useAtomValue(manualQueueAtom);
  const contextSource = useAtomValue(contextSourceAtom);
  const playbackSource = useAtomValue(playbackSourceAtom);
  const source = contextSource ?? playbackSource;
  const { playFromQueue, removeFromQueue, clearQueue, setQueueTracks } =
    usePlaybackActions();
  const { showToast } = useToast();
  const screen = useContext(TvScreenContext);
  const listRef = useRef<HTMLDivElement>(null);
  const total = manualQueue.length + queue.length;
  const win = useTvProgressive(total);
  useTvGrowOnFocus(listRef, win.shown, win.grow);
  const upNext = [...manualQueue, ...queue].slice(0, win.shown);
  const current = () => ({
    manual: store.get(manualQueueAtom),
    context: store.get(queueAtom),
  });
  // After a row leaves the list, focus the row that took its place (or the
  // player, when there is none).
  const refocusUpNext = (qid: string | undefined) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (focusQueueRow(listRef.current, qid)) return;
        const el = screen.element();
        if (el) focusFirstIn(el);
      }),
    );
  const move = (t: Track, to: "up" | "down" | "top") => {
    const { manual, context } = current();
    const r = moveInQueue(manual, context, t, to);
    if (!r) return;
    setQueueTracks(r.tracks, { reorder: true, manualCount: r.manualCount });
    // Moved down past the last shown row: show it before refocusing it.
    if (queueIndexOf(r.tracks, [], t) >= win.shown) win.grow();
    requestAnimationFrame(() => focusQueueRow(listRef.current, t._qid));
  };
  const remove = (t: Track) => {
    const { manual, context } = current();
    const at = queueIndexOf(manual, context, t);
    if (at < 0) return;
    const all = [...manual, ...context];
    const neighbour = all[at + 1] ?? all[at - 1];
    removeFromQueue(at);
    refocusUpNext(neighbour?._qid);
  };
  const queueMenu = (t: Track, i: number): TvMenuItem[] => [
    ...(i > 0
      ? [
          {
            label: "Move up",
            icon: ArrowUp,
            onSelect: () => move(t, "up"),
          },
        ]
      : []),
    ...(i < total - 1
      ? [
          {
            label: "Move down",
            icon: ArrowDown,
            onSelect: () => move(t, "down"),
          },
        ]
      : []),
    ...(i > 0
      ? [
          {
            label: "Move to top",
            icon: ListStart,
            onSelect: () => move(t, "top"),
          },
        ]
      : []),
    { label: "Remove from queue", icon: ListX, onSelect: () => remove(t) },
    {
      label: "Clear queue",
      icon: Trash2,
      onSelect: () => {
        clearQueue();
        showToast("Queue cleared");
        refocusUpNext(undefined);
      },
    },
  ];

  const row = (t: Track, i: number) => (
    <TvTrackRow
      key={t._qid ?? `${t.id}:${i}`}
      track={t}
      index={i}
      rowId={t._qid}
      showCover
      menuExtra={queueMenu(t, i)}
      onSelect={() => {
        const { manual, context } = current();
        const at = queueIndexOf(manual, context, t);
        if (at < 0) return;
        void playFromQueue(at);
        focusPlayerSoon(screen.element);
      }}
    />
  );
  const manualShown = upNext.slice(0, manualQueue.length);
  const contextShown = upNext.slice(manualQueue.length);

  // The root is always rendered: the grow-on-focus listener attaches to it
  // at mount.
  return (
    <div ref={listRef}>
      {upNext.length === 0 && <PanelEmpty text="Nothing queued" />}
      {manualShown.length > 0 && <QueueHeading text="Next in queue" />}
      {manualShown.map(row)}
      {contextShown.length > 0 && (
        <QueueHeading
          text={source ? `Next up from ${source.name}` : "Next up"}
        />
      )}
      {contextShown.map((t, i) => row(t, manualQueue.length + i))}
    </div>
  );
}

function QueueHeading({ text }: { text: string }) {
  return (
    <h3 className="px-[1rem] pt-[0.6rem] pb-[0.4rem] text-[0.75rem] font-bold uppercase tracking-[0.15em] text-th-text-muted truncate">
      {text}
    </h3>
  );
}

/** The last ten tracks played, most recent first. Playing one keeps the
 *  queue, as in the desktop queue tab. */
function HistoryPanel() {
  const history = useAtomValue(historyAtom);
  const { playTrack } = usePlaybackActions();
  const screen = useContext(TvScreenContext);
  const recent = history.slice(-10).reverse();

  if (recent.length === 0) return <PanelEmpty text="Nothing played yet" />;
  return (
    <div>
      {recent.map((t, i) => (
        <TvTrackRow
          key={`${t.id}:${i}`}
          track={t}
          index={i}
          showCover
          onSelect={() => {
            void playTrack(t);
            focusPlayerSoon(screen.element);
          }}
        />
      ))}
    </div>
  );
}

/** The playing track's mix. Playing one keeps the queue, as in the desktop
 *  drawer's suggested tab. */
function SuggestedPanel() {
  const track = useAtomValue(currentTrackAtom);
  const { tracks, loading, error } = useSuggestedTracks(track);
  const { playTrack } = usePlaybackActions();
  const screen = useContext(TvScreenContext);

  if (loading) return <TvSpinner />;
  if (error || tracks.length === 0)
    return <PanelEmpty text="No suggested tracks available for this track" />;
  return (
    <div>
      {tracks.map((t, i) => (
        <TvTrackRow
          key={`${t.id}:${i}`}
          track={t}
          index={i}
          showCover
          onSelect={() => {
            void playTrack(t);
            focusPlayerSoon(screen.element);
          }}
        />
      ))}
    </div>
  );
}

/** The playing track's details and credits, as in the desktop drawer
 *  (without the bio). Every row is focusable, so the remote can scroll
 *  through them; a role with artist pages opens the artist, or a menu of
 *  them when there are several. */
function CreditsPanel() {
  const nav = useTvNav();
  const track = useAtomValue(currentTrackAtom);
  const { credits, loading, error } = useTrackCredits(track?.id);

  if (loading) return <TvSpinner />;
  if (!track || error || credits.length === 0)
    return <PanelEmpty text="No credits available for this track" />;

  const releaseDate = track.album?.releaseDate
    ? (() => {
        const d = new Date(track.album.releaseDate);
        return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
      })()
    : null;
  const details = (
    [
      ["Title", getTrackDisplayTitle(track)],
      ["Artists", getTrackArtistDisplay(track)],
      ["Album", track.album?.title],
      ["Released", releaseDate],
      ["Label", track.copyright],
    ] as [string, string | null | undefined][]
  ).filter((d): d is [string, string] => !!d[1]);
  const openArtist = (a: { id: number; name: string }) =>
    nav.push({ type: "artist", id: a.id, name: a.name });
  const openCredit = (credit: Credit) => {
    const linked = credit.contributors.filter(
      (c): c is { name: string; id: number } => typeof c.id === "number",
    );
    if (linked.length === 0) return undefined;
    if (linked.length === 1) return () => openArtist(linked[0]);
    return () =>
      nav.openMenu({
        title: credit.creditType,
        items: linked.map((c) => ({
          label: c.name,
          onSelect: () => openArtist(c),
        })),
      });
  };

  return (
    <div>
      {details.map(([label, value]) => (
        <CreditRow key={label} label={label} value={value} />
      ))}
      {credits.map((credit, i) => (
        <CreditRow
          key={`${credit.creditType}-${i}`}
          label={credit.creditType}
          value={credit.contributors.map((c) => c.name).join(", ")}
          onSelect={openCredit(credit)}
        />
      ))}
    </div>
  );
}

function CreditRow({
  label,
  value,
  onSelect,
}: {
  label: string;
  value: string;
  onSelect?: () => void;
}) {
  const layout =
    "tv-track flex w-full items-center gap-[1rem] px-[1rem] py-[0.7rem] rounded-[0.6rem] text-left";
  const content = (
    <span className="min-w-0 flex-1 flex flex-col gap-[0.2rem]">
      <span className="text-[0.75rem] font-bold uppercase tracking-[0.15em] text-th-text-muted">
        {label}
      </span>
      <span className="text-[0.95rem] font-medium text-th-text-primary break-words">
        {value}
      </span>
    </span>
  );

  if (!onSelect)
    return (
      <div tabIndex={0} data-tv-focusable className={layout}>
        {content}
      </div>
    );
  return (
    <button data-tv-focusable onClick={onSelect} className={layout}>
      {content}
      <ChevronRight
        aria-hidden
        className="w-[1.2rem] h-[1.2rem] shrink-0 text-th-text-muted"
      />
    </button>
  );
}

function PanelEmpty({ text }: { text: string }) {
  return (
    <p className="px-[1rem] py-[1rem] text-[0.8rem] text-th-text-muted">
      {text}
    </p>
  );
}

/** Tabs about the track itself, not offered while a video plays. */
const TRACK_ONLY_TABS: TvNowPlayingTab[] = ["suggested", "credits"];

/** Up next / Suggested / History / Credits under the player. Focusing a
 *  tab selects it, so Left and Right switch panels without Enter; only the
 *  selected panel is mounted, and the last one used is kept for the
 *  session. */
function NowPlayingTabs({ isVideo }: { isVideo: boolean }) {
  const queue = useAtomValue(queueAtom);
  const manualQueue = useAtomValue(manualQueueAtom);
  const [stored, setTab] = useAtom(tvNowPlayingTabAtom);
  const baseId = useId();
  const n = manualQueue.length + queue.length;
  const tabs: { id: TvNowPlayingTab; label: string }[] = [
    { id: "queue" as const, label: n > 0 ? `Up next · ${n}` : "Up next" },
    { id: "suggested" as const, label: "Suggested" },
    { id: "history" as const, label: "History" },
    { id: "credits" as const, label: "Credits" },
  ].filter((t) => !(isVideo && TRACK_ONLY_TABS.includes(t.id)));
  const selected = tabs.some((t) => t.id === stored) ? stored : "queue";
  const tabId = (id: TvNowPlayingTab) => `${baseId}-tab-${id}`;
  const panelId = (id: TvNowPlayingTab) => `${baseId}-panel-${id}`;

  return (
    <>
      <div
        role="tablist"
        aria-label="Now playing lists"
        data-tv-remember
        // Focusing a tab brings the strip to the top of the screen, so the
        // panel below it is in view.
        data-tv-scroll-top
        className="flex items-center gap-[0.6rem] px-[1rem] pb-[0.8rem]"
      >
        {tabs.map(({ id, label }) => {
          const on = id === selected;
          return (
            <button
              key={id}
              id={tabId(id)}
              role="tab"
              aria-selected={on}
              aria-controls={panelId(id)}
              data-tv-focusable
              data-tv-default={on || undefined}
              onFocus={() => setTab(id)}
              className={`tv-button inline-flex items-center h-[2.4rem] px-[1.2rem] rounded-full font-semibold text-[0.8rem] ${
                on ? "bg-th-button text-th-text-primary" : "text-th-text-muted"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={panelId(selected)}
        aria-labelledby={tabId(selected)}
      >
        {selected === "history" ? (
          <HistoryPanel />
        ) : selected === "suggested" ? (
          <SuggestedPanel />
        ) : selected === "credits" ? (
          <CreditsPanel />
        ) : (
          <QueuePanel />
        )}
      </div>
    </>
  );
}

export default function TvNowPlaying() {
  const nav = useTvNav();
  const track = useAtomValue(currentTrackAtom);
  const isPlaying = useAtomValue(isPlayingAtom);
  const streamInfo = useAtomValue(streamInfoAtom);
  const queue = useAtomValue(queueAtom);
  const manualQueue = useAtomValue(manualQueueAtom);
  const source = useAtomValue(playbackSourceAtom);
  const sourceView = viewForSource(source);
  const shuffle = useAtomValue(shuffleAtom);
  const [repeat, setRepeat] = useAtom(repeatAtom);
  const currentVideo = useAtomValue(currentVideoAtom);
  const [videoExpanded, setVideoExpanded] = useAtom(videoExpandedAtom);
  const [lyricsOn, setLyricsOn] = useAtom(tvLyricsAtom);
  const [signalPathOpen, setSignalPathOpen] = useState(false);
  const lyrics = useTvLyrics(
    track && track.itemType !== "video" ? track.id : undefined,
  );
  const {
    favoriteTrackIds,
    addFavoriteTrack,
    removeFavoriteTrack,
    favoriteVideoIds,
    addFavoriteVideo,
    removeFavoriteVideo,
  } = useFavorites();
  // A video's play state lives on its <video> element, not in the audio
  // player's state.
  const videoPlaying = useAtomValue(videoPlayingAtom);
  const { togglePlayPause, playNext, playPrevious, toggleShuffle } =
    usePlaybackActions();

  useTvInitialFocus(true);
  const screen = useContext(TvScreenContext);
  const videoSlotRef = useRef<HTMLDivElement>(null);
  const showVideoInSlot =
    track?.itemType === "video" &&
    !!currentVideo &&
    !videoExpanded &&
    screen.active &&
    !(lyricsOn && !!lyrics);
  useTvMiniVideo(videoSlotRef, screen.element, showVideoInSlot);
  const videoAspect = useTvVideoAspect(
    track?.itemType === "video" && !!currentVideo,
  );
  if (!track) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-[1rem] text-center">
        <p className="text-[1.1rem] font-semibold text-th-text-primary">
          Nothing is playing
        </p>
        <p className="text-[0.8rem] text-th-text-muted">
          Pick something from Home, Search or your Collection.
        </p>
        <TvButton
          autoFocus
          label="Go to Home"
          onClick={() => nav.push({ type: "home" })}
        />
      </div>
    );
  }

  const isVideo = track.itemType === "video";
  const cover = getTidalImageUrl(trackCoverId(track), 1280);
  // The backdrop is blurred anyway: a small image scaled up is soft by
  // itself and needs only a light blur, which is far cheaper to paint on
  // weak integrated graphics than a heavy blur over a full-size cover.
  const backdrop = getTidalImageUrl(trackCoverId(track), 160);
  const liked = isVideo
    ? favoriteVideoIds.has(track.id)
    : favoriteTrackIds.has(track.id);
  const playing = isVideo && currentVideo ? videoPlaying : isPlaying;
  const nextUp = manualQueue[0] ?? queue[0];
  const artist = track.artist ?? track.artists?.[0];
  const quality = isVideo ? "" : formatStreamQuality(streamInfo);
  const icon = "w-[1.2rem] h-[1.2rem]";
  const showLyrics = lyricsOn && !!lyrics;

  return (
    // The player fills the first screen; the Up next / History tabs start
    // below the fold and scroll into view only when focus moves down to them.
    <div className="relative h-full">
      {/* Blurred cover backdrop */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {backdrop && (
          <TidalImage
            src={backdrop}
            alt=""
            className="absolute inset-0 w-full h-full scale-125 blur-[1.2rem] opacity-35"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-th-base/60 to-th-base" />
      </div>

      <div
        data-tv-scroll-top
        className="relative h-full flex items-center gap-[3.5rem] px-[4rem] py-[2.5rem]"
      >
        {showLyrics ? (
          <div className="shrink-0 h-[min(72vh,40rem)] w-[min(46vw,48rem)]">
            <TvLyricsPanel lyrics={lyrics} duration={track.duration ?? 0} />
          </div>
        ) : (
          <div
            ref={isVideo ? videoSlotRef : undefined}
            className={`shrink-0 overflow-hidden rounded-[1rem] shadow-2xl bg-th-surface ${
              isVideo ? "" : "h-[min(72vh,40rem)] aspect-square"
            }`}
            // A video's spot takes the video's own shape (no black bars),
            // as wide as fits in both directions.
            style={
              isVideo
                ? {
                    aspectRatio: videoAspect,
                    width: `min(55vw, 60rem, calc(72vh * ${videoAspect}))`,
                  }
                : undefined
            }
          >
            <TidalImage
              src={cover || undefined}
              alt=""
              className="w-full h-full"
            />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <h1 className="text-[2.4rem] font-extrabold leading-tight text-th-text-primary line-clamp-2">
            {track.title}
            {track.version && (
              <span className="font-semibold text-th-text-muted">
                {" "}
                ({track.version})
              </span>
            )}
          </h1>
          <p className="mt-[0.4rem] text-[1.1rem] text-th-text-secondary truncate">
            {getTrackArtistDisplay(track)}
          </p>
          {track.album?.title && (
            <p className="mt-[0.2rem] text-[0.85rem] text-th-text-muted truncate">
              {track.album.title}
            </p>
          )}
          {source &&
            (sourceView ? (
              <button
                data-tv-focusable
                onClick={() => nav.push(sourceView)}
                className="tv-button mt-[0.6rem] block max-w-full origin-left truncate rounded-[0.3rem] px-[0.4rem] text-left text-[0.8rem] text-th-text-secondary"
              >
                Playing from {source.name}
              </button>
            ) : (
              <p className="mt-[0.6rem] px-[0.4rem] text-[0.8rem] text-th-text-muted truncate">
                Playing from {source.name}
              </p>
            ))}
          {quality && (
            <button
              data-tv-focusable
              onClick={() => setSignalPathOpen(true)}
              title="Signal path"
              className="tv-button mt-[0.8rem] inline-flex items-center gap-[0.5rem] rounded-[0.3rem] border border-th-border-subtle px-[0.5rem] py-0 text-[0.75rem] leading-[1.2rem] font-bold tracking-[0.12em] text-th-accent"
            >
              {quality}
              <span className="font-semibold tracking-normal text-th-text-muted">
                · Signal path
              </span>
            </button>
          )}
          {signalPathOpen && (
            <TvNativeLayer width={680}>
              <SignalPathPanel open onClose={() => setSignalPathOpen(false)} />
            </TvNativeLayer>
          )}

          <div className="mt-[2rem]">
            <Progress
              key={track.id}
              duration={track.duration ?? 0}
              video={isVideo && !!currentVideo}
            />
          </div>

          <div className="mt-[1.4rem] flex flex-wrap items-center gap-[0.8rem]">
            <TvButton
              title="Shuffle"
              active={shuffle}
              icon={<Shuffle className={icon} />}
              onClick={toggleShuffle}
            />
            <TvButton
              title="Previous"
              icon={<SkipBack className={icon} fill="currentColor" />}
              onClick={() => void playPrevious()}
            />
            <TvButton
              primary
              autoFocus
              title={playing ? "Pause" : "Play"}
              icon={
                playing ? (
                  <Pause className={icon} fill="currentColor" />
                ) : (
                  <Play className={icon} fill="currentColor" />
                )
              }
              onClick={() => void togglePlayPause()}
            />
            <TvButton
              title="Next"
              icon={<SkipForward className={icon} fill="currentColor" />}
              onClick={() => void playNext({ explicit: true })}
            />
            <TvButton
              title={
                repeat === 2
                  ? "Repeat one"
                  : repeat === 1
                    ? "Repeat all"
                    : "Repeat off"
              }
              active={repeat !== 0}
              icon={
                repeat === 2 ? (
                  <Repeat1 className={icon} />
                ) : (
                  <Repeat className={icon} />
                )
              }
              onClick={() => setRepeat((repeat + 1) % 3)}
            />
          </div>

          <div className="mt-[1rem] flex flex-wrap items-center gap-[0.8rem]">
            <TvButton
              title={
                isVideo
                  ? liked
                    ? "Remove from favorites"
                    : "Add to favorites"
                  : liked
                    ? "Remove from My Tracks"
                    : "Add to My Tracks"
              }
              active={liked}
              icon={
                <Heart
                  className={icon}
                  fill={liked ? "currentColor" : "none"}
                />
              }
              onClick={() =>
                void (
                  isVideo
                    ? liked
                      ? removeFavoriteVideo(track.id)
                      : addFavoriteVideo(track.id)
                    : liked
                      ? removeFavoriteTrack(track.id)
                      : addFavoriteTrack(track.id, track)
                ).catch(() => {})
              }
            />
            {lyrics && (
              <TvButton
                active={lyricsOn}
                icon={<Mic2 className={icon} />}
                label="Lyrics"
                title={lyricsOn ? "Show cover" : "Show lyrics"}
                onClick={() => setLyricsOn(!lyricsOn)}
              />
            )}
            {isVideo && currentVideo && (
              <TvButton
                icon={<Maximize2 className={icon} />}
                label="Full screen"
                onClick={() => setVideoExpanded(true)}
              />
            )}
            {!isVideo && artist && (
              <TvButton
                label="Artist"
                onClick={() =>
                  nav.push({ type: "artist", id: artist.id, name: artist.name })
                }
              />
            )}
            {!isVideo && track.album?.id && (
              <TvButton
                label="Album"
                onClick={() =>
                  nav.push({
                    type: "album",
                    id: track.album!.id,
                    title: track.album!.title,
                  })
                }
              />
            )}
            <TvButton
              title="More options"
              icon={<MoreHorizontal className={icon} />}
              onClick={() => nav.openMenu(nav.trackMenu(track))}
            />
          </div>

          <div className="mt-[1rem] flex items-center">
            <VolumeControl />
          </div>
        </div>

        {nextUp && (
          <div className="pointer-events-none absolute inset-x-0 bottom-[1rem] flex items-center justify-center gap-[0.4rem] text-[0.75rem] text-th-text-muted">
            <ChevronDown className="w-[1rem] h-[1rem]" />
            <span className="truncate max-w-[40rem]">
              Up next: {nextUp.title}
            </span>
          </div>
        )}
      </div>

      <section className="relative px-[3rem] pt-[1.5rem] pb-[3rem]">
        <NowPlayingTabs isVideo={isVideo} />
      </section>
    </div>
  );
}
