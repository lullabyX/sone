import { useEffect, type ReactNode } from "react";
import Layout from "./components/Layout";
import TitleBar from "./components/TitleBar";
import ResizeEdges from "./components/ResizeEdges";
import Home from "./components/Home";
import AlbumView from "./components/AlbumView";
import PlaylistView from "./components/PlaylistView";
import FavoritesView from "./components/FavoritesView";
import SearchView from "./components/SearchView";
import ViewAllPage from "./components/ViewAllPage";
import ArtistPage from "./components/ArtistPage";
import ArtistTracksPage from "./components/ArtistTracksPage";
import ProfilePage from "./components/ProfilePage";
import ProfilePlaylistsPage from "./components/ProfilePlaylistsPage";
import MixPage from "./components/MixPage";
import ExplorePage from "./components/ExplorePage";
import ExploreSubPage from "./components/ExploreSubPage";
import FeedPage from "./components/FeedPage";
import LibraryViewAll from "./components/LibraryViewAll";
import Login from "./components/Login";
import { AppInitializer } from "./components/AppInitializer";
import TooltipLayer from "./components/TooltipLayer";
import { useAuth } from "./hooks/useAuth";
import { useNavigation } from "./hooks/useNavigation";
import { useAtomValue } from "jotai";
import { currentViewAtom } from "./atoms/navigation";
import { isAuthCheckingAtom } from "./atoms/auth";
import { decorationsAtom, hideTitleBarAtom } from "./atoms/ui";
import { ToastProvider } from "./contexts/ToastContext";
import { useTheme } from "./hooks/useTheme";
import { useZoom } from "./hooks/useZoom";
import ErrorBoundary from "./components/ErrorBoundary";
import "./App.css";

function AppChrome({ children }: { children: ReactNode }) {
  const nativeChrome = useAtomValue(decorationsAtom);
  const hideTitleBar = useAtomValue(hideTitleBarAtom);
  return (
    <div className="relative flex flex-col h-full w-full overflow-hidden">
      {!nativeChrome && !hideTitleBar && <TitleBar />}
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      {!nativeChrome && <ResizeEdges top={4} bottom={4} left={4} right={2} />}
    </div>
  );
}

function AppContent() {
  const { isAuthenticated } = useAuth();
  const isAuthChecking = useAtomValue(isAuthCheckingAtom);
  const { navigateHome, navigateToExplore } = useNavigation();
  const currentView = useAtomValue(currentViewAtom);

  if (isAuthChecking) {
    return (
      <AppChrome>
        <div className="flex h-full w-full items-center justify-center bg-th-background">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-th-accent border-t-transparent" />
        </div>
      </AppChrome>
    );
  }

  if (!isAuthenticated) {
    return (
      <AppChrome>
        <Login />
      </AppChrome>
    );
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
      case "profile":
        return <ProfilePage onBack={navigateHome} />;
      case "profilePlaylists":
        return (
          <ProfilePlaylistsPage
            playlists={currentView.playlists}
            profileName={currentView.profileName}
          />
        );
      case "explore":
        return <ExplorePage />;
      case "feed":
        return <FeedPage />;
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
