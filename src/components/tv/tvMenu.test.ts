import { expect, it, vi } from "vitest";
import { confirmMenu, linkMenu } from "./tvMenu";
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
it("shows a link as a QR code with its address", () => {
  expect(linkMenu("https://x.io/a", "Read")).toMatchObject({
    title: "Read",
    qr: "https://x.io/a",
    items: [{ label: "https://x.io/a", multiline: true }],
  });
  expect(linkMenu("https://x.io/a", "").title).toBe("Link");
});
