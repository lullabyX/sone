import { describe, it, expect } from "vitest";
import { splitLinks, assembleExternalLinks } from "./socialLinks";
import type { ExternalLink } from "../types";

describe("splitLinks", () => {
  it("separates the website from socials", () => {
    const links: ExternalLink[] = [
      { href: "https://me.com", linkType: "OFFICIAL_HOMEPAGE" },
      { href: "https://instagram.com/me", linkType: "INSTAGRAM" },
      { href: "https://x.com/me", linkType: "TWITTER" },
    ];
    const { website, socials } = splitLinks(links);
    expect(website).toBe("https://me.com");
    expect(socials.INSTAGRAM).toBe("https://instagram.com/me");
    expect(socials.TWITTER).toBe("https://x.com/me");
    expect(socials.TIKTOK).toBeUndefined();
  });

  it("ignores unknown link types and TIDAL sharing links", () => {
    const links: ExternalLink[] = [
      { href: "https://tidal.com/x", linkType: "TIDAL_SHARING" },
    ];
    const { website, socials } = splitLinks(links);
    expect(website).toBe("");
    expect(Object.keys(socials)).toHaveLength(0);
  });
});

describe("assembleExternalLinks", () => {
  it("emits OFFICIAL_HOMEPAGE + social items, skipping blanks", () => {
    const out = assembleExternalLinks("https://me.com", {
      INSTAGRAM: "https://instagram.com/me",
      TIKTOK: "   ",
      TWITTER: "",
    });
    expect(out).toContainEqual({ href: "https://me.com", linkType: "OFFICIAL_HOMEPAGE" });
    expect(out).toContainEqual({ href: "https://instagram.com/me", linkType: "INSTAGRAM" });
    expect(out.find((l) => l.linkType === "TIKTOK")).toBeUndefined();
    expect(out).toHaveLength(2);
  });

  it("trims whitespace and drops an empty website", () => {
    const out = assembleExternalLinks("  ", { INSTAGRAM: "  https://ig/me  " });
    expect(out).toEqual([{ href: "https://ig/me", linkType: "INSTAGRAM" }]);
  });
});
