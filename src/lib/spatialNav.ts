/**
 * Spatial (D-pad) focus navigation for the TV interface.
 *
 * A remote or a keyboard only has four arrows, so focus moves to whichever
 * focusable element lies closest in the pressed direction — the model every
 * TV platform uses. Elements opt in with `data-tv-focusable`; containers
 * marked `data-tv-remember` hand focus back to the child that last had it
 * when focus re-enters them from outside (a row of cards, the nav rail), or
 * to their `data-tv-default` child before they have been visited.
 */

export type Direction = "up" | "down" | "left" | "right";

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// Inside a `data-tv-native` container (the desktop settings sheet shown in
// TV mode) every natively focusable control counts, without markup changes.
const FOCUSABLE =
  "[data-tv-focusable], [data-tv-native] :is(button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1']))";
const REMEMBER = "[data-tv-remember]";
const SIDE = "[data-tv-side]";

/** How much the sideways offset counts against the forward distance. A
 *  candidate straight ahead beats a nearer one far off to the side. */
const ORTHOGONAL_WEIGHT = 3;

/**
 * Index of the best candidate to move to from `from` in `dir`, or -1 when
 * nothing lies that way. Pure geometry, so it is unit-testable.
 */
export function pickNext(from: Box, candidates: Box[], dir: Direction): number {
  const fromCx = (from.left + from.right) / 2;
  const fromCy = (from.top + from.bottom) / 2;
  let best = -1;
  let bestScore = Infinity;

  candidates.forEach((c, i) => {
    const cx = (c.left + c.right) / 2;
    const cy = (c.top + c.bottom) / 2;
    // A candidate counts only if its center lies beyond the edge we leave
    // through — a card in the row below a wide banner is not "left" of it
    // just because the banner extends further right.
    let forward: number;
    let sideways: number;

    switch (dir) {
      case "right":
        if (cx <= from.right || c.left <= from.left) return;
        forward = Math.max(0, c.left - from.right);
        sideways = gap(from.top, from.bottom, c.top, c.bottom, fromCy, cy);
        break;
      case "left":
        if (cx >= from.left || c.right >= from.right) return;
        forward = Math.max(0, from.left - c.right);
        sideways = gap(from.top, from.bottom, c.top, c.bottom, fromCy, cy);
        break;
      case "down":
        if (cy <= from.bottom || c.top <= from.top) return;
        forward = Math.max(0, c.top - from.bottom);
        sideways = gap(from.left, from.right, c.left, c.right, fromCx, cx);
        break;
      case "up":
        if (cy >= from.top || c.bottom >= from.bottom) return;
        forward = Math.max(0, from.top - c.bottom);
        sideways = gap(from.left, from.right, c.left, c.right, fromCx, cx);
        break;
    }

    const score = forward + sideways * ORTHOGONAL_WEIGHT;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });

  return best;
}

/** Sideways distance between two spans: zero when they overlap, otherwise
 *  the distance between their centers. */
function gap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
  aCenter: number,
  bCenter: number,
): number {
  if (bStart < aEnd && bEnd > aStart) return 0;
  return Math.abs(aCenter - bCenter);
}

function isVisible(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Visible focusables in `scope` with their boxes. Reading a box costs real
 *  time on a long track list, so each one is read once per move. */
function measure(scope: ParentNode): Map<HTMLElement, DOMRect> {
  const boxes = new Map<HTMLElement, DOMRect>();
  for (const el of scope.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if ((el as HTMLButtonElement).disabled) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) boxes.set(el, r);
  }
  return boxes;
}

function focusableIn(scope: ParentNode): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    isVisible,
  );
}

const lastFocused = new WeakMap<Element, HTMLElement>();

/** Record the focused element against every remembering ancestor. */
export function rememberFocus(el: HTMLElement) {
  let group = el.parentElement?.closest(REMEMBER);
  while (group) {
    lastFocused.set(group, el);
    group = group.parentElement?.closest(REMEMBER) ?? null;
  }
}

/** If `target` sits in a remembering group that `from` is outside of, the
 *  group's last focused child (when it is still on screen) wins. The
 *  outermost such group decides, so re-entering the content area from the
 *  nav rail lands where the user left off rather than in the nearest row. */
function resolveRemembered(from: HTMLElement, target: HTMLElement) {
  let chosen = target;
  let group = target.parentElement?.closest(REMEMBER) ?? null;
  while (group && !group.contains(from)) {
    const prev = lastFocused.get(group);
    if (prev && prev.isConnected && isVisible(prev) && group.contains(prev)) {
      chosen = prev;
    } else {
      // Never visited: the group's designated entry point, if it has one.
      const entry = group.querySelector<HTMLElement>("[data-tv-default]");
      if (entry && isVisible(entry)) chosen = entry;
    }
    group = group.parentElement?.closest(REMEMBER) ?? null;
  }
  return chosen;
}

export function focusElement(el: HTMLElement) {
  el.focus({ preventScroll: true });
  // Inside a `data-tv-scroll-top` block the whole block is brought into
  // view from its top, not just the focused item — coming back up to the
  // player from the queue below shows the full player again.
  const block = el.closest<HTMLElement>("[data-tv-scroll-top]");
  if (block) block.scrollIntoView({ block: "start", inline: "nearest" });
  else el.scrollIntoView({ block: "nearest", inline: "nearest" });

  // Reaching the topmost item of a screen scrolls it all the way up, so the
  // header or first row title above it is not left cut off.
  // Content runs top to bottom, so only items before it in the document can
  // lie above it — the scan stops early instead of measuring a whole list.
  const root = el.closest<HTMLElement>("[data-tv-scroll-root]");
  if (root && root.scrollTop > 0) {
    const top = el.getBoundingClientRect().top;
    for (const other of root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
      if (other === el) {
        root.scrollTop = 0;
        break;
      }
      if (isVisible(other) && other.getBoundingClientRect().bottom <= top) {
        break;
      }
    }
  }
}

/** Move focus one step within `scope`. Returns false when nothing lies in
 *  that direction, so callers can decide on a fallback. With `enterSide`
 *  false a side panel is not entered (a held arrow stops at the end of a
 *  row instead of opening the nav rail). */
export function moveFocus(
  scope: HTMLElement,
  dir: Direction,
  { enterSide = true }: { enterSide?: boolean } = {},
): boolean {
  const boxes = measure(scope);
  const all = Array.from(boxes.keys());
  const current = document.activeElement as HTMLElement | null;
  if (!current || !scope.contains(current) || !boxes.has(current)) {
    const first = all[0];
    if (!first) return false;
    focusElement(first);
    return true;
  }
  // Look inside the innermost group first, widening outwards: Up/Down in the
  // nav rail stays in the rail even though, expanded, it overlaps the cards
  // behind it, while Left/Right at the end of a row falls through to the
  // next group out.
  const from = boxes.get(current)!;
  // A side panel (`data-tv-side`, the nav rail) is entered sideways only:
  // Up/Down past the top or bottom of the content must not land in it.
  const sideways = dir === "left" || dir === "right";
  const inSide = !!current.closest(SIDE);
  // Left/Right stay on the current line: at the end of a row nothing
  // happens, rather than jumping diagonally into the next row. A side panel
  // (the rail) is reachable sideways from anywhere, and leaving it lands on
  // whatever the content last had focused.
  const onLine = (el: HTMLElement) => {
    const r = boxes.get(el)!;
    return r.top < from.bottom && r.bottom > from.top;
  };
  const others = all.filter(
    (el) =>
      el !== current &&
      (sideways
        ? inSide || (el.closest(SIDE) ? enterSide : onLine(el))
        : inSide || !el.closest(SIDE)),
  );
  let group: Element | null = current.parentElement?.closest(REMEMBER) ?? null;
  while (true) {
    const pool = group ? others.filter((el) => group!.contains(el)) : others;
    const idx = pickNext(
      from,
      pool.map((el) => boxes.get(el)!),
      dir,
    );
    if (idx >= 0) {
      focusElement(resolveRemembered(current, pool[idx]));
      return true;
    }
    if (!group) return false;
    group = group.parentElement?.closest(REMEMBER) ?? null;
  }
}

/** Focus the element marked `data-tv-autofocus`, else the first focusable. */
export function focusFirstIn(scope: HTMLElement): boolean {
  const preferred = scope.querySelector<HTMLElement>("[data-tv-autofocus]");
  const el =
    preferred && isVisible(preferred) ? preferred : focusableIn(scope)[0];
  if (!el) return false;
  focusElement(el);
  return true;
}
