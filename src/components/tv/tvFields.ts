type TextField = HTMLInputElement | HTMLTextAreaElement;

/** Sets the value through the native setter, so React's `onChange` sees it. */
export function setNativeInputValue(el: TextField, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const HAS_WORD = /[\p{L}\p{N}]/u;

function text(el: Element | null | undefined): string {
  return el?.textContent?.trim() ?? "";
}

/** A title for the field's prompt, taken from what labels it on screen. */
export function fieldLabel(el: TextField): string {
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;
  const label = el.labels ? text(el.labels[0]) : "";
  if (label) return label;
  for (
    let sib = el.previousElementSibling;
    sib;
    sib = sib.previousElementSibling
  ) {
    if (sib.tagName !== "LABEL" && sib.tagName !== "SPAN") continue;
    const t = text(sib);
    if (HAS_WORD.test(t)) return t;
  }
  return el.placeholder.trim() || "Edit";
}
