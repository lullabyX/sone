import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import {
  Bell,
  Compass,
  Disc3,
  Home,
  Library,
  LogOut,
  Search,
  Settings,
} from "lucide-react";
import ProxyNoticeBanner from "../ProxyNoticeBanner";
import SettingsSheet from "../settings/SettingsSheet";
import { tvModeAtom } from "../../atoms/tv";
import { feedUnseenCountAtom } from "../../atoms/ui";
import { currentVideoAtom, videoExpandedAtom } from "../../atoms/video";
import { useMiniplayerEmitter } from "../../hooks/useMiniplayerEmitter";
import {
  dockFallback,
  focusElement,
  focusFirstIn,
  isShown,
  moveFocus,
  rememberFocus,
} from "../../lib/spatialNav";
import { TvNavContext, TvScreenContext, type TvNav } from "./TvNavContext";
import type { TvAction, TvView } from "./tvItems";
import TvHome from "./TvHome";
import TvSearch from "./TvSearch";
import TvCollection from "./TvCollection";
import TvNowPlaying from "./TvNowPlaying";
import TvTrackListScreen from "./TvTrackListScreen";
import TvArtistScreen from "./TvArtistScreen";
import TvSettings from "./TvSettings";
import TvPageScreen from "./TvPageScreen";
import TvFeedScreen from "./TvFeedScreen";
import TvProfileScreen from "./TvProfileScreen";
import TvListScreen from "./TvListScreen";
import TvSearchResultsScreen from "./TvSearchResultsScreen";
import TvNativeLayer from "./TvNativeLayer";
import TvPrompt, { type TvPromptRequest } from "./TvPrompt";
import TvMenuHost, { type TvMenuHostHandle } from "./TvMenuHost";
import TvVolumeHud from "./TvVolumeHud";
import TvMiniBar from "./TvMiniBar";
import { linkMenu, menuForElement, navMenus } from "./tvMenu";
import { useTvVideoMarks } from "./useTvVideoMarks";
import { useTvMoreSettings } from "./useTvMoreSettings";
import { useTvPlayback } from "./useTvPlayback";
import { textEntryKind, type TvKeyAction } from "./tvKeys";
import { fieldLabel, setNativeInputValue } from "./tvFields";
import { topTvModal, tvLayer, useTvKeyRouter } from "./useTvKeyRouter";
import { useTvMediaCommands } from "./useTvMediaCommands";
import {
  tvBackStep,
  tvPush,
  type TvBackStep,
  type TvStackEntry,
} from "./tvStack";
import "./tv.css";

type RootType =
  | "home"
  | "search"
  | "explore"
  | "feed"
  | "collection"
  | "nowPlaying"
  | "settings";

const RAIL: { type: RootType; label: string; icon: typeof Home }[] = [
  { type: "home", label: "Home", icon: Home },
  { type: "search", label: "Search", icon: Search },
  { type: "explore", label: "Explore", icon: Compass },
  { type: "feed", label: "Feed", icon: Bell },
  { type: "collection", label: "My Collection", icon: Library },
  { type: "nowPlaying", label: "Now Playing", icon: Disc3 },
  { type: "settings", label: "Settings", icon: Settings },
];

const ROOTS = new Set<string>(RAIL.map((r) => r.type));

/** How long Enter must be held to open the action menu instead of
 *  activating the focused item. */
const LONG_PRESS_MS = 550;

let nextEntryId = 1;
const entry = (view: TvView): TvStackEntry => ({ id: nextEntryId++, view });

function renderScreen(view: TvView): ReactNode {
  switch (view.type) {
    case "home":
      return <TvHome />;
    case "search":
      return <TvSearch />;
    case "collection":
      return <TvCollection />;
    case "nowPlaying":
      return <TvNowPlaying />;
    case "settings":
      return <TvSettings />;
    case "explore":
      return <TvPageScreen title="Explore" apiPath="pages/explore" />;
    case "feed":
      return <TvFeedScreen />;
    case "profile":
      return <TvProfileScreen />;
    case "list":
      return <TvListScreen title={view.title} source={view.source} />;
    case "page":
      return (
        <TvPageScreen
          title={view.title}
          apiPath={view.apiPath}
          all={view.all}
        />
      );
    case "searchResults":
      return (
        <TvSearchResultsScreen
          query={view.query}
          what={view.what}
          title={view.title}
        />
      );
    case "artist":
      return <TvArtistScreen view={view} />;
    case "album":
    case "playlist":
    case "mix":
    case "favorites":
    case "artistTracks":
      return <TvTrackListScreen view={view} />;
  }
}

function Screen({ active, view }: { active: boolean; view: TvView }) {
  const ref = useRef<HTMLDivElement>(null);
  const element = useCallback(() => ref.current, []);
  const ctx = useMemo(() => ({ active, element }), [active, element]);
  return (
    <TvScreenContext.Provider value={ctx}>
      <div
        ref={ref}
        data-tv-remember
        data-tv-scroll-root
        className={`tv-screen absolute inset-0 overflow-y-auto overflow-x-hidden ${
          active ? "" : "hidden"
        }`}
      >
        {renderScreen(view)}
      </div>
    </TvScreenContext.Provider>
  );
}

/**
 * The 10-foot interface: every screen is driven by arrows, Enter and Back, so
 * it works from a remote, a gamepad mapped to keys, or a keyboard. Replaces
 * the desktop Layout while TV mode is on; playback, MPRIS and the rest of the
 * app keep running underneath unchanged.
 */
export default function TvApp() {
  const store = useStore();
  const setTvMode = useSetAtom(tvModeAtom);
  const currentVideo = useAtomValue(currentVideoAtom);
  const videoExpanded = useAtomValue(videoExpandedAtom);
  const overlayShowing = !!currentVideo && videoExpanded;
  const feedUnseen = useAtomValue(feedUnseenCountAtom);
  const runMedia = useTvMediaCommands();

  const rootRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const [stack, setStack] = useState<TvStackEntry[]>(() => [
    entry({ type: "home" }),
  ]);
  const stackRef = useRef(stack);
  useLayoutEffect(() => {
    stackRef.current = stack;
  }, [stack]);
  // Now Playing is a layer above the stack. It mounts on first open, then
  // stays mounted (hidden) while closed.
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [nowPlayingMounted, setNowPlayingMounted] = useState(false);
  const nowPlayingOpenRef = useRef(nowPlayingOpen);
  useLayoutEffect(() => {
    nowPlayingOpenRef.current = nowPlayingOpen;
  }, [nowPlayingOpen]);
  // Focus to give back to each screen when the one above it closes.
  const savedFocus = useRef(new Map<number, HTMLElement>());
  const pendingRestore = useRef<number | null>(null);
  // What was focused when Now Playing opened; closing the layer returns there.
  const nowPlayingOpener = useRef<HTMLElement | null>(null);
  // Per screen opened from Now Playing: the layer control that opened it,
  // and the layer's opener at that time, for when Back reopens the layer.
  const returnFocus = useRef(new Map<number, HTMLElement>());
  const reopenOpener = useRef(new Map<number, HTMLElement | null>());
  // What to focus after the next commit; only Back sets it.
  const layerFocus = useRef<HTMLElement | "screen" | null>(null);

  useMiniplayerEmitter();

  // A new video starts full screen. When the one before it was playing
  // small in Now Playing and Now Playing is still open (Next, or the queue
  // moving on), the new one stays small there too.
  const lastVideo = useRef<{ id: number; expanded: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!currentVideo) return;
    const prev = lastVideo.current;
    if (
      prev &&
      prev.id !== currentVideo.id &&
      !prev.expanded &&
      nowPlayingOpenRef.current &&
      videoExpanded
    ) {
      store.set(videoExpandedAtom, false);
      return;
    }
    lastVideo.current = { id: currentVideo.id, expanded: videoExpanded };
  }, [currentVideo, videoExpanded, store]);

  useTvVideoMarks(currentVideo);

  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof HTMLElement) rememberFocus(e.target);
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  // Starting playback opens Now Playing above the current screen, so Back
  // returns to the album or list it was started from.
  const openNowPlaying = useCallback(() => {
    if (nowPlayingOpenRef.current) return;
    const active = document.activeElement;
    const opener =
      active instanceof HTMLElement && active !== document.body ? active : null;
    nowPlayingOpener.current = opener;
    // The layer focuses Play itself unless focus is held in the rail.
    if (opener && railRef.current?.contains(opener)) opener.blur();
    setNowPlayingMounted(true);
    setNowPlayingOpen(true);
  }, []);

  const closeNowPlaying = useCallback(() => {
    if (!nowPlayingOpenRef.current) return;
    layerFocus.current = nowPlayingOpener.current ?? "screen";
    nowPlayingOpener.current = null;
    setNowPlayingOpen(false);
  }, []);

  useLayoutEffect(() => {
    const target = layerFocus.current;
    if (target == null) return;
    layerFocus.current = null;
    if (target !== "screen" && target.isConnected && isShown(target)) {
      focusElement(target);
      return;
    }
    const screen = rootRef.current?.querySelector<HTMLElement>(
      ".tv-screen:not(.hidden)",
    );
    if (screen) focusFirstIn(screen);
  }, [nowPlayingOpen, stack]);

  const goTo = useCallback(
    (type: RootType) => {
      if (type === "nowPlaying") {
        openNowPlaying();
        return;
      }
      // The rail closes, and the new screen takes focus once it has loaded
      // (it leaves focus alone while it is in the rail).
      const active = document.activeElement;
      if (active instanceof HTMLElement && railRef.current?.contains(active)) {
        active.blur();
      }
      savedFocus.current.clear();
      returnFocus.current.clear();
      reopenOpener.current.clear();
      nowPlayingOpener.current = null;
      setNowPlayingOpen(false);
      setStack([entry({ type })]);
    },
    [openNowPlaying],
  );

  /** Put a screen on the stack, remembering where focus was below it. Opened
   *  from Now Playing, it closes the layer, and Back reopens it. */
  const stackPush = useCallback((view: TvView) => {
    const e = entry(view);
    const active = document.activeElement;
    if (nowPlayingOpenRef.current) {
      if (active instanceof HTMLElement) returnFocus.current.set(e.id, active);
      reopenOpener.current.set(e.id, nowPlayingOpener.current);
      setNowPlayingOpen(false);
      setStack((s) => tvPush(s, e, true));
      return;
    }
    const top = stackRef.current[stackRef.current.length - 1];
    if (active instanceof HTMLElement) savedFocus.current.set(top.id, active);
    setStack((s) => tvPush(s, e, false));
  }, []);

  const push = useCallback(
    (view: TvView) => {
      if (view.type === "nowPlaying") {
        openNowPlaying();
        return;
      }
      if (ROOTS.has(view.type)) {
        goTo(view.type as RootType);
        return;
      }
      stackPush(view);
    },
    [openNowPlaying, goTo, stackPush],
  );

  const focusRail = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const current = rail.querySelector<HTMLElement>("[aria-current='page']");
    if (current) focusElement(current);
    else focusFirstIn(rail);
  }, []);

  const back = useCallback(() => {
    const step: TvBackStep = tvBackStep(
      stackRef.current,
      nowPlayingOpenRef.current,
    );
    switch (step.kind) {
      case "closeNowPlaying":
        closeNowPlaying();
        return;
      case "pop": {
        const { popped } = step;
        savedFocus.current.delete(popped.id);
        const opener = reopenOpener.current.get(popped.id);
        reopenOpener.current.delete(popped.id);
        if (step.reopenNowPlaying) {
          // The opener the layer had when this page left it.
          nowPlayingOpener.current = opener ?? null;
          layerFocus.current = returnFocus.current.get(popped.id) ?? "screen";
          returnFocus.current.delete(popped.id);
          setNowPlayingOpen(true);
        } else {
          pendingRestore.current = step.stack[step.stack.length - 1].id;
        }
        setStack(step.stack);
        return;
      }
      case "root":
        if (!railRef.current?.contains(document.activeElement)) {
          focusRail();
          return;
        }
        if (stackRef.current[0].view.type !== "home") goTo("home");
        return;
    }
  }, [closeNowPlaying, focusRail, goTo]);

  // A deleted playlist's page closes if it is the one on top.
  const leavePlaylist = useCallback(
    (uuid: string) => {
      const top = stackRef.current[stackRef.current.length - 1]?.view;
      if (top?.type === "playlist" && top.uuid === uuid) back();
    },
    [back],
  );

  useLayoutEffect(() => {
    const id = pendingRestore.current;
    if (id == null) return;
    pendingRestore.current = null;
    const el = savedFocus.current.get(id);
    savedFocus.current.delete(id);
    if (el?.isConnected) {
      focusElement(el);
    }
  }, [stack]);

  const tvPlay = useTvPlayback(openNowPlaying);

  const menuRef = useRef<TvMenuHostHandle>(null);

  const run = useCallback<TvNav["run"]>(
    (action: TvAction, queue) => {
      switch (action.kind) {
        case "open":
          push(action.view);
          return;
        case "playVideo":
          void tvPlay.playMedia(action.item);
          return;
        case "playTrack": {
          const tracks = queue?.tracks.length ? queue.tracks : [action.track];
          void tvPlay.playTrack(action.track, tracks, {
            source: {
              type: queue?.type ?? "tv-row",
              id: queue?.id ?? action.track.id,
              name: queue?.name ?? action.track.title,
              allTracks: tracks,
            },
          });
          return;
        }
        case "showLink":
          menuRef.current?.open(linkMenu(action.url, action.title));
          return;
      }
    },
    [push, tvPlay],
  );

  // A text prompt (a playlist name) over everything; resolves with the text,
  // or null when cancelled.
  const [prompt, setPrompt] = useState<TvPromptRequest | null>(null);
  const promptResolve = useRef<((text: string | null) => void) | null>(null);
  const askText = useCallback(
    (request: TvPromptRequest) =>
      new Promise<string | null>((resolve) => {
        promptResolve.current?.(null);
        promptResolve.current = resolve;
        setPrompt(request);
      }),
    [],
  );
  const finishPrompt = useCallback((text: string | null) => {
    const resolve = promptResolve.current;
    promptResolve.current = null;
    setPrompt(null);
    resolve?.(text);
  }, []);
  // The layer hands focus back itself when it closes.
  const more = useTvMoreSettings();

  const nav = useMemo<TvNav>(
    () => ({
      push,
      back,
      run,
      openNowPlaying,
      playTrack: tvPlay.playTrack,
      playSource: tvPlay.playSource,
      // eslint-disable-next-line react-hooks/refs -- host() is only called from the returned callbacks
      ...navMenus(() => menuRef.current),
      openMoreSettings: more.open,
      prompt: askText,
    }),
    [push, back, run, openNowPlaying, tvPlay, more.open, askText],
  );

  // The desktop "focus search" shortcut opens the Search screen here.
  useEffect(() => {
    const onFocusSearch = () => goTo("search");
    window.addEventListener("focus-search", onFocusSearch);
    return () => window.removeEventListener("focus-search", onFocusSearch);
  }, [goTo]);

  // Long-pressing Enter on an item that has an action menu opens the menu;
  // a short press activates the item as usual.
  const held = useRef<{
    el: HTMLElement;
    timer: number;
    fired: boolean;
  } | null>(null);
  // Pointer x of the synthetic moves that wake the video controls; it must
  // change each time, as the player ignores a move to the same spot.
  const wakeX = useRef(0);
  // Set by an arrow move until the screen has been drawn after it.
  const moveDrawing = useRef(false);

  const openMenuFor = useCallback((el: Element | null) => {
    const build = menuForElement(el);
    if (build) menuRef.current?.open(build());
  }, []);

  const wakeVideo = useCallback(() => {
    const video = document.querySelector<HTMLVideoElement>(
      "[role='dialog'] video",
    );
    if (!video) return;
    wakeX.current = (wakeX.current + 1) % 1000;
    video.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: wakeX.current }),
    );
  }, []);

  const execute = useCallback(
    (action: TvKeyAction, e: KeyboardEvent) => {
      const video = document.querySelector<HTMLVideoElement>(
        "[role='dialog'] video",
      );
      const dialog = video?.closest<HTMLElement>("[role='dialog']") ?? null;
      const qualityButton = dialog?.querySelector<HTMLElement>(
        "button[title='Quality']",
      );
      const qualityList =
        qualityButton?.nextElementSibling instanceof HTMLElement
          ? qualityButton.nextElementSibling
          : null;
      const active = document.activeElement;

      switch (action.type) {
        case "media":
          runMedia(action.command);
          return;
        case "openMenu":
          openMenuFor(active);
          return;
        case "pressStart": {
          const target = active as HTMLElement | null;
          if (!target) return;
          held.current = {
            el: target,
            fired: false,
            timer: window.setTimeout(() => {
              const h = held.current;
              if (!h) return;
              h.fired = true;
              openMenuFor(h.el);
            }, LONG_PRESS_MS),
          };
          return;
        }
        case "move": {
          const scope = topTvModal() ?? rootRef.current;
          if (!scope) return;
          // A held arrow can repeat faster than a slower machine moves focus
          // down a long list. At most one repeat is handled per drawn frame;
          // the rest are dropped instead of piling up, so focus stops when
          // the key is released rather than working through a backlog.
          if (e.repeat && moveDrawing.current) return;
          const moved = moveFocus(scope, action.dir, {
            enterSide: action.enterSide,
          });
          if (!moved && action.dir === "down" && scope === rootRef.current)
            dockFallback(scope, { repeat: e.repeat });
          moveDrawing.current = true;
          requestAnimationFrame(() =>
            window.setTimeout(() => {
              moveDrawing.current = false;
            }),
          );
          // The action menu slides in from the right; Left leaves it.
          if (!moved && action.dir === "left" && menuRef.current?.isOpen()) {
            menuRef.current.back();
          }
          return;
        }
        case "focusContent": {
          if (e.repeat && moveDrawing.current) return;
          const screen = rootRef.current?.querySelector<HTMLElement>(
            ".tv-screen:not(.hidden)",
          );
          if (screen) focusFirstIn(screen);
          return;
        }
        case "focusRail":
          focusRail();
          return;
        case "editField": {
          const el = e.target;
          if (
            !(el instanceof HTMLInputElement) &&
            !(el instanceof HTMLTextAreaElement)
          ) {
            return;
          }
          // TvPrompt hands focus back to the field when it closes.
          void askText({
            title: fieldLabel(el),
            initial: el.value,
            confirm: "Done",
            placeholder: el.placeholder,
            allowEmpty: true,
            trim: false,
            secret: el.type === "password",
            maxLength: el.maxLength > 0 ? el.maxLength : undefined,
          }).then((value) => {
            if (value !== null) setNativeInputValue(el, value);
          });
          return;
        }
        case "back":
          if (textEntryKind(e.target) && e.target instanceof HTMLElement) {
            e.target.blur();
          }
          switch (tvLayer()) {
            case "prompt":
              finishPrompt(null);
              return;
            case "menu":
              menuRef.current?.back();
              return;
            case "none":
              back();
              return;
          }
          return;
        case "nativeEscape":
          if (textEntryKind(e.target) && e.target instanceof HTMLElement) {
            e.target.blur();
          }
          // Desktop dialogs shown in TV mode close on Escape themselves.
          window.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
          );
          return;
        case "videoToggle":
          if (!video) return;
          if (video.paused) video.play().catch(() => {});
          else video.pause();
          return;
        case "videoSeek":
          if (!video || !Number.isFinite(video.duration)) return;
          video.currentTime = Math.min(
            Math.max(0, video.currentTime + action.by),
            Math.max(0, video.duration - 0.5),
          );
          return;
        case "videoControls": {
          if (!dialog) return;
          // Start on play/pause, the button right after "Previous".
          const play = dialog.querySelector<HTMLElement>(
            "button[title='Previous'] + button",
          );
          if (play) focusElement(play);
          else focusFirstIn(dialog);
          return;
        }
        case "videoMove": {
          if (!dialog || !(active instanceof HTMLElement)) return;
          if (
            !moveFocus(dialog, action.dir) &&
            (action.dir === "up" || action.dir === "down")
          ) {
            active.blur();
          }
          // Leaving the open quality list closes it.
          const now = document.activeElement;
          if (
            qualityList &&
            qualityButton &&
            now !== qualityButton &&
            !qualityList.contains(now)
          ) {
            qualityButton.click();
          }
          return;
        }
        case "videoBack":
          if (qualityList && qualityButton) {
            // Back closes the open quality list first.
            qualityButton.click();
            focusElement(qualityButton);
          } else if (
            dialog &&
            (active instanceof HTMLButtonElement ||
              active instanceof HTMLInputElement) &&
            dialog.contains(active)
          ) {
            active.blur();
          } else store.set(videoExpandedAtom, false);
          return;
        case "videoNativeEnter":
          // Picking a quality closes the list; focus goes back to its button.
          if (qualityButton) {
            requestAnimationFrame(() => focusElement(qualityButton));
          }
          return;
      }
    },
    [
      store,
      back,
      focusRail,
      runMedia,
      askText,
      finishPrompt,
      openMenuFor,
    ],
  );

  useTvKeyRouter({
    rootRef,
    railRef,
    holding: () => held.current !== null,
    execute,
    wakeVideo,
  });

  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      const h = held.current;
      if (e.key !== "Enter" || !h) return;
      held.current = null;
      window.clearTimeout(h.timer);
      if (!h.fired) h.el.click();
    };
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keyup", onKeyUp);
      if (held.current) window.clearTimeout(held.current.timer);
      held.current = null;
    };
  }, []);

  const top = stack[stack.length - 1];
  const rootType = nowPlayingOpen ? "nowPlaying" : stack[0].view.type;

  return (
    <TvNavContext.Provider value={nav}>
      <div
        ref={rootRef}
        className={`tv-root relative flex flex-col h-full w-full bg-th-base text-th-text-primary overflow-hidden ${
          overlayShowing ? "hidden" : ""
        }`}
      >
        <ProxyNoticeBanner offerSettings />
        <div className="relative flex-1 min-h-0">
          <nav
            ref={railRef}
            data-tv-rail
            data-tv-remember
            data-tv-side
            aria-label="Main"
            className="tv-rail group overflow-hidden absolute inset-y-0 left-0 z-20 flex flex-col gap-[0.4rem] py-[2rem] px-[0.8rem] bg-th-sidebar"
          >
            {RAIL.map(({ type, label, icon: Icon }) => (
              <button
                key={type}
                data-tv-focusable
                aria-current={rootType === type ? "page" : undefined}
                data-tv-default={rootType === type || undefined}
                onClick={() => goTo(type)}
                className={`tv-rail-item flex items-center gap-[1rem] h-[2.8rem] px-[0.85rem] rounded-[0.7rem] text-left ${
                  rootType === type
                    ? "text-th-accent"
                    : "text-th-text-secondary"
                }`}
              >
                <span className="relative shrink-0">
                  <Icon className="w-[1.3rem] h-[1.3rem]" />
                  {type === "feed" && feedUnseen > 0 && (
                    <span className="absolute -top-[0.15rem] -right-[0.15rem] w-[0.5rem] h-[0.5rem] rounded-full bg-th-accent" />
                  )}
                </span>
                <span className="tv-rail-label whitespace-nowrap text-[0.85rem] font-semibold">
                  {label}
                </span>
              </button>
            ))}
            <div className="flex-1" />
            <button
              data-tv-focusable
              onClick={() => setTvMode(false)}
              className="tv-rail-item flex items-center gap-[1rem] h-[2.8rem] px-[0.85rem] rounded-[0.7rem] text-left text-th-text-muted"
            >
              <LogOut className="w-[1.3rem] h-[1.3rem] shrink-0" />
              <span className="tv-rail-label whitespace-nowrap text-[0.85rem] font-semibold">
                Exit TV mode
              </span>
            </button>
          </nav>

          <main data-tv-remember className="absolute inset-0 bg-th-base">
            {stack.map((e) => (
              <Screen
                key={e.id}
                view={e.view}
                active={e.id === top.id && !nowPlayingOpen}
              />
            ))}
            {nowPlayingMounted && (
              <Screen
                key="nowPlaying"
                view={{ type: "nowPlaying" }}
                active={nowPlayingOpen}
              />
            )}
          </main>
        </div>
        <div className={nowPlayingOpen ? "hidden" : undefined}>
          <TvMiniBar />
        </div>
      </div>
      {more.tab && (
        <TvNativeLayer width={800}>
          <SettingsSheet open initialTab={more.tab} onClose={more.close} />
        </TvNativeLayer>
      )}
      <TvMenuHost
        ref={menuRef}
        onNavigate={push}
        onPlayed={openNowPlaying}
        onPrompt={askText}
        onPlaylistDeleted={leavePlaylist}
      />
      {prompt && <TvPrompt request={prompt} onDone={finishPrompt} />}
      <TvVolumeHud />
    </TvNavContext.Provider>
  );
}
