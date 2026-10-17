import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { bootstrapThemeFile } from "./lib/themeFile";
import { trackWindowFocus } from "./lib/windowFocus";

/**
 * Forward uncaught renderer errors to the backend log. The packaged webview
 * has no visible console, so without this a broken boot is completely
 * undiagnosable from the outside (commands/diagnostics.rs receives it).
 * Registered before the app import executes, because a module-eval throw
 * surfaces as an uncaught error here.
 */
function reportFrontendError(kind: string, detail: unknown) {
  try {
    const text = typeof detail === "string" ? detail : String((detail as Error)?.stack ?? detail);
    void invoke("log_frontend_error", { message: `${kind}: ${text}` }).catch(() => {});
  } catch {
    /* reporting must never itself break boot */
  }
}
window.addEventListener("error", (e) =>
  reportFrontendError("error", (e as ErrorEvent).error ?? (e as ErrorEvent).message),
);
window.addEventListener("unhandledrejection", (e) =>
  reportFrontendError("unhandledrejection", (e as PromiseRejectionEvent).reason),
);
const origConsoleError = console.error.bind(console);
console.error = (...rest: unknown[]) => {
  try {
    reportFrontendError("console.error", rest.map(String).join(" "));
  } catch {
    // Reporting must never break the call site.
  }
  origConsoleError(...rest);
};

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
/**
 * Load the optional renderer FPS/long-task monitor when the running instance
 * was started with SONE_PERF_MONITOR=1. The import is dynamic, so the
 * shipped app (no switches) evaluates none of the sampler code.
 */
function maybeStartPerfMonitor(): void {
  void invoke<{ monitor: boolean }>("get_perf_flags")
    .then((flags) => {
      if (flags.monitor) return import("./perf/perfMonitor");
      return undefined;
    })
    .catch(() => {
      /* gating must never break boot */
    });
}

async function main() {
  trackWindowFocus();
  maybeStartPerfMonitor();
  await Promise.race([
    bootstrapThemeFile().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <App />,
  );
}

void main();
