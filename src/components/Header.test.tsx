import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

vi.mock("./UserMenu", () => ({
  default: () => <div />,
}));
vi.mock("./SearchBar", () => ({
  default: () => <div />,
}));

import Header from "./Header";

describe("Header", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders back and forward buttons with theme tokens", () => {
    const { getByRole } = render(<Header />);
    const backBtn = getByRole("button", { name: /go back/i });
    const forwardBtn = getByRole("button", { name: /go forward/i });

    for (const btn of [backBtn, forwardBtn]) {
      // classList matches whole tokens; a `className.includes` check would be
      // satisfied by the `hover:` variant alone and never fail.
      expect(btn.classList.contains("bg-th-inset")).toBe(true);
      expect(btn.classList.contains("hover:bg-th-inset-hover")).toBe(true);
      expect(btn.className).not.toContain("bg-black");
    }
  });

  it("calls window.history.back and forward on click", () => {
    const backSpy = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => {});
    const forwardSpy = vi
      .spyOn(window.history, "forward")
      .mockImplementation(() => {});

    const { getByRole } = render(<Header />);
    const backBtn = getByRole("button", { name: /go back/i });
    const forwardBtn = getByRole("button", { name: /go forward/i });

    fireEvent.click(backBtn);
    expect(backSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(forwardBtn);
    expect(forwardSpy).toHaveBeenCalledTimes(1);
  });
});
