import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import TiltCover from "./TiltCover";

describe("TiltCover", () => {
  it("renders a canvas when enabled (default)", () => {
    const { container } = render(
      <TiltCover>
        <div data-testid="child" />
      </TiltCover>,
    );
    expect(container.querySelector("canvas")).not.toBeNull();
  });
});
