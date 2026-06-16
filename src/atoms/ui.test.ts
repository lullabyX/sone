import { describe, it, expect } from "vitest";
import { createStore } from "jotai";
import { videoCoversAtom } from "./ui";

describe("videoCoversAtom", () => {
  it("defaults to true (animated covers on)", () => {
    const store = createStore();
    expect(store.get(videoCoversAtom)).toBe(true);
  });
});
