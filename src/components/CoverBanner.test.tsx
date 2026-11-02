import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
const bake = vi.fn();
vi.mock("../lib/coverBlur", () => ({
  bakeBlurredCover: (...a: unknown[]) => bake(...a),
}));
import CoverBanner from "./CoverBanner";
afterEach(cleanup);
describe("CoverBanner", () => {
  it("renders nothing without a source", () => {
    expect(
      render(<CoverBanner src={undefined} />).container.firstChild,
    ).toBeNull();
  });
  it("fades the baked canvas in", async () => {
    const baked = document.createElement("canvas");
    baked.width = 128;
    baked.height = 128;
    bake.mockResolvedValue(baked);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as any);
    const { getByTestId } = render(<CoverBanner src="img" />);
    expect(getByTestId("cover-blur").style.opacity).toBe("0");
    await waitFor(() =>
      expect(getByTestId("cover-blur").style.opacity).toBe("1"),
    );
    expect(getByTestId("cover-blur").getAttribute("width")).toBe("128");
  });
  it("dark variant still uses the image", () => {
    const { container } = render(<CoverBanner src="img" variant="dark" />);
    expect(container.querySelector("canvas")).toBeNull();
  });
});
