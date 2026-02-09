import Layout from "./components/Layout";
import Home from "./components/Home";
import AlbumView from "./components/AlbumView";
import FavoritesView from "./components/FavoritesView";
import Login from "./components/Login";
import { AudioProvider, useAudioContext } from "./contexts/AudioContext";
import "./App.css";

function AppContent() {
  const { isAuthenticated, currentView, navigateHome } = useAudioContext();

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
      case "favorites":
        return <FavoritesView onBack={navigateHome} />;
      case "home":
      default:
        return <Home />;
    }
  };

  return <Layout>{renderView()}</Layout>;
}

function App() {
  return (
    <AudioProvider>
      <AppContent />
    </AudioProvider>
  );
}

export default App;
