import ReactDOM from "react-dom/client";
import App from "./App";
import { bootstrapThemeFile } from "./lib/themeFile";
import { trackWindowFocus } from "./lib/windowFocus";

/**
 * Resolve the external theme file before the first render.
 *
 * The gate is load-bearing: the file arrives over async IPC while the first
 * paint is synchronous, so without it a hand-edited theme.json shows up as a
 * visible switch a few hundred ms in. bootstrapThemeFile pushes the resolved
 * theme straight into themeAtom -- the atom is constructed at module-eval,
 * before this runs, so writing localStorage alone would not reach it.
 *
 * Raced against a timeout so a stuck IPC cannot block startup.
 */
async function main() {
  trackWindowFocus();
  await Promise.race([
    bootstrapThemeFile().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <App />,
  );
}

void main();
