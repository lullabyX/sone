import { describe, it, expect, vi, afterEach } from "vitest";
import {
  trackWindowFocus,
  isWindowActive,
  onWindowActiveChange,
} from "./windowFocus";

describe("windowFocus", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("notifies subscribers on blur and focus", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    trackWindowFocus();
    const seen: boolean[] = [];
    const off = onWindowActiveChange((a) => seen.push(a));
    (document.hasFocus as any).mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));
    expect(isWindowActive()).toBe(false);
    (document.hasFocus as any).mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    expect(seen).toEqual([false, true]);
    off();
    window.dispatchEvent(new Event("blur"));
    expect(seen).toEqual([false, true]);
  });
});
