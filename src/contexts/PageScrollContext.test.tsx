import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PageScrollProvider, usePageScrollElement } from "./PageScrollContext";

function Reader({ onRead }: { onRead: (el: HTMLElement | null) => void }) {
  onRead(usePageScrollElement());
  return null;
}

describe("PageScrollContext", () => {
  it("hands consumers the element the provider was given", () => {
    const element = document.createElement("div");
    let seen: HTMLElement | null | undefined;

    render(
      <PageScrollProvider element={element}>
        <Reader onRead={(el) => (seen = el)} />
      </PageScrollProvider>,
    );

    expect(seen).toBe(element);
  });

  it("returns null when no provider is above the consumer", () => {
    let seen: HTMLElement | null | undefined = undefined;
    render(<Reader onRead={(el) => (seen = el)} />);
    expect(seen).toBe(null);
  });
});
