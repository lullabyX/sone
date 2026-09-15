// Helpers for safely working with SoneError values that arrive over Tauri IPC.
//
// SoneError is serialized as { kind: "Api" | "Parse" | ..., message: string | object }.
// For SoneError::Api `message` is { status, body }, and for SoneError::ProxyBlocked it is
// { reason } — passing either to setError(string) and rendering it crashes React with
// "Objects are not valid as a React child" and unmounts the tree. Always go through one of
// the accessors below; never read `err.message` directly.

// `message` is deliberately `unknown`: its shape depends on the variant
// (`{ status, body }` for Api, `{ reason }` for ProxyBlocked, a bare string for
// most others), and typing it as a union only invites reading the wrong field
// off the wrong variant. Every accessor below narrows before it reads.
interface SoneErrorShape {
  kind: string;
  message: unknown;
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

/**
 * The reason a request was refused before it left the process, or null.
 *
 * `SoneError` is `#[serde(tag = "kind", content = "message")]`, so
 * `ProxyBlocked { reason }` arrives as `{ kind: "ProxyBlocked", message: { reason } }`
 * — `message` is an OBJECT, exactly like `Api`'s. Interpolating it into a
 * string renders "[object Object]" and handing it to a React child unmounts
 * the tree; this repo has shipped a blank screen from that once already. So the
 * shape is checked rather than assumed, and anything unexpected returns null
 * instead of a stringified object.
 *
 * A blocked proxy is never a property of the thing being fetched: the same
 * refusal applies to every request, so callers must stop rather than advance.
 */
export function getProxyBlockedReason(err: unknown): string | null {
  const parsed =
    typeof err === "string"
      ? (() => {
          try {
            return JSON.parse(err) as unknown;
          } catch {
            return null;
          }
        })()
      : err;
  if (!isSoneError(parsed)) return null;
  if (parsed.kind !== "ProxyBlocked") return null;
  const msg = parsed.message as { reason?: unknown };
  if (
    typeof msg === "object" &&
    msg !== null &&
    typeof msg.reason === "string"
  ) {
    const reason = msg.reason.trim();
    if (reason.length > 0) return reason;
  }
  // The kind is right but the payload is not what the backend promises. Still a
  // block — saying so with a generic reason beats reporting no block at all.
  return "The proxy refused this request";
}

export function getApiStatus(err: unknown): number | null {
  if (!isSoneError(err)) return null;
  if (err.kind !== "Api") return null;
  const msg = err.message as { status?: unknown };
  if (
    typeof msg === "object" &&
    msg !== null &&
    typeof msg.status === "number"
  ) {
    return msg.status;
  }
  return null;
}

// JSON:API error bodies look like { errors: [{ detail, title, ... }] }. Surface
// the human-readable detail(s) instead of the raw JSON envelope.
function apiBodyDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      errors?: Array<{ detail?: string; title?: string }>;
    };
    const direct = (parsed as { userMessage?: unknown })?.userMessage;
    if (typeof direct === "string" && direct.length > 0) return direct;
    if (parsed && Array.isArray(parsed.errors)) {
      const details = parsed.errors
        .map((e) => e.detail || e.title)
        .filter((d): d is string => typeof d === "string" && d.length > 0);
      if (details.length > 0) return details.join("\n");
    }
  } catch {
    // not JSON — fall through to the raw body
  }
  return body;
}

export function safeErrorMessage(err: unknown, fallback: string): string {
  const blocked = getProxyBlockedReason(err);
  if (blocked) return blocked;
  if (typeof err === "string") return err;
  if (isSoneError(err)) {
    const msg = err.message as { body?: unknown };
    if (typeof msg === "string") return msg;
    if (
      typeof msg === "object" &&
      msg !== null &&
      typeof msg.body === "string"
    ) {
      return apiBodyDetail(msg.body) || fallback;
    }
    return fallback;
  }
  if (err instanceof Error && typeof err.message === "string")
    return err.message;
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

  const blocked = getProxyBlockedReason(parsed);
  if (blocked) return blocked;

  const msg = (parsed as { message?: unknown })?.message;

  if (typeof msg === "string") return msg;
  if (msg && typeof msg === "object") {
    const body = (msg as { body?: unknown }).body;
    return typeof body === "string"
      ? apiBodyDetail(body)
      : JSON.stringify(body);
  }
  return typeof err === "string" ? err : "An unexpected error occurred";
}
