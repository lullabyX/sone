type BioSegment =
  | { type: "text"; text: string }
  | { type: "link"; artistId: number; text: string };

function parseSegments(text: string): BioSegment[] {
  const segments: BioSegment[] = [];
  const re = /\[wimpLink\s+artistId="(\d+)"\](.*?)\[\/wimpLink\]/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      segments.push({ type: "text", text: text.slice(last, match.index) });
    }
    segments.push({
      type: "link",
      artistId: parseInt(match[1], 10),
      text: match[2],
    });
    last = re.lastIndex;
  }

  if (last < text.length) {
    segments.push({ type: "text", text: text.slice(last) });
  }

  return segments.map((seg) =>
    seg.type === "text"
      ? {
          ...seg,
          text: seg.text.replace(/\[[^\]]*\]/g, "").replace(/<[^>]*>/g, ""),
        }
      : seg,
  );
}

function parseBio(raw: string): BioSegment[][] {
  const normalized = raw.replace(/<br\s*\/?>/gi, "\n");
  return normalized
    .split(/\n\n|\n/)
    .filter((p) => p.trim())
    .map((paragraph) => parseSegments(paragraph.trim()));
}

export function stripBio(raw: string): string {
  return raw
    .replace(/\[wimpLink[^\]]*\]/g, "")
    .replace(/\[\/wimpLink\]/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/<[^>]*>/g, "")
    .trim();
}

interface BioTextProps {
  bio: string;
  onArtistClick?: (artistId: number, name: string) => void;
  className?: string;
}

export default function BioText({
  bio,
  onArtistClick,
  className = "text-th-text-secondary",
}: BioTextProps) {
  const paragraphs = parseBio(bio);

  return (
    <>
      {paragraphs.map((segments, pi) => (
        <p
          key={pi}
          className={`text-[14px] leading-[1.7] mb-4 last:mb-0 ${className}`}
        >
          {segments.map((seg, si) =>
            seg.type === "link" && onArtistClick ? (
              <button
                key={si}
                className="underline decoration-current/40 underline-offset-2 hover:decoration-current/80 transition-colors"
                onClick={() => onArtistClick(seg.artistId, seg.text)}
              >
                {seg.text}
              </button>
            ) : (
              <span key={si}>{seg.text}</span>
            ),
          )}
        </p>
      ))}
    </>
  );
}
