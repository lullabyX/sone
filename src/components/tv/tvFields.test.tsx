import { expect, it, vi } from "vitest";
import { useState } from "react";
import { act, screen } from "@testing-library/react";
import { fieldLabel, setNativeInputValue } from "./tvFields";
import { renderTv, setupTvTest } from "./tvTestUtils";

setupTvTest();
it("writes a value React sees", () => {
  const onChange = vi.fn();
  function Port() {
    const [v, setV] = useState("8080");
    return <input type="number" placeholder="port" value={v} onChange={(e) => { onChange(e.target.value); setV(e.target.value); }} />;
  }
  renderTv(<Port />);
  const el = screen.getByPlaceholderText("port") as HTMLInputElement;
  act(() => setNativeInputValue(el, "3128"));
  expect(onChange).toHaveBeenCalledWith("3128");
  expect(el.value).toBe("3128");
});
it("labels a field from its row", () => {
  renderTv(<div><span>Status text</span><input /></div>);
  const boxes = screen.getAllByRole("textbox");
  expect(fieldLabel(boxes[boxes.length - 1] as HTMLInputElement)).toBe("Status text");
});
it("skips punctuation-only siblings", () => {
  renderTv(<div><input placeholder="host" /><span>:</span><input placeholder="port" /></div>);
  expect(fieldLabel(screen.getByPlaceholderText("port") as HTMLInputElement)).toBe("port");
});
