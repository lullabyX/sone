import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import AiBadge from "./AiBadge";

afterEach(cleanup);

describe("AiBadge", () => {
  it("renders the AI label with an accessible name", () => {
    const { getByLabelText } = render(<AiBadge />);
    expect(getByLabelText("AI-generated").textContent).toBe("AI");
  });
});
