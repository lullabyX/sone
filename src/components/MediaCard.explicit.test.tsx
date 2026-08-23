import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import MediaCard from "./MediaCard";

const explicitVideo = {
  id: 373513584,
  title: "Not Like Us",
  imageId: "faab127d-c101-4323-a41a-a1ef45831d48",
  explicit: true,
  artists: [{ id: 3816041, name: "Kendrick Lamar" }],
};

function renderCard(props: Record<string, unknown> = {}) {
  return render(
    <MediaCard
      item={explicitVideo}
      aspect="video"
      onClick={() => {}}
      {...props}
    />,
  );
}

describe("MediaCard explicit badge", () => {
  it("renders the badge when opted in and the item is explicit", () => {
    const { container } = renderCard({ showExplicit: true });
    expect(container.textContent).toContain("Not Like Us");
    expect(container.textContent).toContain("E");
  });

  /** Badges are a list-row convention; card surfaces opt in individually. */
  it("stays off by default so other card surfaces are unaffected", () => {
    const { container } = renderCard();
    const badge = Array.from(container.querySelectorAll("span")).find(
      (el) => el.textContent === "E",
    );
    expect(badge).toBeUndefined();
  });

  it("renders no badge when opted in but the item is not explicit", () => {
    const { container } = render(
      <MediaCard
        item={{ ...explicitVideo, explicit: false }}
        aspect="video"
        showExplicit
        onClick={() => {}}
      />,
    );
    const badge = Array.from(container.querySelectorAll("span")).find(
      (el) => el.textContent === "E",
    );
    expect(badge).toBeUndefined();
  });
});
