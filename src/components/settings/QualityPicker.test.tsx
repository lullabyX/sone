import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const invokeMock = vi.fn((..._a: unknown[]) => Promise.resolve(undefined));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));

import QualityPicker from "./QualityPicker";

beforeEach(() => invokeMock.mockClear());
afterEach(() => cleanup());

describe("QualityPicker", () => {
  it("renders the three SONE tiers", () => {
    render(<QualityPicker />);
    expect(screen.getByText("High")).toBeTruthy();
    expect(screen.getByText("Lossless")).toBeTruthy();
    expect(screen.getByText("Hi-Res Lossless")).toBeTruthy();
  });

  it("selecting a tier calls set_max_quality with its id", () => {
    render(<QualityPicker />);
    fireEvent.click(screen.getByText("High"));
    expect(invokeMock).toHaveBeenCalledWith("set_max_quality", {
      quality: "HIGH",
    });
  });
});
