import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { useEffect, type ReactNode } from "react";
import App from "./App";
import { isAuthCheckingAtom, isAuthenticatedAtom } from "./atoms/auth";
import { currentVideoAtom } from "./atoms/video";
import { tvModeAtom } from "./atoms/tv";
import type { TidalVideo } from "./types";
import layoutSrc from "./components/Layout.tsx?raw";
import tvAppSrc from "./components/tv/TvApp.tsx?raw";

const counts = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock("./components/TooltipLayer", () => ({ default: () => null }));
vi.mock("./components/Home", () => ({ default: () => null }));
vi.mock("./components/tv/TvApp", () => ({ default: () => null }));
vi.mock("./components/tv/TvLogin", () => ({ default: () => null }));
vi.mock("./components/ProxyNoticeBanner", () => ({ default: () => null }));
vi.mock("./components/Sidebar", () => ({ default: () => <div /> }));
vi.mock("./components/Header", () => ({ default: () => <div /> }));
vi.mock("./components/PlayerBar", () => ({ default: () => <div /> }));
vi.mock("./components/NowPlayingDrawer", () => ({ default: () => <div /> }));
vi.mock("./components/TitleBar", () => ({ default: () => <div /> }));
vi.mock("./components/ResizeEdges", () => ({ default: () => <div /> }));
vi.mock("./components/MaximizedPlayer", () => ({ default: () => <div /> }));
vi.mock("./components/AppInitializer", () => ({ AppInitializer: () => null }));
vi.mock("./hooks/useMiniplayerEmitter", () => ({
  useMiniplayerEmitter: () => {},
}));
vi.mock("./hooks/useTheme", () => ({ useTheme: () => {} }));
vi.mock("./hooks/useZoom", () => ({ useZoom: () => {} }));
vi.mock("./hooks/useTvLaunch", () => ({ useTvLaunch: () => {} }));
vi.mock("./hooks/useAuth", () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("./components/tv/TvShell", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./components/VideoPlayer", () => ({
  default: function VP() {
    useEffect(() => {
      counts.mounts++;
      return () => {
        counts.unmounts++;
      };
    }, []);
    return null;
  },
}));

afterEach(() => {
  cleanup();
  counts.mounts = 0;
  counts.unmounts = 0;
  localStorage.clear();
  sessionStorage.clear();
});

function setup() {
  const store = createStore();
  store.set(isAuthCheckingAtom, false);
  store.set(isAuthenticatedAtom, true);
  store.set(currentVideoAtom, { id: 1, title: "v" } as TidalVideo);
  render(
    <Provider store={store}>
      <App />
    </Provider>,
  );
  return store;
}

it("desktop: one player while a video is current", () => {
  const store = setup();
  expect(counts).toEqual({ mounts: 1, unmounts: 0 });
  act(() => store.set(currentVideoAtom, null));
  expect(counts).toEqual({ mounts: 1, unmounts: 1 });
});

it("keeps one VideoPlayer mounted across TV mode on/off", () => {
  const store = setup();
  act(() => store.set(tvModeAtom, true));
  act(() => store.set(tvModeAtom, false));
  expect(counts).toEqual({ mounts: 1, unmounts: 0 });
});

it("neither layout renders its own player", () => {
  expect(layoutSrc).not.toMatch(/<VideoPlayer\b/);
  expect(tvAppSrc).not.toMatch(/<VideoPlayer\b/);
});
