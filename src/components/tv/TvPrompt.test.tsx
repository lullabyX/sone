import { fireEvent, getDefaultNormalizer, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import TvPrompt, { type TvPromptRequest } from "./TvPrompt";
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

function renderPrompt(request: TvPromptRequest) {
  const onDone = vi.fn();
  renderTv(<TvPrompt request={request} onDone={onDone} />);
  return onDone;
}

it("keeps untrimmed text when asked", () => {
  const onDone = renderPrompt({ title: "Username", initial: " a ", confirm: "Done", allowEmpty: true, trim: false });
  const input = screen.getByDisplayValue(" a ", { normalizer: getDefaultNormalizer({ trim: false }) });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onDone).toHaveBeenLastCalledWith(" a ");
});

it("accepts empty text when allowed", () => {
  const onDone = renderPrompt({ title: "Username", initial: "", confirm: "Done", allowEmpty: true });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(onDone).toHaveBeenLastCalledWith("");
});

it("masks secret text", () => {
  renderPrompt({ title: "Password", initial: "x", confirm: "Done", secret: true });
  expect(screen.getByDisplayValue("x").getAttribute("type")).toBe("password");
});

it("caps keyboard edits at maxLength", () => {
  renderPrompt({ title: "Hex", initial: "#123456", confirm: "Done", maxLength: 7 });
  fireEvent.click(screen.getByText("a"));
  expect(screen.getByDisplayValue("#123456")).toBeTruthy();
});
