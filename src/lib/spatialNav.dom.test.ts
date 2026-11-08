import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setupTvTest, stubLayout } from "../components/tv/tvTestUtils";
import { dockFallback, moveFocus, rememberFocus } from "./spatialNav";

setupTvTest();

describe("side panels", () => {
  const onFocusIn = (e: FocusEvent) => rememberFocus(e.target as HTMLElement);
  let restore: () => void;
  let root: HTMLElement;

  beforeEach(() => {
    restore = stubLayout();
    document.addEventListener("focusin", onFocusIn);
    document.body.innerHTML = `
  <div id="root">
    <nav data-tv-remember data-tv-side>
      <button id="home" data-tv-focusable data-tv-default aria-current="page" data-box="0,100,100,40">Home</button>
      <button id="search" data-tv-focusable data-box="0,150,100,40">Search</button>
      <button id="settings" data-tv-focusable data-box="0,200,100,40">Settings</button>
      <button id="exit" data-tv-focusable data-box="0,900,100,40">Exit</button>
    </nav>
    <main data-tv-remember>
      <button id="above" data-tv-focusable data-box="200,-300,100,100">above</button>
      <button id="c1" data-tv-focusable data-box="200,120,100,100">c1</button>
      <button id="below" data-tv-focusable data-box="200,1000,100,100">below</button>
    </main>
  </div>`;
    root = document.getElementById("root")!;
  });

  afterEach(() => {
    restore();
    document.removeEventListener("focusin", onFocusIn);
    document.body.innerHTML = "";
  });

  const focus = (id: string) => document.getElementById(id)!.focus();
  const active = () => document.activeElement?.id;

  describe("moveFocus with a side panel", () => {
    it("Up on the top rail item stays put", () => {
      focus("home");
      expect(moveFocus(root, "up")).toBe(false);
      expect(active()).toBe("home");
    });

    it("Down on the last rail item stays put", () => {
      focus("exit");
      expect(moveFocus(root, "down")).toBe(false);
      expect(active()).toBe("exit");
    });

    it("Left into the rail lands on the current section", () => {
      focus("home");
      moveFocus(root, "down");
      moveFocus(root, "down");
      focus("c1");
      moveFocus(root, "left");
      expect(active()).toBe("home");
    });

    it("Right out of the rail returns to the content's remembered item", () => {
      focus("c1");
      focus("home");
      moveFocus(root, "right");
      expect(active()).toBe("c1");
    });
  });
});

describe("dock", () => {
  let restore: () => void;
  let root: HTMLElement;

  const layout = (screenAttrs = "") => {
    document.body.innerHTML = `
  <div id="root">
    <nav data-tv-side data-tv-remember>
      <button id="home" data-tv-focusable data-box="0,0,100,40">Home</button>
      <button id="exit" data-tv-focusable data-box="0,400,100,40">Exit</button>
    </nav>
    <div class="tv-screen" data-tv-remember ${screenAttrs}>
      <button id="r1" data-tv-focusable data-box="200,0,300,40">r1</button>
      <button id="r2" data-tv-focusable data-box="200,100,300,40">r2</button>
      <aside data-tv-side>
        <button id="aside" data-tv-focusable data-box="600,100,100,40">aside</button>
      </aside>
    </div>
    <div data-tv-dock data-tv-remember>
      <button id="open" data-tv-focusable data-box="0,1000,300,40">Open</button>
      <button id="prev" data-tv-focusable data-box="400,1000,40,40">Previous</button>
      <button id="play" data-tv-focusable data-tv-default data-box="460,1000,40,40">Play</button>
      <button id="next" data-tv-focusable data-box="520,1000,40,40">Next</button>
    </div>
  </div>`;
    return document.getElementById("root")!;
  };

  beforeEach(() => {
    restore = stubLayout();
    root = layout();
  });

  afterEach(() => {
    restore();
    document.body.innerHTML = "";
  });

  const focus = (id: string) => {
    const el = document.getElementById(id)!;
    el.focus();
    rememberFocus(el);
  };
  const active = () => document.activeElement?.id;

  it("moveFocus never enters the dock from content", () => {
    focus("r2");
    expect(moveFocus(root, "down")).toBe(false);
    expect(active()).toBe("r2");
  });

  it("fallback lands on the dock default; Up returns to the remembered row", () => {
    focus("r1");
    focus("r2");
    expect(dockFallback(root, { repeat: false })).toBe(true);
    expect(active()).toBe("play");
    expect(moveFocus(root, "up")).toBe(true);
    expect(active()).toBe("r2");
  });

  it("no fallback on a repeat", () => {
    focus("r2");
    expect(dockFallback(root, { repeat: true })).toBe(false);
    expect(active()).toBe("r2");
  });

  it("no fallback from the rail (Task 29 clamp kept)", () => {
    focus("exit");
    expect(dockFallback(root, { repeat: false })).toBe(false);
    expect(active()).toBe("exit");
  });

  it("no fallback from a side panel in the screen", () => {
    focus("aside");
    expect(dockFallback(root, { repeat: false })).toBe(false);
  });

  it("no fallback while the screen loads more", () => {
    root = layout("data-tv-loading");
    focus("r2");
    expect(dockFallback(root, { repeat: false })).toBe(false);
    expect(active()).toBe("r2");
  });

  it("inside the dock: Left/Right stay in it, Down does nothing", () => {
    focus("prev");
    expect(moveFocus(root, "down")).toBe(false);
    expect(dockFallback(root, { repeat: false })).toBe(false);
    expect(active()).toBe("prev");
    expect(moveFocus(root, "right")).toBe(true);
    expect(active()).toBe("play");
    focus("open");
    expect(moveFocus(root, "left")).toBe(false);
    expect(active()).toBe("open");
  });
});

describe("clipped containers", () => {
  let restore: () => void;
  let root: HTMLElement;

  beforeEach(() => {
    restore = stubLayout();
    document.body.innerHTML = `
  <div id="root">
    <div data-tv-clip data-box="0,0,300,200">
      <button id="line1" data-tv-focusable data-box="0,50,300,40">line1</button>
      <button id="line2" data-tv-focusable data-box="0,150,300,40">line2</button>
      <button id="clipped" data-tv-focusable data-box="0,250,300,40">clipped</button>
    </div>
    <button id="tab" data-tv-focusable data-box="0,320,300,40">tab</button>
  </div>`;
    root = document.getElementById("root")!;
  });

  afterEach(() => {
    restore();
    document.body.innerHTML = "";
  });

  const focus = (id: string) => document.getElementById(id)!.focus();
  const active = () => document.activeElement?.id;

  it("skips items scrolled out of a clipped container", () => {
    focus("tab");
    expect(moveFocus(root, "up")).toBe(true);
    expect(active()).toBe("line2");
  });

  it("still moves between items inside the container's box", () => {
    focus("line1");
    expect(moveFocus(root, "down")).toBe(true);
    expect(active()).toBe("line2");
  });

  it("from inside it, moves on to items not scrolled in yet, then leaves it", () => {
    focus("line2");
    expect(moveFocus(root, "down")).toBe(true);
    expect(active()).toBe("clipped");
    expect(moveFocus(root, "down")).toBe(true);
    expect(active()).toBe("tab");
  });

  it("moves from a focused item outside the container's box", () => {
    focus("clipped");
    expect(moveFocus(root, "up")).toBe(true);
    expect(active()).toBe("line2");
  });
});

describe("a dialog inside a desktop dialog shown in TV mode", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = stubLayout();
    document.body.innerHTML = `
  <div data-tv-native>
    <button data-box="0,100,50,10">sheet</button>
    <div id="dialog" role="dialog">
      <button id="no" data-box="0,0,50,10">no</button>
      <a id="yes" href="#" data-box="60,0,50,10">yes</a>
    </div>
  </div>`;
  });

  afterEach(() => {
    restore();
    document.body.innerHTML = "";
  });

  it("counts its native controls when it is the scope", () => {
    const dialog = document.getElementById("dialog")!;
    document.getElementById("no")!.focus();
    expect(moveFocus(dialog, "down")).toBe(false);
    expect(moveFocus(dialog, "right")).toBe(true);
    expect(document.activeElement?.id).toBe("yes");
  });
});
