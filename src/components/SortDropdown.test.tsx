import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import SortDropdown from "./SortDropdown";
import type { SortOrder } from "../atoms/favorites";

afterEach(cleanup);

function pick(current: SortOrder, label: string) {
  const onSortChange = vi.fn();
  render(
    <SortDropdown
      libraryType="playlists"
      currentSort={current}
      onSortChange={onSortChange}
    />,
  );
  fireEvent.click(screen.getByTitle(/^Sort by:/));
  fireEvent.click(screen.getByText(label, { selector: "button" }));
  return onSortChange;
}

describe("SortDropdown", () => {
  it("flips the direction when the current order is picked again", () => {
    const onSortChange = pick({ order: "NAME", direction: "ASC" }, "Name");
    expect(onSortChange).toHaveBeenCalledTimes(1);
    expect(onSortChange.mock.lastCall![0]).toEqual({
      order: "NAME",
      direction: "DESC",
    });
  });

  it("starts Name ascending when switching to it", () => {
    const onSortChange = pick({ order: "DATE", direction: "DESC" }, "Name");
    expect(onSortChange.mock.lastCall![0]).toEqual({
      order: "NAME",
      direction: "ASC",
    });
  });

  it("starts other orders descending", () => {
    const onSortChange = pick(
      { order: "NAME", direction: "ASC" },
      "Last updated",
    );
    expect(onSortChange.mock.lastCall![0]).toEqual({
      order: "DATE_UPDATED",
      direction: "DESC",
    });
  });

  it("closes the menu after a pick", () => {
    pick({ order: "DATE", direction: "DESC" }, "Name");
    expect(screen.queryByText("Last updated", { selector: "button" })).toBe(
      null,
    );
  });
});
