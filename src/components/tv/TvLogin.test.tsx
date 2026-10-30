import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { createStore } from "jotai";
import { startPkceLoginWindow } from "../../api/tidal";
import { tvModeAtom } from "../../atoms/tv";
import TvLogin from "./TvLogin";
import { mockInvoke, renderTv, setupTvTest, stubLayout } from "./tvTestUtils";

const auth = vi.hoisted(() => ({
  startDeviceAuth: vi.fn(),
  pollDeviceAuth: vi.fn(() => new Promise(() => {})),
  getUserPlaylists: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../hooks/useAuth", () => ({ useAuth: () => auth }));

vi.mock("../../api/tidal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tidal")>()),
  hasPkceDefaults: vi.fn(() => Promise.resolve(true)),
  getDefaultCredentials: vi.fn(() =>
    Promise.resolve({ clientId: "c", clientSecret: "s" }),
  ),
  startPkceLoginWindow: vi.fn(() => Promise.resolve()),
}));

const handlers = vi.hoisted(
  () => ({}) as Record<string, (e: { payload: unknown }) => void>,
);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((n: string, cb: (e: { payload: unknown }) => void) => {
    handlers[n] = cb;
    return Promise.resolve(() => {});
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

setupTvTest();

beforeEach(() => {
  mockInvoke({ get_proxy_status: () => ({ state: "off" }) });
  auth.startDeviceAuth.mockReset();
  auth.startDeviceAuth.mockReturnValue(new Promise(() => {}));
});

const CODE = {
  userCode: "AAAA",
  verificationUri: "link.tidal.com",
  verificationUriComplete: "link.tidal.com/AAAA",
  deviceCode: "d",
  interval: 5,
  expiresIn: 300,
};
const phone = async () =>
  fireEvent.click(
    await screen.findByRole("button", { name: "Sign in with your phone" }),
  );

it("shows a new code, not the old one, after Back and phone again", async () => {
  auth.startDeviceAuth.mockResolvedValueOnce(CODE);
  renderTv(<TvLogin />);
  await phone();
  expect(await screen.findByText("AAAA")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await phone();
  expect(screen.queryByText("AAAA")).toBeNull();
  expect(screen.getByText("Getting a sign-in code…")).toBeTruthy();
});

it("offline: says so and offers Try again", async () => {
  auth.startDeviceAuth.mockRejectedValueOnce({
    kind: "Network",
    message: "error sending request",
  });
  renderTv(<TvLogin />);
  await phone();
  expect(await screen.findByText(/can't reach tidal/i)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

it("draws the QR code for the phone link", async () => {
  auth.startDeviceAuth.mockResolvedValueOnce(CODE);
  renderTv(<TvLogin />);
  await phone();
  await screen.findByText("AAAA");
  expect(screen.getByRole("img", { name: /sign-in code/i })).toBeTruthy();
});

it("closing the on-TV sign-in clears its error and puts focus back on it", async () => {
  const restore = stubLayout();
  try {
    vi.mocked(startPkceLoginWindow).mockRejectedValueOnce("boom");
    renderTv(<TvLogin />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Sign in on this TV" }),
    );
    expect(await screen.findByText("boom")).toBeTruthy();
    (document.activeElement as HTMLElement).blur();
    act(() => handlers["pkce-login-cancelled"]({ payload: null }));
    expect(screen.queryByText("boom")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Sign in on this TV" }),
    );
  } finally {
    restore();
  }
});

const inBanner = () =>
  document.activeElement?.closest(".sone-proxy-banner") ?? null;
const tvStore = () => {
  const store = createStore();
  store.set(tvModeAtom, true);
  return { store };
};

it("phone sign-in never puts focus on the proxy notice", async () => {
  mockInvoke({ get_proxy_status: () => ({ state: "blocked", reason: "r" }) });
  auth.startDeviceAuth.mockResolvedValueOnce(CODE);
  const restore = stubLayout();
  try {
    renderTv(<TvLogin />, tvStore());
    await screen.findByRole("button", { name: /turn off proxy/i });
    const choose = await screen.findByRole("button", {
      name: "Sign in with your phone",
    });
    choose.focus();
    fireEvent.click(choose);
    expect(inBanner()).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Back" }),
    );
    await screen.findByText("AAAA");
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(inBanner()).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "New code" }),
    );
  } finally {
    restore();
  }
});

it("Try again never puts focus on the proxy notice", async () => {
  mockInvoke({ get_proxy_status: () => ({ state: "blocked", reason: "r" }) });
  auth.startDeviceAuth.mockRejectedValueOnce({
    kind: "Network",
    message: "error sending request",
  });
  const restore = stubLayout();
  try {
    renderTv(<TvLogin />, tvStore());
    await screen.findByRole("button", { name: /turn off proxy/i });
    await phone();
    const tryAgain = await screen.findByRole("button", { name: "Try again" });
    tryAgain.focus();
    fireEvent.click(tryAgain);
    expect(inBanner()).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Back" }),
    );
  } finally {
    restore();
  }
});

it("a sign-in page that cannot load says the network is down", async () => {
  const restore = stubLayout();
  try {
    renderTv(<TvLogin />);
    await screen.findByRole("button", { name: "Sign in on this TV" });
    (document.activeElement as HTMLElement).blur();
    act(() => handlers["pkce-login-offline"]({ payload: null }));
    expect(screen.getByText(/can't reach tidal/i)).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Sign in on this TV" }),
    );
  } finally {
    restore();
  }
});
