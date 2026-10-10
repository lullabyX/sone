import { describe, it, expect, beforeEach, vi } from "vitest";
import { createStore } from "jotai";

describe("content atoms hydrate without a subscriber", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("honors a saved allowAi=false on first store.get", async () => {
    localStorage.setItem("sone.allowAi.v1", "false");
    const { allowAiAtom } = await import("./playback");
    expect(createStore().get(allowAiAtom)).toBe(false);
  });

  it("honors a saved allowExplicit=false on first store.get", async () => {
    localStorage.setItem("sone.allowExplicit.v1", "false");
    const { allowExplicitAtom } = await import("./playback");
    expect(createStore().get(allowExplicitAtom)).toBe(false);
  });

  it("defaults allowAi to true", async () => {
    const { allowAiAtom } = await import("./playback");
    expect(createStore().get(allowAiAtom)).toBe(true);
  });
});
