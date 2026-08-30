import ReactDOM from "react-dom/client";
import App from "./App";
import { bootstrapThemeFile } from "./lib/themeFile";

/**
 * Resolve the external theme file (~/.config/sone/theme.json) BEFORE the
 * first render so themeAtom's synchronous localStorage hydration already
 * reflects the file's theme.
 *
 * Also in promise so a stuck IPC cannot block startup.
 */
async function main() {
  await Promise.race([
    bootstrapThemeFile(),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <App />,
  );
}

void main();
