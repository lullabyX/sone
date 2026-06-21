import { afterEach, describe, it, expect, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";

// TidalImage resolves the photo through invoke("get_image_bytes"), and useAuth
// touches invoke on logout — stub the Tauri bridge so neither hits a real backend.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) =>
    cmd === "get_image_bytes"
      ? Promise.resolve(new ArrayBuffer(8))
      : Promise.resolve(undefined),
  ),
}));

import UserMenu from "./UserMenu";
import { ToastProvider } from "../contexts/ToastContext";
import { userNameAtom, currentUserAvatarAtom } from "../atoms/auth";
import { currentViewAtom } from "../atoms/navigation";

function renderMenu(avatar: string | null) {
  const store = createStore();
  store.set(userNameAtom, "Alice");
  store.set(currentUserAvatarAtom, avatar);
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>
      <ToastProvider>{children}</ToastProvider>
    </Provider>
  );
  const utils = render(<UserMenu />, { wrapper });
  // Open the dropdown via the round account trigger.
  fireEvent.click(screen.getByTitle("Account"));
  return { store, ...utils };
}

describe("UserMenu avatar + profile navigation", () => {
  afterEach(cleanup);

  it("renders the avatar photo when the atom is set", async () => {
    const { container } = renderMenu("https://img/avatar.jpg");
    // The header row name is always present.
    expect(screen.getByText("Alice")).not.toBeNull();
    // TidalImage resolves the blob asynchronously, then mounts an <img>
    // (alt="" keeps it out of the ARIA img role, so query the element directly).
    await waitFor(() => {
      expect(container.querySelectorAll("img").length).toBeGreaterThan(0);
    });
  });

  it("renders the person-icon fallback (no <img>) when the avatar is null", () => {
    const { container } = renderMenu(null);
    expect(screen.getByText("Alice")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("navigates to the profile when the name row is clicked", () => {
    const { store } = renderMenu(null);
    fireEvent.click(screen.getByText("Alice"));
    expect(store.get(currentViewAtom)).toMatchObject({ type: "profile" });
  });

  it("no longer shows a separate Profile menu item", () => {
    renderMenu(null);
    expect(screen.queryByRole("button", { name: "Profile" })).toBeNull();
  });
});
