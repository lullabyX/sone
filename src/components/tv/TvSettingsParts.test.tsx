import { expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { TvSettingsRow } from "./TvSettingsParts";
import { renderTv, setupTvTest } from "./tvTestUtils";

setupTvTest();

it("an actionable row is a focusable button that calls onSelect with no arguments", () => {
  const onSelect = vi.fn();
  renderTv(
    <TvSettingsRow title="Autoplay" subtitle="s" toggle onSelect={onSelect} />,
  );
  const b = screen.getByRole("button", { name: /autoplay/i });
  expect(b.hasAttribute("data-tv-focusable")).toBe(true);
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  fireEvent.click(b);
  expect(onSelect.mock.calls).toEqual([[]]);
});

it("an information row is not focusable", () => {
  renderTv(<TvSettingsRow title="Version" value="1.0" />);
  expect(screen.queryByRole("button")).toBeNull();
});
