import { afterEach, beforeAll, vi, type Mock } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  type RenderHookResult,
  type RenderResult,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import {
  createRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { invoke } from "@tauri-apps/api/core";

import { ToastProvider } from "../../contexts/ToastContext";
import { authTokensAtom, isAuthenticatedAtom } from "../../atoms/auth";
import { currentTrackAtom, queueAtom } from "../../atoms/playback";
import { stampQids } from "../../lib/qid";
import type {
  PlaylistFolderData,
  PlaylistFolderItem,
  Track,
} from "../../types";
import { TvNavContext, TvScreenContext, type TvNav } from "./TvNavContext";
import TvMenuHost, { type TvMenuHostHandle } from "./TvMenuHost";
import type { TvPromptRequest } from "./TvPrompt";
import type { TvView } from "./tvItems";

export type TvStore = ReturnType<typeof createStore>;

export function setupTvTest(): void {
  beforeAll(() => {
    Element.prototype.scrollIntoView = () => {};
    Element.prototype.scrollTo = () => {};
    window.scrollTo = () => {};
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    HTMLMediaElement.prototype.pause = () => {};
    HTMLMediaElement.prototype.load = () => {};
    if (typeof window.requestAnimationFrame !== "function") {
      window.requestAnimationFrame = (cb) =>
        window.setTimeout(() => cb(performance.now()), 16);
    }
    if (typeof window.cancelAnimationFrame !== "function") {
      window.cancelAnimationFrame = (id) => window.clearTimeout(id);
    }
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
    if (vi.isMockFunction(invoke)) vi.mocked(invoke).mockReset();
    localStorage.clear();
    sessionStorage.clear();
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
  });
}

export function makeTvNav(over: Partial<TvNav> = {}): TvNav {
  return {
    push: vi.fn(),
    back: vi.fn(),
    showNowPlaying: vi.fn(),
    playTrack: vi.fn(async () => true),
    openMenu: vi.fn(),
    trackMenu: vi.fn((t: Track, extra = []) => ({
      title: t.title,
      items: extra,
    })),
    mediaMenu: vi.fn(() => ({ title: "", items: [] })),
    prompt: vi.fn(async () => null),
    openMoreSettings: vi.fn(),
    run: vi.fn(),
    ...over,
  };
}

type TvRenderOpts = { store?: TvStore; nav?: Partial<TvNav>; active?: boolean };

function tvProviders(opts: TvRenderOpts) {
  const store = opts.store ?? createStore();
  const nav = makeTvNav(opts.nav);
  let host: HTMLElement | null = null;
  const screen = { active: opts.active ?? true, element: () => host };
  function TvTestWrapper({ children }: { children: ReactNode }) {
    return (
      <Provider store={store}>
        <ToastProvider>
          <TvNavContext.Provider value={nav}>
            <TvScreenContext.Provider value={screen}>
              {children}
            </TvScreenContext.Provider>
          </TvNavContext.Provider>
        </ToastProvider>
      </Provider>
    );
  }
  const setHost = (el: HTMLElement) => {
    host = el;
  };
  return { store, nav, wrapper: TvTestWrapper, setHost };
}

export function renderTv(
  ui: ReactElement,
  opts: TvRenderOpts = {},
): RenderResult & { store: TvStore; nav: TvNav } {
  const { store, nav, wrapper, setHost } = tvProviders(opts);
  const r = render(ui, { wrapper });
  setHost(r.container);
  return { ...r, store, nav };
}

export function renderTvHook<T>(
  hook: () => T,
  opts: TvRenderOpts = {},
): RenderHookResult<T, unknown> & { store: TvStore; nav: TvNav } {
  const { store, nav, wrapper } = tvProviders(opts);
  return { ...renderHook(hook, { wrapper }), store, nav };
}

export function renderMenuHost(opts: { store?: TvStore } = {}): RenderResult & {
  ref: RefObject<TvMenuHostHandle | null>;
  store: TvStore;
  onNavigate: Mock<(view: TvView) => void>;
  onPlayed: Mock<() => void>;
  onPrompt: Mock<(request: TvPromptRequest) => Promise<string | null>>;
  onPlaylistDeleted: Mock<(uuid: string) => void>;
} {
  const store = opts.store ?? signedIn(42);
  const ref = createRef<TvMenuHostHandle>();
  const onNavigate = vi.fn<(view: TvView) => void>();
  const onPlayed = vi.fn<() => void>();
  const onPrompt = vi.fn<(request: TvPromptRequest) => Promise<string | null>>(
    async () => null,
  );
  const onPlaylistDeleted = vi.fn<(uuid: string) => void>();
  const r = render(
    <Provider store={store}>
      <ToastProvider>
        <TvMenuHost
          ref={ref}
          onNavigate={onNavigate}
          onPlayed={onPlayed}
          onPrompt={onPrompt}
          onPlaylistDeleted={onPlaylistDeleted}
        />
      </ToastProvider>
    </Provider>,
  );
  return {
    ...r,
    ref,
    store,
    onNavigate,
    onPlayed,
    onPrompt,
    onPlaylistDeleted,
  };
}

export function pressKey(
  target: EventTarget,
  init: KeyboardEventInit,
  type: "keydown" | "keyup" = "keydown",
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

export function stubLayout(): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const hidden = this.closest(".hidden") !== null;
    const box = this.getAttribute("data-box");
    const [left, top, width, height] = hidden
      ? [0, 0, 0, 0]
      : box
        ? box.split(",").map(Number)
        : [0, 0, 10, 10];
    return {
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

export function mkTrack(id: number, over: Partial<Track> = {}): Track {
  const artist = { id: 100 + id, name: `A${id}` };
  return {
    id,
    title: `T${id}`,
    artist,
    artists: [artist],
    album: { id: 200 + id, title: `Al${id}`, cover: "c" },
    duration: 180,
    streamReady: true,
    ...over,
  };
}

export function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

export function withQueue(
  tracks: Track[],
  current?: Track,
  store: TvStore = createStore(),
): TvStore {
  store.set(queueAtom, stampQids(tracks));
  store.set(currentTrackAtom, current ?? tracks[0] ?? null);
  return store;
}

export function signedIn(
  userId: number,
  store: TvStore = createStore(),
): TvStore {
  store.set(isAuthenticatedAtom, true);
  store.set(authTokensAtom, {
    access_token: "t",
    refresh_token: "r",
    expires_in: 3600,
    token_type: "Bearer",
    user_id: userId,
  });
  return store;
}

export function mockInvoke(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlers: Record<string, (args?: any) => unknown>,
): void {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    const handler = handlers[cmd];
    if (!handler) throw new Error(`unmocked ${cmd}`);
    return handler(args);
  });
}

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const STAMP = "2026-01-01T00:00:00Z";

export function rawPlaylistItem(
  uuid: string,
  title?: string,
  creatorId?: number,
): PlaylistFolderItem {
  return {
    trn: `trn:playlist:${uuid}`,
    itemType: "PLAYLIST",
    addedAt: STAMP,
    lastModifiedAt: STAMP,
    name: title ?? `P ${uuid}`,
    parent: null,
    data: {
      uuid,
      title: title ?? `P ${uuid}`,
      creator: { id: creatorId ?? 42, name: null, picture: null, type: "USER" },
    } as PlaylistFolderData,
  };
}

export function rawFolderItem(
  id: string,
  name: string,
  count?: number,
): PlaylistFolderItem {
  return {
    trn: `trn:folder:${id}`,
    itemType: "FOLDER",
    addedAt: STAMP,
    lastModifiedAt: STAMP,
    name,
    parent: null,
    data: { totalNumberOfItems: count ?? 0 } as unknown as PlaylistFolderData,
  };
}
