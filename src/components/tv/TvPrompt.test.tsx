import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import TvPrompt from "./TvPrompt";
import { renderTv, setupTvTest } from "./tvTestUtils";

setupTvTest();

it("never submits while composing, and sits above the settings sheet", () => {
  const onDone = vi.fn();
  renderTv(<TvPrompt request={{ title: "Name", initial: "Mix", confirm: "Save" }} onDone={onDone} />);
  const input = screen.getByRole("textbox");
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  expect(onDone).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onDone).toHaveBeenCalledWith("Mix");
  const overlay = screen.getByRole("dialog").parentElement!;
  expect(Number(/z-\[(\d+)\]/.exec(overlay.className)![1])).toBeGreaterThan(9999); // guard: true since Task 3
});
