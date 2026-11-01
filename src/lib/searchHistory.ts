// Recent searches, shared by the desktop search bar and TV Search.
const HISTORY_KEY = "sone.search-history";
const MAX_HISTORY = 10;

function save(history: string[]) {
  try {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(history.slice(0, MAX_HISTORY)),
    );
  } catch {}
}

export function loadSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed))
        return parsed
          .filter((s): s is string => typeof s === "string")
          .slice(0, MAX_HISTORY);
    }
  } catch {}
  return [];
}

export function addToSearchHistory(prev: string[], q: string): string[] {
  const trimmed = q.trim();
  if (!trimmed) return prev;
  const next = [
    trimmed,
    ...prev.filter((h) => h.toLowerCase() !== trimmed.toLowerCase()),
  ].slice(0, MAX_HISTORY);
  save(next);
  return next;
}

export function removeFromSearchHistory(prev: string[], q: string): string[] {
  const next = prev.filter((h) => h !== q);
  save(next);
  return next;
}

export function clearSearchHistory(): string[] {
  save([]);
  return [];
}
