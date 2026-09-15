import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";
import { Provider, createStore } from "jotai";
import type { PropsWithChildren } from "react";

// NetworkTab saves through invoke("set_proxy_settings") on a 500ms debounce and
// probes through invoke("test_proxy_connection"). Both are driven per-call.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import NetworkTab from "./NetworkTab";
import { shouldSubmitProxy, submitProxy, proxyTestError } from "./proxySubmit";
import { proxySettingsAtom } from "../../atoms/proxy";

/** As Tauri delivers it: `SoneError` is `#[serde(tag="kind", content="message")]`,
 *  so `ProxyBlocked { reason }` arrives with `message` as an OBJECT. */
const proxyBlocked = (reason: string) => ({
  kind: "ProxyBlocked",
  message: { reason },
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("shouldSubmitProxy withholds half-typed settings", () => {
  // The debounce fires on every keystroke, so an enabled proxy with no host or
  // a zero port reaches the backend mid-word. The backend fails closed, which
  // means those partial settings take the whole app offline until the user
  // finishes typing.
  it("never submits an enabled proxy missing a host or a port", () => {
    expect(shouldSubmitProxy({ enabled: true, host: "", port: 0 })).toBe(false);
    expect(
      shouldSubmitProxy({ enabled: true, host: "127.0.0.1", port: 0 }),
    ).toBe(false);
    expect(shouldSubmitProxy({ enabled: true, host: "", port: 3128 })).toBe(
      false,
    );
    expect(shouldSubmitProxy({ enabled: true, host: "   ", port: 3128 })).toBe(
      false,
    );
  });

  it("submits once both a host and a port are present", () => {
    expect(
      shouldSubmitProxy({ enabled: true, host: "127.0.0.1", port: 3128 }),
    ).toBe(true);
  });

  it("always submits a disabled proxy — turning it off is the recovery path", () => {
    expect(shouldSubmitProxy({ enabled: false, host: "", port: 0 })).toBe(true);
  });
});

describe("submitProxy surfaces the refusal instead of swallowing it", () => {
  const settings = {
    enabled: true,
    proxy_type: "http" as const,
    host: "127.0.0.1",
    port: 3128,
    username: null,
    password: null,
  };

  it("reports the backend's own reason for a blocked proxy", async () => {
    invoke.mockRejectedValueOnce(proxyBlocked("proxy port must not be 0"));
    const onError = vi.fn();
    await submitProxy(settings, onError);
    expect(onError).toHaveBeenCalledWith("proxy port must not be 0");
  });

  it("never hands the caller a stringified object", async () => {
    invoke.mockRejectedValueOnce(proxyBlocked("proxy host must be ASCII"));
    const onError = vi.fn();
    await submitProxy(settings, onError);
    const reason = onError.mock.calls[0][0];
    expect(typeof reason).toBe("string");
    expect(reason).not.toContain("[object Object]");
  });

  it("falls back to a readable message for an unrecognized rejection", async () => {
    invoke.mockRejectedValueOnce({ kind: "Api", message: { status: 500 } });
    const onError = vi.fn();
    await submitProxy(settings, onError);
    expect(onError).toHaveBeenCalledWith("Could not apply proxy settings");
  });

  it("says nothing when the save succeeds", async () => {
    invoke.mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    await submitProxy(settings, onError);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("proxyTestError keeps the cause the backend reported", () => {
  // `test_proxy_connection` is Result<String, String>, so its rejection is a
  // plain string naming the actual problem. The banner used to replace every
  // one of these with "Connection failed — check host, port, and credentials".
  it("passes through the precise refusal", () => {
    expect(proxyTestError("proxy port must not be 0")).toBe(
      "proxy port must not be 0",
    );
    expect(proxyTestError("proxy host must be ASCII")).toBe(
      "proxy host must be ASCII",
    );
    expect(
      proxyTestError(
        "authenticated proxies need GStreamer 1.26.10 or newer for seeking (found 1.24.0)",
      ),
    ).toContain("1.26.10");
  });

  it("reads the reason out of a ProxyBlocked object rather than stringifying it", () => {
    expect(
      proxyTestError(proxyBlocked("the curl source plugin is missing")),
    ).toBe("the curl source plugin is missing");
  });

  it("falls back only when there is genuinely nothing to say", () => {
    expect(proxyTestError("")).toContain("check host, port, and credentials");
    expect(proxyTestError(undefined)).toContain(
      "check host, port, and credentials",
    );
  });
});

function renderTab(enabled: boolean) {
  const store = createStore();
  store.set(proxySettingsAtom, {
    enabled,
    proxy_type: "http",
    host: enabled ? "127.0.0.1" : "",
    port: enabled ? 3128 : 0,
    username: null,
    password: null,
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <Provider store={store}>{children}</Provider>
  );
  render(<NetworkTab />, { wrapper });
  return store;
}

describe("NetworkTab reports a blocked proxy to the user", () => {
  it("shows the block reason in the banner after the debounced save is refused", async () => {
    vi.useFakeTimers();
    invoke.mockRejectedValue(proxyBlocked("proxy port must not be 0"));
    renderTab(true);

    const host = screen.getByPlaceholderText("host");
    fireEvent.change(host, { target: { value: "10.0.0.1" } });

    // The save is debounced by 500ms; the rejection then has to settle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    const msg = screen.getByText("proxy port must not be 0");
    expect(msg).toBeTruthy();
    // Not just the text: the banner has to LOOK wrong too. Without this the
    // status could be set to a value outside the BannerStatus union and every
    // text assertion would still pass — only the typechecker would object.
    expect(msg.className).toContain("text-[#ff6666]");
  });

  it("keeps reporting a refusal after the proxy has been switched off", async () => {
    // The config block — banner included — used to be inside `enabled &&`.
    // Turning the proxy off always submits, by design, because that is the
    // recovery path; if that save is refused (an encrypted-write failure, say)
    // the error was written into an unmounted subtree and the user saw nothing.
    vi.useFakeTimers();
    invoke.mockRejectedValue({
      kind: "Io",
      message: "settings file is read-only",
    });
    const store = createStore();
    store.set(proxySettingsAtom, {
      enabled: true,
      proxy_type: "http",
      host: "127.0.0.1",
      port: 3128,
      username: null,
      password: null,
    });
    render(
      <Provider store={store}>
        <NetworkTab />
      </Provider>,
    );

    fireEvent.click(screen.getAllByRole("button")[0]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    // Toggle is off, so the address and auth fields are gone …
    expect(store.get(proxySettingsAtom).enabled).toBe(false);
    expect(screen.queryByPlaceholderText("host")).toBeNull();
    // … but the reason is still on screen, in the error treatment.
    const msg = screen.getByText("settings file is read-only");
    expect(msg.className).toContain("text-[#ff6666]");
  });

  it("lets a long refusal wrap instead of clipping or spilling the row", async () => {
    // A real one, ~80 characters. The message span was `flex-shrink-0` with no
    // wrapping and the endpoint beside it was the only shrinkable item, so this
    // crushed the endpoint to zero width and then spilled the bordered row.
    const reason =
      "authenticated proxies need GStreamer 1.26.10 or newer for seeking (found 1.24.0)";
    invoke.mockImplementation((cmd: string) =>
      cmd === "test_proxy_connection"
        ? Promise.reject(reason)
        : Promise.resolve(undefined),
    );
    renderTab(true);

    fireEvent.click(screen.getByText("Test connection"));
    const msg = await screen.findByText(reason);

    // jsdom does no layout, so assert the mechanism: the span may shrink and
    // may wrap. Truncation was the alternative and was rejected — a clipped
    // reason is the "banner that says nothing useful" this task removed.
    expect(msg.className).not.toContain("flex-shrink-0");
    expect(msg.className).toContain("min-w-0");
    expect(msg.className).toContain("break-words");
    expect(msg.parentElement?.className).toContain("flex-wrap");
    // And the whole reason is present, not an ellipsis of it.
    expect(msg.textContent).toBe(reason);
  });

  it("does not submit while the host field is still empty", async () => {
    vi.useFakeTimers();
    renderTab(true);

    const host = screen.getByPlaceholderText("host");
    fireEvent.change(host, { target: { value: "" } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(
      invoke.mock.calls.filter((c) => c[0] === "set_proxy_settings"),
    ).toHaveLength(0);
  });

  it("still submits when the proxy is switched off with empty fields", async () => {
    // Turning the proxy off is the way out of a bad one, so it must reach the
    // backend even though the host and port are exactly the partial values that
    // are withheld while it is on.
    vi.useFakeTimers();
    const store = createStore();
    store.set(proxySettingsAtom, {
      enabled: true,
      proxy_type: "http",
      host: "",
      port: 0,
      username: null,
      password: null,
    });
    render(
      <Provider store={store}>
        <NetworkTab />
      </Provider>,
    );

    // The toggle is the first button in the tab.
    fireEvent.click(screen.getAllByRole("button")[0]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    const saves = invoke.mock.calls.filter(
      (c) => c[0] === "set_proxy_settings",
    );
    expect(saves).toHaveLength(1);
    expect(
      (saves[0][1] as { settings: { enabled: boolean } }).settings.enabled,
    ).toBe(false);
  });

  it("shows the failing test's own reason, not a fixed sentence", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "test_proxy_connection") {
        return Promise.reject("proxy host must be ASCII");
      }
      return Promise.resolve(undefined);
    });
    renderTab(true);

    fireEvent.click(screen.getByText("Test connection"));

    expect(
      await screen.findByText("proxy host must be ASCII"),
    ).toBeTruthy();
  });
});
