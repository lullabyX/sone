export interface LrcLine {
  time: number; // seconds
  text: string;
}

function parseTimestamp(tag: string): number {
  const m = tag.match(/(\d{1,2}):(\d{2})(?:[.:]([\d]{1,3}))?/);
  if (!m) return 0;
  const mins = parseInt(m[1], 10);
  const secs = parseInt(m[2], 10);
  let ms = 0;
  if (m[3]) {
    ms =
      m[3].length === 1
        ? parseInt(m[3], 10) * 100
        : m[3].length === 2
          ? parseInt(m[3], 10) * 10
          : parseInt(m[3], 10);
  }
  return mins * 60 + secs + ms / 1000;
}

export function parseLrc(subtitles: string): LrcLine[] {
  const lines: LrcLine[] = [];
  for (const raw of subtitles.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const timestamps: number[] = [];
    const stripped = line.replace(
      /\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]/g,
      (_match, tag) => {
        timestamps.push(parseTimestamp(tag));
        return "";
      },
    );

    const text = stripped.trim();
    if (!text || timestamps.length === 0) continue;

    for (const time of timestamps) {
      lines.push({ time, text });
    }
  }

  lines.sort((a, b) => a.time - b.time);
  return lines;
}
