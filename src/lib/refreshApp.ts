import { clearAllCache } from "../api/tidal";

// Shared by the refresh shortcut and Settings → Utilities → "Refresh App" so the
// two can't drift apart. A failed disk-cache clear must still reload.
export async function refreshApp(): Promise<void> {
  try {
    await clearAllCache();
  } catch {
    // Backend unreachable — reload anyway; the frontend cache is already gone.
  }
  window.location.reload();
}
