import { describe, it, expect } from "vitest";
import { pickProfileHeroImage } from "./ProfilePage";
import type { ProfileArtFile } from "../types";

describe("pickProfileHeroImage", () => {
  it("returns null for an empty list", () => {
    expect(pickProfileHeroImage([])).toBeNull();
  });

  it("prefers the 640-wide entry when present", () => {
    const files: ProfileArtFile[] = [
      { href: "https://img/1280.jpg", width: 1280 },
      { href: "https://img/640.jpg", width: 640 },
      { href: "https://img/320.jpg", width: 320 },
    ];
    expect(pickProfileHeroImage(files)).toBe("https://img/640.jpg");
  });

  it("falls back to the smallest entry >= 640 when there is no exact 640", () => {
    const files: ProfileArtFile[] = [
      { href: "https://img/1280.jpg", width: 1280 },
      { href: "https://img/320.jpg", width: 320 },
    ];
    expect(pickProfileHeroImage(files)).toBe("https://img/1280.jpg");
  });

  it("falls back to the widest entry when all are below 640", () => {
    const files: ProfileArtFile[] = [
      { href: "https://img/320.jpg", width: 320 },
      { href: "https://img/160.jpg", width: 160 },
    ];
    expect(pickProfileHeroImage(files)).toBe("https://img/320.jpg");
  });

  it("uses the first entry when width metadata is missing", () => {
    const files: ProfileArtFile[] = [
      { href: "https://img/a.jpg" },
      { href: "https://img/b.jpg" },
    ];
    expect(pickProfileHeroImage(files)).toBe("https://img/a.jpg");
  });
});
