/** Largest cover the drawer ever draws, matching the 640px art it requests. */
export const MAX_COVER_SIZE = 640;
/** Vertical gap between the cover and the title block, in px. */
export const COVER_TEXT_GAP = 24;

interface CoverFitInput {
  /** Content-box width of the art column (padding already excluded). */
  width: number;
  /** Content-box height of the art column. */
  height: number;
  /** Measured height of the title/artist block below the cover. */
  textHeight: number;
  gap?: number;
  max?: number;
}

/** Side length of the largest square cover that fits the column in both axes. */
export function fitCoverSize({
  width,
  height,
  textHeight,
  gap = COVER_TEXT_GAP,
  max = MAX_COVER_SIZE,
}: CoverFitInput): number {
  return Math.max(
    0,
    Math.floor(Math.min(width, height - gap - textHeight, max)),
  );
}
