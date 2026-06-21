import type { ExternalLink } from "../types";

export const SOCIAL_TYPES = [
  "INSTAGRAM",
  "TIKTOK",
  "FACEBOOK",
  "TWITTER",
  "SNAPCHAT",
] as const;

export type SocialType = (typeof SOCIAL_TYPES)[number];

const WEBSITE_TYPE = "OFFICIAL_HOMEPAGE";

export function splitLinks(links: ExternalLink[]): {
  website: string;
  socials: Record<string, string>;
} {
  let website = "";
  const socials: Record<string, string> = {};
  for (const link of links) {
    if (link.linkType === WEBSITE_TYPE) {
      website = link.href;
    } else if ((SOCIAL_TYPES as readonly string[]).includes(link.linkType)) {
      socials[link.linkType] = link.href;
    }
  }
  return { website, socials };
}

export function assembleExternalLinks(
  website: string,
  socials: Record<string, string>,
): ExternalLink[] {
  const out: ExternalLink[] = [];
  const trimmedWebsite = website.trim();
  if (trimmedWebsite) {
    out.push({ href: trimmedWebsite, linkType: WEBSITE_TYPE });
  }
  for (const type of SOCIAL_TYPES) {
    const value = (socials[type] ?? "").trim();
    if (value) out.push({ href: value, linkType: type });
  }
  return out;
}
