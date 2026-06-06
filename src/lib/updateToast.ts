export const MAX_UPDATE_TOAST_SHOWS = 3;

export interface UpdateInfo {
  available: boolean;
  current: string;
  latest: string;
  url: string;
}

export interface SeenUpdate {
  version: string;
  count: number;
}

/**
 * Decide whether to show the update toast and what the next persisted counter
 * should be. Shows up to MAX_UPDATE_TOAST_SHOWS times per `latest` version; a
 * newer `latest` resets the count.
 */
export function shouldShowUpdateToast(
  info: UpdateInfo,
  seen: SeenUpdate,
): { show: boolean; next: SeenUpdate } {
  if (!info.available) return { show: false, next: seen };

  const count = seen.version === info.latest ? seen.count : 0;
  if (count >= MAX_UPDATE_TOAST_SHOWS) {
    return { show: false, next: { version: info.latest, count } };
  }
  return { show: true, next: { version: info.latest, count: count + 1 } };
}
