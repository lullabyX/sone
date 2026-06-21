import { describe, it, expect } from "vitest";
import {
  pickProfileHeroImage,
  pickProfileAvatarHref,
  profilePlaylistsViewAll,
  shouldShowAddBio,
  PROFILE_PLAYLISTS_INLINE_CAP,
} from "./ProfilePage";
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

describe("pickProfileAvatarHref", () => {
  it("returns null for an empty list", () => {
    expect(pickProfileAvatarHref([])).toBeNull();
  });

  it("returns the last (smallest) entry from a desc-by-width list", () => {
    const files: ProfileArtFile[] = [
      { href: "https://img/1280.jpg", width: 1280 },
      { href: "https://img/640.jpg", width: 640 },
      { href: "https://img/320.jpg", width: 320 },
    ];
    expect(pickProfileAvatarHref(files)).toBe("https://img/320.jpg");
  });

  it("returns the only entry when the list has one", () => {
    const files: ProfileArtFile[] = [
      { href: "https://img/solo.jpg", width: 750 },
    ];
    expect(pickProfileAvatarHref(files)).toBe("https://img/solo.jpg");
  });

  it("prefers the smallest SQUARE rendition over a narrower 16:9 one", () => {
    // TIDAL returns both 1:1 and 16:9 renditions; the backend sorts desc by
    // width, so the list ends with 320x180 (16:9). The round avatar must use
    // the smallest SQUARE (320x320), never the rectangular one.
    const files: ProfileArtFile[] = [
      { href: "https://img/1280sq.jpg", width: 1280, height: 1280 },
      { href: "https://img/1280wide.jpg", width: 1280, height: 720 },
      { href: "https://img/640sq.jpg", width: 640, height: 640 },
      { href: "https://img/640wide.jpg", width: 640, height: 360 },
      { href: "https://img/320sq.jpg", width: 320, height: 320 },
      { href: "https://img/320wide.jpg", width: 320, height: 180 },
    ];
    expect(pickProfileAvatarHref(files)).toBe("https://img/320sq.jpg");
  });
});

describe("profilePlaylistsViewAll", () => {
  it("shows all and a view-all link when total is below the cap", () => {
    const r = profilePlaylistsViewAll(3, 8);
    expect(r.visibleCount).toBe(3);
    expect(r.showViewAll).toBe(true);
  });

  it("caps the visible count and shows view-all when total exceeds the cap", () => {
    const r = profilePlaylistsViewAll(12, 8);
    expect(r.visibleCount).toBe(8);
    expect(r.showViewAll).toBe(true);
  });

  it("hides the view-all link when there are no playlists", () => {
    const r = profilePlaylistsViewAll(0, 8);
    expect(r.visibleCount).toBe(0);
    expect(r.showViewAll).toBe(false);
  });

  it("exposes the inline cap as 8", () => {
    expect(PROFILE_PLAYLISTS_INLINE_CAP).toBe(8);
  });
});

describe("shouldShowAddBio", () => {
  it("shows on the own profile when the bio is empty", () => {
    expect(shouldShowAddBio(null, 123)).toBe(true);
    expect(shouldShowAddBio("", 123)).toBe(true);
  });

  it("hides when a bio is present (BioText renders instead)", () => {
    expect(shouldShowAddBio("hello", 123)).toBe(false);
  });

  it("hides when it is not the own profile (no artistId)", () => {
    expect(shouldShowAddBio(null, null)).toBe(false);
    expect(shouldShowAddBio("", null)).toBe(false);
    expect(shouldShowAddBio("hello", null)).toBe(false);
  });
});
