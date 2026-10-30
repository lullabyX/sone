import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setupTvTest, stubLayout } from "../components/tv/tvTestUtils";
import { moveFocus, rememberFocus } from "./spatialNav";

setupTvTest();

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
