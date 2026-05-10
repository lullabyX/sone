// Helpers for safely working with SoneError values that arrive over Tauri IPC.
//
// SoneError is serialized as { kind: "Api" | "Parse" | ..., message: string | { status, body } }.
// For SoneError::Api, `message` is an object — passing it to setError(string) and rendering
// it crashes React with "Objects are not valid as a React child" and unmounts the tree.

interface ApiErrorMessage {
  status: number;
  body: string;
}

interface SoneErrorShape {
  kind: string;
  message: string | ApiErrorMessage;
}

function isSoneError(err: unknown): err is SoneErrorShape {
  return (
    typeof err === "object" &&
    err !== null &&
    "kind" in err &&
    "message" in err &&
    typeof (err as { kind: unknown }).kind === "string"
  );
}

export function getApiStatus(err: unknown): number | null {
  if (!isSoneError(err)) return null;
  if (err.kind !== "Api") return null;
  const msg = err.message;
  if (typeof msg === "object" && msg !== null && typeof msg.status === "number") {
    return msg.status;
  }
  return null;
}

export function safeErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === "string") return err;
  if (isSoneError(err)) {
    const msg = err.message;
    if (typeof msg === "string") return msg;
    if (typeof msg === "object" && msg !== null && typeof msg.body === "string") {
      return msg.body || fallback;
    }
    return fallback;
  }
  if (err instanceof Error && typeof err.message === "string") return err.message;
  return fallback;
}

export function formatSoneError(err: unknown): string {
  const parsed =
    typeof err === "string"
      ? (() => {
          try {
            return JSON.parse(err);
          } catch {
            return null;
          }
        })()
      : err;

  const msg = (parsed as { message?: unknown })?.message;

  if (typeof msg === "string") return msg;
  if (msg && typeof msg === "object") {
    const body = (msg as { body?: unknown }).body;
    return typeof body === "string" ? body : JSON.stringify(body);
  }
  return typeof err === "string" ? err : "An unexpected error occurred";
}
