import { describe, it, expect } from "vitest";
import {
  contentBlockReason,
  isContentBlocked,
  blockedMessage,
} from "./contentFilter";

const all = { allowExplicit: true, allowAi: true };
const noAi = { allowExplicit: true, allowAi: false };
const noExplicit = { allowExplicit: false, allowAi: true };
const none = { allowExplicit: false, allowAi: false };

describe("contentBlockReason", () => {
  it("allows everything when both prefs are on", () => {
    expect(contentBlockReason({ ai: true, explicit: true }, all)).toBeNull();
  });
  it("blocks ai only when allowAi is off", () => {
    expect(contentBlockReason({ ai: true }, noAi)).toBe("ai");
    expect(contentBlockReason({ ai: true }, noExplicit)).toBeNull();
  });
  it("blocks explicit only when allowExplicit is off", () => {
    expect(contentBlockReason({ explicit: true }, noExplicit)).toBe("explicit");
    expect(contentBlockReason({ explicit: true }, noAi)).toBeNull();
  });
  it("reports ai first when both apply", () => {
    expect(contentBlockReason({ ai: true, explicit: true }, none)).toBe("ai");
  });
  it("treats missing or false flags as allowed", () => {
    expect(contentBlockReason({}, none)).toBeNull();
    expect(contentBlockReason({ ai: false, explicit: false }, none)).toBeNull();
    expect(contentBlockReason(null, none)).toBeNull();
    expect(contentBlockReason(undefined, none)).toBeNull();
  });
  it("ignores the album stub embedded in a track", () => {
    const t = { ai: false, album: { ai: true } } as never;
    expect(isContentBlocked(t, noAi)).toBe(false);
  });
});

describe("blockedMessage", () => {
  it("names the setting that blocks", () => {
    expect(blockedMessage("ai")).toBe("AI content is turned off in Settings");
    expect(blockedMessage("explicit")).toBe(
      "Explicit content is turned off in Settings",
    );
  });
});
