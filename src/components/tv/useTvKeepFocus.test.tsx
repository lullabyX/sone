import { expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { setupTvTest, stubLayout } from "./tvTestUtils";
import { useTvKeepFocus } from "./useTvKeepFocus";

setupTvTest();

function Player({ rows, menu }: { rows: string[]; menu: boolean }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useTvKeepFocus(root, true);
  return (
    <>
      <div ref={setRoot}>
        <button data-tv-focusable data-tv-autofocus>
          Play
        </button>
        <div data-tv-keep-list>
          {rows.map((r, i) => (
            <div key={r} data-tv-index={i}>
              <button data-tv-focusable>{r}</button>
            </div>
          ))}
        </div>
      </div>
      {menu && <button data-tv-focusable>Menu item</button>}
    </>
  );
}

it("a row gone while a menu had focus gets its stand-in once the menu closes", async () => {
  const restore = stubLayout();
  try {
    const { rerender } = render(<Player rows={["A", "B", "C"]} menu />);
    act(() => screen.getByRole("button", { name: "B" }).focus());
    act(() => screen.getByRole("button", { name: "Menu item" }).focus());

    rerender(<Player rows={["A", "C"]} menu />);
    await act(async () => {});
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Menu item" }),
    );

    rerender(<Player rows={["A", "C"]} menu={false} />);
    await act(async () => {});
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "C" }),
    );
  } finally {
    restore();
  }
});

it("leaves focus that went outside the player alone while its row stays", async () => {
  const restore = stubLayout();
  try {
    const { rerender } = render(<Player rows={["A", "B"]} menu />);
    act(() => screen.getByRole("button", { name: "B" }).focus());
    act(() => screen.getByRole("button", { name: "Menu item" }).focus());
    rerender(<Player rows={["A", "B"]} menu={false} />);
    await act(async () => {});
    expect(document.activeElement).toBe(document.body);
  } finally {
    restore();
  }
});
