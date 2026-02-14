import { useEffect, useState } from "react";
import Layout from "./components/Layout";
import Home from "./components/Home";
import AlbumView from "./components/AlbumView";
import PlaylistView from "./components/PlaylistView";
import FavoritesView from "./components/FavoritesView";
import SearchView from "./components/SearchView";
import ViewAllPage from "./components/ViewAllPage";
import ArtistPage from "./components/ArtistPage";
import MixPage from "./components/MixPage";
import TrackRadioPage from "./components/TrackRadioPage";
import ExplorePage from "./components/ExplorePage";
import ExploreSubPage from "./components/ExploreSubPage";
import Login from "./components/Login";
import { AppInitializer } from "./components/AppInitializer";
import { useAuth } from "./hooks/useAuth";
import { useNavigation } from "./hooks/useNavigation";
import { ToastProvider } from "./contexts/ToastContext";
import { useTheme } from "./hooks/useTheme";
import "./App.css";

const ZOOM_KEY = "tide-vibe.zoom.v1";
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
  }, [zoom]);

  useEffect(() => {
    try {
      localStorage.setItem(ZOOM_KEY, String(zoom));
    } catch {}
  }, [zoom]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (!e.ctrlKey && !e.metaKey) return;

      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setZoom((z) =>
          Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100)
        );
      } else if (e.key === "-") {
        e.preventDefault();
        setZoom((z) =>
          Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100)
        );
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(1.0);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}

function AppContent() {
  const { isAuthenticated } = useAuth();
  const { currentView, navigateHome, navigateToExplore } = useNavigation();

  if (!isAuthenticated) {
    return <Login />;
  }

  const renderView = () => {
    switch (currentView.type) {
      case "album":
        return (
          <AlbumView
            albumId={currentView.albumId}
            albumInfo={currentView.albumInfo}
            onBack={navigateHome}
          />
        );
      case "playlist":
        return (
          <PlaylistView
            playlistId={currentView.playlistId}
            playlistInfo={currentView.playlistInfo}
            onBack={navigateHome}
          />
        );
      case "favorites":
        return <FavoritesView onBack={navigateHome} />;
      case "search":
        return <SearchView query={currentView.query} onBack={navigateHome} />;
      case "viewAll":
        return (
          <ViewAllPage
            title={currentView.title}
            apiPath={currentView.apiPath}
            onBack={navigateHome}
          />
        );
      case "artist":
        return (
          <ArtistPage
            artistId={currentView.artistId}
            artistInfo={currentView.artistInfo}
            onBack={navigateHome}
          />
        );
      case "mix":
        return (
          <MixPage
            mixId={currentView.mixId}
            mixInfo={currentView.mixInfo}
            onBack={navigateHome}
          />
        );
      case "trackRadio":
        return (
          <TrackRadioPage
            trackId={currentView.trackId}
            trackInfo={currentView.trackInfo}
            onBack={navigateHome}
          />
        );
      case "explore":
        return <ExplorePage />;
      case "explorePage":
        return (
          <ExploreSubPage
            apiPath={currentView.apiPath}
            title={currentView.title}
            onBack={navigateToExplore}
          />
        );
      case "home":
      default:
        return <Home />;
    }
  };

  return <Layout>{renderView()}</Layout>;
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
      <AppContent />
    </ToastProvider>
  );
}

export default App;
