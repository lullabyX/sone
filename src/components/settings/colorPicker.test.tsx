import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ColorPicker, { hsvToHex, hexToHsv } from "./ColorPicker";
import { fieldLabel } from "../tv/tvFields";

afterEach(cleanup);

it("names its hex field, so a TV prompt is titled by it", () => {
  render(<ColorPicker value="#A855F7" onChange={() => {}} />);
  const hex = screen.getByRole("textbox", { name: "Hex color" });
  expect(fieldLabel(hex as HTMLInputElement)).toBe("Hex color");
});

describe("hsv/hex conversion", () => {
  it("round-trips a known accent", () => {
    const { h, s, v } = hexToHsv("#A855F7");
    expect(hsvToHex(h, s, v).toLowerCase()).toBe("#a855f7");
  });
  it("maps pure red", () => {
    expect(hsvToHex(0, 1, 1).toLowerCase()).toBe("#ff0000");
  });
  it("maps black and white", () => {
    expect(hsvToHex(0, 0, 0).toLowerCase()).toBe("#000000");
    expect(hsvToHex(0, 0, 1).toLowerCase()).toBe("#ffffff");
  });
});
