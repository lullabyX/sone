import type { CSSProperties } from "react";

export default function AiBadge({ style }: { style?: CSSProperties }) {
  return (
    <span
      aria-label="AI-generated"
      title="AI-generated"
      style={style}
      className="shrink-0 inline-flex items-center justify-center px-1 h-[15px] rounded-[3px] bg-th-text-faint/15 text-th-text-muted text-[9px] font-bold leading-none tracking-wide"
    >
      AI
    </span>
  );
}
