import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

vi.mock("./UserMenu", () => ({
  default: () => <div data-testid="user-menu" />,
}));
vi.mock("./SearchBar", () => ({
  default: () => <div data-testid="search-bar" />,
}));

import Header from "./Header";

describe("Header", () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders back and forward buttons with theme tokens", () => {
    const { getByRole } = render(<Header />);
    const backBtn = getByRole("button", { name: /go back/i });
    const forwardBtn = getByRole("button", { name: /go forward/i });

    expect(backBtn.className).toContain("bg-th-inset");
    expect(backBtn.className).toContain("hover:bg-th-inset-hover");
    expect(forwardBtn.className).toContain("bg-th-inset");
    expect(forwardBtn.className).toContain("hover:bg-th-inset-hover");
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
