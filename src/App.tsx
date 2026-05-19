import { useEffect, useState } from "react";
import Layout from "./components/Layout";
import Home from "./components/Home";
import AlbumView from "./components/AlbumView";
import PlaylistView from "./components/PlaylistView";
import FavoritesView from "./components/FavoritesView";
import SearchView from "./components/SearchView";
import ViewAllPage from "./components/ViewAllPage";
import ArtistPage from "./components/ArtistPage";
import ArtistTracksPage from "./components/ArtistTracksPage";
import MixPage from "./components/MixPage";
import ExplorePage from "./components/ExplorePage";
import ExploreSubPage from "./components/ExploreSubPage";
import LibraryViewAll from "./components/LibraryViewAll";
import Login from "./components/Login";
import { AppInitializer } from "./components/AppInitializer";
import TooltipLayer from "./components/TooltipLayer";
import { useAuth } from "./hooks/useAuth";
import { useNavigation } from "./hooks/useNavigation";
import { useShortcuts } from "./hooks/useShortcuts";
import { useAtomValue } from "jotai";
import { isAuthCheckingAtom } from "./atoms/auth";
import { ToastProvider } from "./contexts/ToastContext";
import { useTheme } from "./hooks/useTheme";
import ErrorBoundary from "./components/ErrorBoundary";
import "./App.css";

const ZOOM_KEY = "sone.zoom.v1";
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;

function useZoom() {
  const [zoom, setZoom] = useState(() => {
    try {
      const saved = localStorage.getItem(ZOOM_KEY);
      if (saved) {
        const val = Number(saved);
        if (!Number.isNaN(val) && val >= ZOOM_MIN && val <= ZOOM_MAX)
          return val;
      }
    } catch {}
    return 1.0;
  });

  useEffect(() => {
    document.documentElement.style.zoom = String(zoom);
    document.documentElement.style.setProperty("--zoom", String(zoom));
  }, [zoom]);

  useEffect(() => {
    try {
      localStorage.setItem(ZOOM_KEY, String(zoom));
    } catch {}
  }, [zoom]);

  useShortcuts({
    zoomIn: () =>
      setZoom((z) =>
        Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100),
      ),
    zoomOut: () =>
      setZoom((z) =>
        Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100),
      ),
    zoomReset: () => setZoom(1.0),
  });
}

function AppContent() {
  const { isAuthenticated } = useAuth();
  const isAuthChecking = useAtomValue(isAuthCheckingAtom);
  const { currentView, navigateHome, navigateToExplore } = useNavigation();

  if (isAuthChecking) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-th-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-th-accent border-t-transparent" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Login />;
  }

  const renderView = () => {
    switch (currentView.type) {
      case "album":
        return (
          <AlbumView
            key={currentView.albumId}
            albumId={currentView.albumId}
            albumInfo={currentView.albumInfo}
            onBack={navigateHome}
          />
        );
      case "playlist":
        return (
          <PlaylistView
            key={currentView.playlistId}
            playlistId={currentView.playlistId}
            playlistInfo={currentView.playlistInfo}
            onBack={navigateHome}
          />
        );
      case "favorites":
        return <FavoritesView onBack={navigateHome} />;
      case "search":
        return (
          <SearchView
            key={currentView.query}
            query={currentView.query}
            initialTab={currentView.tab}
            onBack={navigateHome}
          />
        );
      case "viewAll":
        return (
          <ViewAllPage
            key={currentView.apiPath}
            title={currentView.title}
            apiPath={currentView.apiPath}
            artistId={currentView.artistId}
            onBack={navigateHome}
          />
        );
      case "artist":
        return (
          <ArtistPage
            key={currentView.artistId}
            artistId={currentView.artistId}
            artistInfo={currentView.artistInfo}
            onBack={navigateHome}
          />
        );
      case "artistTracks":
        return (
          <ArtistTracksPage
            key={currentView.artistId}
            artistId={currentView.artistId}
            artistName={currentView.artistName}
          />
        );
      case "mix":
        return (
          <MixPage
            key={currentView.mixId}
            mixId={currentView.mixId}
            mixInfo={currentView.mixInfo}
            onBack={navigateHome}
          />
        );
      case "explore":
        return <ExplorePage />;
      case "explorePage":
        return (
          <ExploreSubPage
            key={currentView.apiPath}
            apiPath={currentView.apiPath}
            title={currentView.title}
            onBack={navigateToExplore}
          />
        );
      case "libraryViewAll":
        return (
          <LibraryViewAll
            key={`${currentView.libraryType}:${currentView.folderId ?? "root"}`}
            libraryType={currentView.libraryType}
            folderId={currentView.folderId}
            folderName={currentView.folderName}
          />
        );
      case "home":
      default:
        return <Home />;
    }
  };

  const resetKey = JSON.stringify(currentView);

  return (
    <Layout>
      <ErrorBoundary resetKey={resetKey} onGoHome={navigateHome}>
        {renderView()}
      </ErrorBoundary>
    </Layout>
  );
}

function App() {
  useZoom();
  useTheme();

  // Disable the default browser/webview context menu globally
  useEffect(() => {
    const handler = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

  return (
    <ToastProvider>
      <AppInitializer />
      <TooltipLayer />
      <AppContent />
    </ToastProvider>
  );
}

export default App;
