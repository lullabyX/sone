import ReactDOM from "react-dom/client";
import "./miniplayer.css";
import MiniPlayer from "./components/MiniPlayer";

document.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <MiniPlayer />,
);
