import { expect, it } from "vitest";
import { bioParagraphs } from "./BioText";

it("splits a bio into plain-text paragraphs, keeping link text", () => {
  expect(bioParagraphs('A [wimpLink artistId="1"]B[/wimpLink].<br/>C')).toEqual(["A B.", "C"]);
});
