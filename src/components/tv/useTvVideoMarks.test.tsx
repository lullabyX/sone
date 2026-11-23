import { afterEach, expect, it } from "vitest";
import type { TidalVideo } from "../../types";
import { useTvVideoMarks } from "./useTvVideoMarks";
import { renderTv, setupTvTest } from "./tvTestUtils";

setupTvTest();

let dialog: HTMLElement;
afterEach(() => dialog?.remove());

function Host({ v }: { v: TidalVideo | null }) {
  useTvVideoMarks(v);
  return null;
}

it("marks the video player, and strips every TV mark when TV mode ends", () => {
  dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.appendChild(document.createElement("video"));
  document.body.appendChild(dialog);

  const { unmount } = renderTv(<Host v={{ id: 1 } as TidalVideo} />);
  expect(dialog.hasAttribute("data-tv-video")).toBe(true);
  expect(dialog.hasAttribute("data-tv-native")).toBe(true);

  dialog.setAttribute("data-tv-video-mini", "");
  dialog.style.setProperty("--tv-mini-x", "4px");
  unmount();
  expect(
    ["data-tv-video", "data-tv-native", "data-tv-video-mini"].some((a) =>
      dialog.hasAttribute(a),
    ),
  ).toBe(false);
  expect(dialog.style.getPropertyValue("--tv-mini-x")).toBe("");
});
