import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { createStore } from "jotai";
import { startPkceLoginWindow } from "../../api/tidal";
import { tvModeAtom, tvSignInReturnAtom } from "../../atoms/tv";
import TvLogin from "./TvLogin";
import { listen } from "@tauri-apps/api/event";
import {
  deferred,
  mockInvoke,
  renderTv,
  setupTvTest,
  stubLayout,
} from "./tvTestUtils";

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
  document.activeElement?.closest(".tv-proxy-notice") ?? null;
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
    const newCode = screen.getByRole("button", { name: "New code" });
    expect(document.activeElement).toBe(newCode);
    await screen.findByText("AAAA");
    expect(document.activeElement).toBe(newCode);
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

const OFFLINE = { kind: "Network", message: "error sending request" };

it("Try again keeps the error up, busy, with focus on it, until a code arrives", async () => {
  mockInvoke({ get_proxy_status: () => ({ state: "blocked", reason: "r" }) });
  const next = deferred<typeof CODE>();
  auth.startDeviceAuth
    .mockRejectedValueOnce(OFFLINE)
    .mockReturnValueOnce(next.promise);
  const restore = stubLayout();
  try {
    renderTv(<TvLogin />, tvStore());
    await screen.findByRole("button", { name: /turn off proxy/i });
    await phone();
    const tryAgain = await screen.findByRole("button", { name: "Try again" });
    tryAgain.focus();
    fireEvent.click(tryAgain);
    await act(async () => {});
    expect(auth.startDeviceAuth).toHaveBeenCalledTimes(2);
    // No flash of the code view: the error stays, the button says it's busy.
    expect(screen.getByText(/can't reach tidal/i)).toBeTruthy();
    expect(screen.queryByText("Getting a sign-in code…")).toBeNull();
    expect(document.activeElement).toBe(tryAgain);
    expect(tryAgain.textContent).toBe("Trying again…");
    expect(inBanner()).toBeNull();
    // Pressing it again while busy starts nothing more.
    fireEvent.click(tryAgain);
    await act(async () => {});
    expect(auth.startDeviceAuth).toHaveBeenCalledTimes(2);

    await act(async () => next.resolve(CODE));
    expect(await screen.findByText("AAAA")).toBeTruthy();
    expect(document.activeElement).toBe(tryAgain);
    expect(tryAgain.textContent).toBe("New code");
  } finally {
    restore();
  }
});

it("Try again that fails again shows the new error, focus still on it", async () => {
  auth.startDeviceAuth
    .mockRejectedValueOnce("first")
    .mockRejectedValueOnce("second");
  renderTv(<TvLogin />);
  await phone();
  const tryAgain = await screen.findByRole("button", { name: "Try again" });
  tryAgain.focus();
  fireEvent.click(tryAgain);
  expect(await screen.findByText("second")).toBeTruthy();
  expect(screen.queryByText("first")).toBeNull();
  expect(tryAgain.textContent).toBe("Try again");
  expect(document.activeElement).toBe(tryAgain);
});

it("Up from Sign in on this TV reaches the proxy notice's Turn off proxy", async () => {
  mockInvoke({ get_proxy_status: () => ({ state: "blocked", reason: "r" }) });
  const restore = stubLayout();
  try {
    renderTv(<TvLogin />, tvStore());
    const off = await screen.findByRole("button", { name: "Turn off proxy" });
    const onTv = await screen.findByRole("button", {
      name: "Sign in on this TV",
    });
    off.setAttribute("data-box", "1500,20,200,50");
    onTv.setAttribute("data-box", "200,300,300,60");
    screen
      .getByRole("button", { name: "Sign in with your phone" })
      .setAttribute("data-box", "200,450,300,60");
    screen
      .getByRole("button", { name: "Leave TV mode for the desktop sign-in" })
      .setAttribute("data-box", "200,600,300,60");
    act(() => onTv.focus());
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(document.activeElement).toBe(off);
    // The only way out on this screen: no dismissing it.
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(document.activeElement).toBe(onTv);
  } finally {
    restore();
  }
});

it("Other sign-in options leaves TV mode with a way back", async () => {
  const { store } = tvStore();
  renderTv(<TvLogin />, { store });
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Leave TV mode for the desktop sign-in",
    }),
  );
  expect(store.get(tvModeAtom)).toBe(false);
  expect(store.get(tvSignInReturnAtom)).toBe(true);
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

it("drops its sign-in listeners when they register only after it closed", async () => {
  const original = vi.mocked(listen).getMockImplementation()!;
  const register: Array<(u: () => void) => void> = [];
  const unlisten = vi.fn();
  vi.mocked(listen).mockImplementation(
    (() => new Promise((r) => register.push(r))) as typeof listen,
  );
  try {
    renderTv(<TvLogin />).unmount();
    const pkce = vi
      .mocked(listen)
      .mock.calls.filter(([name]) => String(name).startsWith("pkce-login-"));
    expect(pkce).toHaveLength(4);
    await act(async () => register.forEach((r) => r(unlisten)));
    expect(unlisten).toHaveBeenCalledTimes(register.length);
  } finally {
    vi.mocked(listen).mockImplementation(original);
  }
});
