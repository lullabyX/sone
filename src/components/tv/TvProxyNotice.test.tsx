import { expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { OPEN_SETTINGS_EVENT } from "../../hooks/useProxyNotice";
import TvProxyNotice from "./TvProxyNotice";
import { deferred, mockInvoke, renderTv, setupTvTest } from "./tvTestUtils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

setupTvTest();

const BLOCKED = { state: "blocked", reason: "port must not be 0" };

it("inside the app: Network settings, Turn off proxy and Dismiss, all reachable by remote", async () => {
  mockInvoke({ get_proxy_status: () => BLOCKED });
  renderTv(<TvProxyNotice offerSettings />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Proxy blocked");
  expect(alert.textContent).toContain("port must not be 0");
  for (const name of ["Network settings", "Turn off proxy", "Dismiss"]) {
    const b = screen.getByRole("button", { name });
    expect(b.hasAttribute("data-tv-focusable")).toBe(true);
    expect(b.classList.contains("tv-button")).toBe(true);
  }
  // A report here, not the way out: nothing is the main action.
  expect(
    screen
      .getByRole("button", { name: "Turn off proxy" })
      .classList.contains("bg-th-accent"),
  ).toBe(false);
});

it("on the sign-in screen Turn off proxy is the main action, with nothing else", async () => {
  mockInvoke({ get_proxy_status: () => BLOCKED });
  renderTv(<TvProxyNotice />);
  const off = await screen.findByRole("button", { name: "Turn off proxy" });
  expect(off.classList.contains("bg-th-accent")).toBe(true);
  expect(screen.getAllByRole("button")).toEqual([off]);
});

it("is sized for the TV, not zoomed from the desktop bar", async () => {
  mockInvoke({
    get_proxy_status: () => ({ state: "unreachable", endpoint: "p:8080" }),
  });
  renderTv(<TvProxyNotice />);
  const alert = await screen.findByRole("alert");
  expect(alert.classList.contains("sone-proxy-banner")).toBe(false);
  const detail = screen.getByText(/requests are going out/i);
  expect(detail.className).toContain("line-clamp-2");
  expect(detail.className).toContain("text-[0.75rem]");
});

it("Network settings opens the settings sheet on Network", async () => {
  mockInvoke({ get_proxy_status: () => BLOCKED });
  const opened: unknown[] = [];
  const onOpen = (e: Event) => opened.push((e as CustomEvent).detail);
  window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
  try {
    renderTv(<TvProxyNotice offerSettings />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Network settings" }),
    );
    expect(opened).toEqual(["network"]);
  } finally {
    window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
  }
});

it("Turn off proxy says it is busy, ignores more presses, and keeps focus", async () => {
  const save = deferred<void>();
  let off = false;
  mockInvoke({
    get_proxy_status: () => (off ? { state: "off" } : BLOCKED),
    get_proxy_settings: () => ({
      enabled: true,
      proxy_type: "http",
      host: "h",
      port: 0,
      username: null,
      password: null,
    }),
    set_proxy_settings: () => save.promise,
  });
  const onGone = vi.fn();
  renderTv(<TvProxyNotice onGone={onGone} />);
  const button = await screen.findByRole("button", { name: "Turn off proxy" });
  act(() => button.focus());
  fireEvent.click(button);
  await act(async () => {});
  expect(button.textContent).toBe("Turning off…");
  fireEvent.click(button);
  await act(async () => {});
  const saves = () =>
    vi.mocked(invoke).mock.calls.filter((c) => c[0] === "set_proxy_settings");
  expect(saves()).toHaveLength(1);
  expect(document.activeElement).toBe(button);

  off = true;
  await act(async () => save.resolve());
  expect(screen.queryByRole("alert")).toBeNull();
  // Focus was on the notice when it went: the screen takes it back.
  expect(onGone).toHaveBeenCalledTimes(1);
});

it("shows why the proxy could not be turned off", async () => {
  mockInvoke({
    get_proxy_status: () => BLOCKED,
    get_proxy_settings: () => {
      throw "no settings";
    },
    set_proxy_settings: () => {
      throw "disk full";
    },
  });
  renderTv(<TvProxyNotice />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Turn off proxy" }),
  );
  expect(await screen.findByText("disk full")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Turn off proxy" })).toBeTruthy();
});

it("Dismiss hides it and hands focus back to the screen", async () => {
  mockInvoke({ get_proxy_status: () => BLOCKED });
  const onGone = vi.fn();
  renderTv(<TvProxyNotice offerSettings onGone={onGone} />);
  const dismiss = await screen.findByRole("button", { name: "Dismiss" });
  act(() => dismiss.focus());
  fireEvent.click(dismiss);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(onGone).toHaveBeenCalledTimes(1);
});

it("leaves focus alone when it went away while focus was elsewhere", async () => {
  mockInvoke({ get_proxy_status: () => BLOCKED });
  const onGone = vi.fn();
  renderTv(
    <>
      <TvProxyNotice offerSettings onGone={onGone} />
      <button>screen</button>
    </>,
  );
  const dismiss = await screen.findByRole("button", { name: "Dismiss" });
  act(() => dismiss.focus());
  const other = screen.getByRole("button", { name: "screen" });
  act(() => other.focus());
  fireEvent.click(dismiss);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(onGone).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(other);
});
