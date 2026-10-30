import { expect, it, vi } from "vitest";
import { confirmMenu } from "./tvMenu";
import { setupTvTest } from "./tvTestUtils";

setupTvTest();
it("puts Cancel first", async () => {
  const onConfirm = vi.fn();
  const spec = confirmMenu({ title: "Delete \"x\"?", confirmLabel: "Delete", onConfirm });
  expect(spec.items.map((i) => i.label)).toEqual(["Cancel", "Delete"]);
  await spec.items[0].onSelect!();
  expect(onConfirm).not.toHaveBeenCalled();
  await spec.items[1].onSelect!();
  expect(onConfirm).toHaveBeenCalledTimes(1);
});
