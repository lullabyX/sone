import { useRef } from "react";
import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { createStore } from "jotai";
import { useShortcuts } from "../../hooks/useShortcuts";
import { DEFAULT_BINDINGS, shortcutsAtom } from "../../lib/shortcuts";
import { useTvLocalNav } from "./useTvLocalNav";
import { pressKey, renderTv, setupTvTest, stubLayout } from "./tvTestUtils";

setupTvTest();
function Shortcuts({ nextTrack }: { nextTrack: () => void }) {
  useShortcuts({ nextTrack });
  return null;
}
function Screen() {
  const ref = useRef<HTMLDivElement>(null);
  useTvLocalNav(ref, null);
  return (
    <div ref={ref}>
      <button data-tv-focusable data-box="0,0,100,40">
        A
      </button>
      <button data-tv-focusable data-box="120,0,100,40">
        B
      </button>
    </div>
  );
}
it("a bare-arrow desktop shortcut does not fire on the sign-in screen", () => {
  const restore = stubLayout();
  const store = createStore();
  store.set(shortcutsAtom, {
    ...DEFAULT_BINDINGS,
    nextTrack: { code: "ArrowRight", mod: false, shift: false, alt: false },
  });
  const nextTrack = vi.fn();
  renderTv(<Shortcuts nextTrack={nextTrack} />, { store }); // registers first, as AppInitializer does
  renderTv(<Screen />, { store });
  const a = screen.getByText("A");
  a.focus();
  pressKey(a, { key: "ArrowRight", code: "ArrowRight" });
  expect(document.activeElement).toBe(screen.getByText("B"));
  expect(nextTrack).not.toHaveBeenCalled();
  restore();
});
