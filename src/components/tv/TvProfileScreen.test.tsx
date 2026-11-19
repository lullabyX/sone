import { expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  getProfile: vi.fn(),
}));
vi.mock("../TidalImage", () => ({
  default: ({ alt }: { alt?: string }) => <img alt={alt} />,
}));

import { getProfile } from "../../api/tidal";
import type { Profile } from "../../types";
import { renderTv, setupTvTest, signedIn } from "./tvTestUtils";
import TvProfileScreen from "./TvProfileScreen";

setupTvTest();

const PROFILE = {
  userId: 7,
  artistId: null,
  name: "Rabbi",
  handle: "rabbi",
  bio: "Hi",
  bioId: null,
  pictureFiles: [],
  artworkId: null,
  blurHash: null,
  palette: [],
  externalLinks: [],
  fanCount: 1200,
  publicPlaylists: [{ id: "p1", title: "Road trip", coverUrl: "u" }],
} as Profile;

it("shows name, handle, fans, bio and public playlists", async () => {
  vi.mocked(getProfile).mockResolvedValue(PROFILE);
  const { nav } = renderTv(<TvProfileScreen />, { store: signedIn(7) });
  expect(await screen.findByText("Rabbi")).toBeTruthy();
  expect(screen.getByText("@rabbi · 1.2K fans")).toBeTruthy();
  expect(screen.getByText("Hi")).toBeTruthy();
  fireEvent.click(screen.getByText("Road trip"));
  expect(nav.run).toHaveBeenCalledWith(
    {
      kind: "open",
      view: expect.objectContaining({ type: "playlist", uuid: "p1" }),
    },
    expect.anything(),
  );
});

it("offers Try again when loading fails", async () => {
  vi.mocked(getProfile).mockRejectedValue("boom");
  renderTv(<TvProfileScreen />, { store: signedIn(7) });
  expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
});

it("signed out: says so and loads nothing", () => {
  renderTv(<TvProfileScreen />);
  expect(screen.getByText("Not signed in")).toBeTruthy();
  expect(getProfile).not.toHaveBeenCalled();
});
