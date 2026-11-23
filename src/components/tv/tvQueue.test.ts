import { expect, it } from "vitest";
import { moveInQueue, queueIndexOf } from "./tvQueue";
import { mkTrack, setupTvTest } from "./tvTestUtils";

setupTvTest();

const q = (id: number, qid: string) => ({ ...mkTrack(id), _qid: qid });
const [a, b, c, d, e] = [q(1, "a"), q(2, "b"), q(3, "c"), q(4, "d"), q(5, "e")];
const manual = [a, b];
const context = [c, d, e];

it("finds a queued track by its queue id", () => {
  expect(queueIndexOf(manual, context, d)).toBe(3);
  expect(queueIndexOf(manual, context, { ...d, _qid: "zz" })).toBe(-1);
});

it("finds an unstamped track by reference", () => {
  const t = mkTrack(9);
  expect(queueIndexOf([a], [t], t)).toBe(1);
  expect(queueIndexOf([a], [t], mkTrack(9))).toBe(-1);
});

it("moves tracks across the manual/context boundary like a drag", () => {
  expect(moveInQueue(manual, context, c, "up")).toEqual({
    tracks: [a, c, b, d, e],
    manualCount: 3,
  });
  expect(moveInQueue(manual, context, b, "down")).toEqual({
    tracks: [a, c, b, d, e],
    manualCount: 1,
  });
  expect(moveInQueue(manual, context, e, "top")).toEqual({
    tracks: [e, a, b, c, d],
    manualCount: 3,
  });
});

it("keeps the boundary for moves within one part", () => {
  expect(moveInQueue(manual, context, e, "up")).toEqual({
    tracks: [a, b, c, e, d],
    manualCount: 2,
  });
  expect(moveInQueue(manual, context, b, "top")).toEqual({
    tracks: [b, a, c, d, e],
    manualCount: 2,
  });
});

it("returns null when the move cannot apply", () => {
  expect(moveInQueue(manual, context, a, "up")).toBeNull();
  expect(moveInQueue(manual, context, a, "top")).toBeNull();
  expect(moveInQueue(manual, context, e, "down")).toBeNull();
  expect(moveInQueue(manual, context, { ...c, _qid: "zz" }, "up")).toBeNull();
});
