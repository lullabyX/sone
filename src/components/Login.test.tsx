import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { tvModeAtom, tvSignInReturnAtom } from "../atoms/tv";
import Login from "./Login";

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    startPkceAuth: vi.fn(),
    completePkceAuth: vi.fn(),
    startDeviceAuth: vi.fn(),
    pollDeviceAuth: vi.fn(),
    importSession: vi.fn(),
    getUserPlaylists: vi.fn(),
  }),
}));
vi.mock("../api/tidal", () => ({
  getSavedCredentials: vi.fn(async () => ({ clientId: "", clientSecret: "" })),
  getDefaultCredentials: vi.fn(async () => ({
    clientId: "c",
    clientSecret: "s",
  })),
  hasPkceDefaults: vi.fn(async () => true),
  parseTokenData: vi.fn(),
  startPkceLoginWindow: vi.fn(),
  startPkceBrowserLogin: vi.fn(),
  completePkceBrowserLogin: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

const renderLogin = (fromTv: boolean) => {
  const store = createStore();
  store.set(tvSignInReturnAtom, fromTv);
  const r = render(
    <Provider store={store}>
      <Login />
    </Provider>,
  );
  return { ...r, store };
};

it("offers no way back to TV sign-in unless it came from there", async () => {
  renderLogin(false);
  await screen.findByText("Sign in with TIDAL");
  expect(
    screen.queryByRole("button", { name: /back to tv sign-in/i }),
  ).toBeNull();
});

it("goes back to TV sign-in when it came from there", async () => {
  const { store } = renderLogin(true);
  const back = await screen.findByRole("button", {
    name: /back to tv sign-in/i,
  });
  // A remote's OK can take it straight back.
  expect(document.activeElement).toBe(back);
  fireEvent.click(back);
  expect(store.get(tvModeAtom)).toBe(true);
  expect(store.get(tvSignInReturnAtom)).toBe(false);
});

it("forgets the way back once it closes (signed in here)", async () => {
  const { store, unmount } = renderLogin(true);
  await screen.findByRole("button", { name: /back to tv sign-in/i });
  unmount();
  expect(store.get(tvSignInReturnAtom)).toBe(false);
});

it("keeps the way back out of storage, so a restart drops it", () => {
  const store = createStore();
  store.set(tvSignInReturnAtom, true);
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  expect(createStore().get(tvSignInReturnAtom)).toBe(false);
});
