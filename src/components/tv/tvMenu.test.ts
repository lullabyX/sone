import { expect, it, vi } from "vitest";
import { artistsMenu, confirmMenu, linkMenu, navMenus } from "./tvMenu";
import { setupTvTest } from "./tvTestUtils";

const getArtistPage = vi.hoisted(() => vi.fn());
vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  getArtistPage,
}));

setupTvTest();
it("puts Cancel first", async () => {
  const onConfirm = vi.fn();
  const spec = confirmMenu({
    title: 'Delete "x"?',
    confirmLabel: "Delete",
    onConfirm,
  });
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
it("navMenus forwards the menu context to the host", () => {
  const host = {
    open: vi.fn(),
    isOpen: () => false,
    back: vi.fn(),
    close: vi.fn(),
    trackMenu: vi.fn(),
    mediaMenu: vi.fn(() => ({ title: "", items: [] })),
  };
  const item = { type: "playlist" as const, uuid: "p", title: "P" };
  navMenus(() => host).mediaMenu(item, false, { folderId: "f1" });
  expect(host.mediaMenu).toHaveBeenCalledWith(item, false, { folderId: "f1" });
});
it("lists artists with their pictures, fetching the ones the item lacks", async () => {
  getArtistPage.mockResolvedValue({ picture: "bb-cc" });
  const open = vi.fn();
  const spec = artistsMenu(
    "Artists",
    [
      { id: 1, name: "A", picture: "aa-bb" },
      { id: 2, name: "B" },
    ],
    open,
  );
  expect(spec.title).toBe("Artists");
  expect(spec.items[0].avatar).toBe(
    "https://resources.tidal.com/images/aa/bb/320x320.jpg",
  );
  const load = spec.items[1].avatar as () => Promise<string | undefined>;
  await expect(load()).resolves.toBe(
    "https://resources.tidal.com/images/bb/cc/320x320.jpg",
  );
  expect(getArtistPage).toHaveBeenCalledWith(2);
  await spec.items[1].onSelect!();
  expect(open).toHaveBeenCalledWith({ id: 2, name: "B" });
});
