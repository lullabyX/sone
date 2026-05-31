import { describe, it, expect } from "vitest";
import { pickGaplessNext } from "./gaplessPredict";
import type { Track, QueuedTrack } from "../types";

const track = (over: Partial<QueuedTrack> = {}): Track =>
  ({ id: 1, title: "T", ...over }) as unknown as Track;

describe("pickGaplessNext", () => {
  it("returns null on repeat-one (repeat === 2) even when a head exists", () => {
    expect(
      pickGaplessNext({
        repeat: 2,
        manualHead: track(),
        contextHead: null,
        currentSourceId: "src-1",
      }),
    ).toBeNull();
  });

  it("returns an available manual head with no _source", () => {
    const head = track({ id: 7 });
    expect(
      pickGaplessNext({
        repeat: 0,
        manualHead: head,
        contextHead: null,
        currentSourceId: "src-1",
      }),
    ).toBe(head);
  });

  it("returns an available manual head whose _source.id matches the current source", () => {
    const head = track({
      id: 7,
      _source: { type: "ALBUM", id: "src-1", name: "Album" },
    });
    expect(
      pickGaplessNext({
        repeat: 0,
        manualHead: head,
        contextHead: null,
        currentSourceId: "src-1",
      }),
    ).toBe(head);
  });

  it("returns the context head when manualHead is null", () => {
    const head = track({ id: 9 });
    expect(
      pickGaplessNext({
        repeat: 0,
        manualHead: null,
        contextHead: head,
        currentSourceId: "src-1",
      }),
    ).toBe(head);
  });

  it("returns null when the manual head is unavailable (streamReady === false)", () => {
    expect(
      pickGaplessNext({
        repeat: 0,
        manualHead: track({ streamReady: false }),
        contextHead: null,
        currentSourceId: "src-1",
      }),
    ).toBeNull();
  });

  it("returns null when the manual head is unavailable (allowStreaming === false)", () => {
    expect(
      pickGaplessNext({
        repeat: 0,
        manualHead: track({ allowStreaming: false }),
        contextHead: null,
        currentSourceId: "src-1",
      }),
    ).toBeNull();
  });

  it("returns null when the manual head's _source.id differs from the current source", () => {
    expect(
      pickGaplessNext({
        repeat: 0,
        manualHead: track({
          _source: { type: "ALBUM", id: "src-2", name: "Other" },
        }),
        contextHead: null,
        currentSourceId: "src-1",
      }),
    ).toBeNull();
  });

  it("returns null when both heads are null", () => {
    expect(
      pickGaplessNext({
        repeat: 0,
        manualHead: null,
        contextHead: null,
        currentSourceId: "src-1",
      }),
    ).toBeNull();
  });
});
