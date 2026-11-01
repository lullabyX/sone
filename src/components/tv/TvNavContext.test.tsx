import { act } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TvScreenContext, useTvInitialFocus } from "./TvNavContext";
import { renderTv, setupTvTest, stubLayout } from "./tvTestUtils";

setupTvTest();
let restore: () => void;
beforeEach(() => (restore = stubLayout()));
afterEach(() => {
  restore();
  document.body.innerHTML = "";
});
const frame = () =>
  act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
function setup(outside: string) {
  const host = document.createElement("div");
  host.innerHTML = `${outside}<div id="screen"><button data-tv-focusable>card</button></div>`;
  document.body.append(host);
  const el = host.querySelector<HTMLElement>("#screen")!;
  const ctx = { active: true, element: () => el };
  const ui = (ready: boolean) => (
    <TvScreenContext.Provider value={ctx}>
      <Screen ready={ready} />
    </TvScreenContext.Provider>
  );
  const r = renderTv(ui(false));
  return {
    host,
    show: async () => {
      r.rerender(ui(true));
      await frame();
    },
  };
}
// `ready` is a prop changed through rerender: a component that stores its setter in an outer
// variable during render fails `react-hooks/globals`.
function Screen({ ready }: { ready: boolean }) {
  useTvInitialFocus(ready);
  return null;
}
it("leaves focus in the rail while the screen loads", async () => {
  const { host, show } = setup(
    `<nav data-tv-rail data-tv-side><button data-tv-focusable>Home</button></nav>`,
  );
  host.querySelector<HTMLElement>("nav button")!.focus();
  await show();
  expect(document.activeElement?.textContent).toBe("Home");
});
it("leaves focus in an open menu", async () => {
  const { host, show } = setup(
    `<div data-tv-modal><button>Cancel</button></div>`,
  );
  host.querySelector<HTMLElement>("[data-tv-modal] button")!.focus();
  await show();
  expect(document.activeElement?.textContent).toBe("Cancel");
});
it("leaves focus on the mini bar", async () => {
  const { host, show } = setup(
    `<div data-tv-dock><button data-tv-focusable>Play</button></div>`,
  );
  host.querySelector<HTMLElement>("[data-tv-dock] button")!.focus();
  await show();
  expect(document.activeElement?.textContent).toBe("Play");
});
it("takes focus from a hidden screen's side panel", async () => {
  const { host, show } = setup(
    `<div class="hidden"><aside data-tv-side><button data-tv-focusable>Play</button></aside></div>`,
  );
  host.querySelector<HTMLElement>("aside button")!.focus();
  await show();
  expect(document.activeElement?.textContent).toBe("card");
});
