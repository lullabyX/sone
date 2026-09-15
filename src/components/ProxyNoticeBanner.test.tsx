import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import ProxyNoticeBanner, {
  proxyNotice,
  noticeKey,
  PROXY_STATUS_EVENT,
  OPEN_SETTINGS_EVENT,
} from "./ProxyNoticeBanner";

beforeEach(() => {
  invoke.mockReset();
});
afterEach(() => cleanup());

describe("proxyNotice", () => {
  it("reports only the states that stop the app working", () => {
    expect(proxyNotice({ state: "off" })).toBeNull();
    expect(proxyNotice({ state: "active", degraded: [] })).toBeNull();
    // Degraded is a per-feature notice, never a bar across the window: the API
    // still works, so the app is usable.
    expect(proxyNotice({ state: "active", degraded: ["dash"] })).toBeNull();
    expect(
      proxyNotice({ state: "blocked", reason: "port must not be 0" })?.detail,
    ).toBe("port must not be 0");
  });

  it("never renders an empty banner", () => {
    // A red bar that says nothing is worse than a generic sentence.
    expect(proxyNotice({ state: "blocked", reason: "   " })?.detail).toBe(
      "The proxy settings are unusable",
    );
    expect(proxyNotice({ state: "blocked" })?.detail).toBe(
      "The proxy settings are unusable",
    );
    expect(proxyNotice(null)).toBeNull();
    expect(proxyNotice("blocked")).toBeNull();
  });

  /// The wording is the requirement, not decoration. reqwest reports a 407 on
  /// the CONNECT tunnel — a mistyped proxy password — with the same kind as a
  /// failed DNS lookup, and an unplugged cable produces the same evidence
  /// again, so the sentence has to survive being true in all three worlds.
  it("says what was observed and never diagnoses a cause it cannot see", () => {
    const notice = proxyNotice({
      state: "unreachable",
      endpoint: "nope.invalid:8080",
    });
    expect(notice?.headline).toBe(
      "SONE isn't getting a reply through the proxy at nope.invalid:8080.",
    );
    // Names the proxy, because that is what the user can act on from here.
    expect(notice?.headline).toContain("nope.invalid:8080");
    // Every cause that produces this evidence, including the one a bare
    // "can't reach it" would misdirect: the proxy answering and refusing.
    expect(notice?.detail).toMatch(/unreachable/i);
    expect(notice?.detail).toMatch(/refusing the connection/i);
    expect(notice?.detail).toMatch(/password/i);
    expect(notice?.detail).toMatch(/offline/i);
    for (const guess of ["is down", "has stopped"]) {
      expect(notice?.headline.toLowerCase()).not.toContain(guess);
      expect(notice?.detail?.toLowerCase()).not.toContain(guess);
    }
  });

  /// The dismissal key. Nothing to dismiss where there is no notice, and two
  /// occurrences of the same state against different endpoints are different
  /// claims — which is what makes a dismissal expire on recovery rather than
  /// on a timer nobody chose.
  it("keys a dismissal to the claim being made, not to the state alone", () => {
    expect(noticeKey({ state: "off" })).toBeNull();
    expect(noticeKey({ state: "active", degraded: [] })).toBeNull();
    expect(noticeKey(null)).toBeNull();

    const one = noticeKey({ state: "unreachable", endpoint: "one.invalid:80" });
    expect(one).toBe(
      noticeKey({ state: "unreachable", endpoint: "one.invalid:80" }),
    );
    expect(one).not.toBe(
      noticeKey({ state: "unreachable", endpoint: "two.invalid:80" }),
    );
    expect(one).not.toBe(
      noticeKey({ state: "blocked", reason: "one.invalid:80" }),
    );
    expect(
      noticeKey({ state: "blocked", reason: "port must not be 0" }),
    ).not.toBe(
      noticeKey({ state: "blocked", reason: "host must not be empty" }),
    );
  });

  it("still says something useful without an endpoint", () => {
    expect(proxyNotice({ state: "unreachable" })?.headline).toBe(
      "SONE isn't getting a reply through the proxy.",
    );
    expect(
      proxyNotice({ state: "unreachable", endpoint: "  " })?.headline,
    ).toBe("SONE isn't getting a reply through the proxy.");
  });
});

describe("the banner", () => {
  it("stays out of the way when the proxy is working", async () => {
    invoke.mockResolvedValue({ state: "active", degraded: [] });
    render(<ProxyNoticeBanner />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("get_proxy_status"),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /// The state a user can reach and cannot leave: the proxy plans fine, the
  /// client cannot be built, so every request including the login is refused
  /// and the settings screen is behind the login.
  it("reports a block with its reason", async () => {
    invoke.mockResolvedValue({
      state: "blocked",
      reason: "proxy unusable (socks5h://no-such-host.invalid:3128)",
    });
    render(<ProxyNoticeBanner />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("no-such-host.invalid");
  });

  /// The common case, and the one that used to render nothing at all: an
  /// `http://` proxy plans and builds even when its host cannot resolve, so
  /// the login failed with a raw DNS error naming the origin rather than the
  /// proxy that never carried the request.
  it("reports an unreachable proxy with the same way out", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_proxy_status"
        ? Promise.resolve({
            state: "unreachable",
            endpoint: "nope.invalid:8080",
          })
        : Promise.resolve(undefined),
    );
    render(<ProxyNoticeBanner />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("nope.invalid:8080");
    expect(screen.getByText("Turn off proxy")).toBeTruthy();
  });

  /// Turning the proxy off removes containment. Where a settings screen is
  /// reachable it must not be the only thing offered — and where it is not
  /// (the login screen), the offer must not appear at all.
  it("offers the non-destructive action only where settings exist", async () => {
    invoke.mockResolvedValue({
      state: "unreachable",
      endpoint: "nope.invalid:8080",
    });
    const { unmount } = render(<ProxyNoticeBanner />);
    await screen.findByRole("alert");
    expect(screen.queryByText("Open network settings")).toBeNull();
    unmount();

    const opened: unknown[] = [];
    const onOpen = (e: Event) => opened.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    try {
      render(<ProxyNoticeBanner offerSettings />);
      fireEvent.click(await screen.findByText("Open network settings"));
      expect(opened).toEqual(["network"]);
      // And the way out is still there beside it.
      expect(screen.getByText("Turn off proxy")).toBeTruthy();
    } finally {
      window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
    }
  });

  it("carries a way out that keeps the rest of the settings", async () => {
    const saved = {
      enabled: true,
      proxy_type: "http",
      host: "nope.invalid",
      port: 8080,
      username: "u",
      password: "p",
    };
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_proxy_status")
        return Promise.resolve({
          state: "unreachable",
          endpoint: "nope.invalid:8080",
        });
      if (cmd === "get_proxy_settings") return Promise.resolve(saved);
      return Promise.resolve(undefined);
    });
    render(<ProxyNoticeBanner />);
    fireEvent.click(await screen.findByText("Turn off proxy"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_proxy_settings", {
        // Disabled, and otherwise untouched: the user is turning the proxy
        // off, not discarding a configuration they may want back.
        settings: { ...saved, enabled: false },
      }),
    );
  });

  it("still disables when the saved settings cannot be read", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_proxy_status")
        return Promise.resolve({ state: "blocked", reason: "unusable" });
      if (cmd === "get_proxy_settings") return Promise.reject("no settings");
      return Promise.resolve(undefined);
    });
    render(<ProxyNoticeBanner />);
    fireEvent.click(await screen.findByText("Turn off proxy"));

    await waitFor(() => {
      const call = invoke.mock.calls.find((c) => c[0] === "set_proxy_settings");
      expect(call).toBeTruthy();
      expect(
        (call?.[1] as { settings: { enabled: boolean } }).settings.enabled,
      ).toBe(false);
    });
  });

  it("clears itself once the block is gone", async () => {
    let blocked = true;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_proxy_status")
        return Promise.resolve(
          blocked ? { state: "blocked", reason: "unusable" } : { state: "off" },
        );
      return Promise.resolve(undefined);
    });
    render(<ProxyNoticeBanner />);
    await screen.findByRole("alert");

    blocked = false;
    fireEvent(window, new Event(PROXY_STATUS_EVENT));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  /// Nobody tells the banner that a request has started working again — the
  /// recovery is a request succeeding somewhere else entirely — so it polls
  /// while a proxy is configured, and stops the moment there is nothing a
  /// proxy notice could ever be about.
  it("polls itself back to normal once requests get through again", async () => {
    vi.useFakeTimers();
    try {
      let unreachable = true;
      invoke.mockImplementation((cmd: string) =>
        cmd === "get_proxy_status"
          ? Promise.resolve(
              unreachable
                ? { state: "unreachable", endpoint: "nope.invalid:8080" }
                : { state: "active", degraded: [] },
            )
          : Promise.resolve(undefined),
      );
      render(<ProxyNoticeBanner />);
      await vi.waitFor(() =>
        expect(screen.queryByRole("alert")).not.toBeNull(),
      );

      unreachable = false;
      await vi.advanceTimersByTimeAsync(16000);
      await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll while the proxy is off", async () => {
    vi.useFakeTimers();
    try {
      invoke.mockResolvedValue({ state: "off" });
      render(<ProxyNoticeBanner />);
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(60000);
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /// The bug the probe closes. The count behind `unreachable` is cleared only
  /// by an answered request, and once the bar is up the app is making none —
  /// so a proxy repaired outside SONE, with no settings saved and no client
  /// rebuilt, left the bar standing forever. The poll has to send the request
  /// that was missing, and send it *before* it reads the status back.
  it("sends a probe while unreachable so a repaired proxy can clear the bar", async () => {
    vi.useFakeTimers();
    try {
      let recovered = false;
      const order: string[] = [];
      invoke.mockImplementation((cmd: string) => {
        order.push(cmd);
        if (cmd === "probe_proxy_reachability") {
          recovered = true;
          return Promise.resolve(undefined);
        }
        if (cmd === "get_proxy_status")
          return Promise.resolve(
            recovered
              ? { state: "active", degraded: [] }
              : { state: "unreachable", endpoint: "nope.invalid:8080" },
          );
        return Promise.resolve(undefined);
      });
      render(<ProxyNoticeBanner />);
      await vi.waitFor(() =>
        expect(screen.queryByRole("alert")).not.toBeNull(),
      );

      await vi.advanceTimersByTimeAsync(16000);
      await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

      // The probe is worthless after the read: the status it fed would not be
      // seen for another fifteen seconds.
      const probed = order.indexOf("probe_proxy_reachability");
      expect(probed).toBeGreaterThan(-1);
      expect(order[probed + 1]).toBe("get_proxy_status");
    } finally {
      vi.useRealTimers();
    }
  });

  /// Polling has to stay free everywhere else. `off` and `active` have nothing
  /// to find out, and `blocked` has no client to send through — a probe in any
  /// of them would put a packet on the wire to answer a question that was
  /// already answered.
  it("probes in no other state", async () => {
    vi.useFakeTimers();
    try {
      for (const settled of [
        { state: "active", degraded: [] },
        { state: "blocked", reason: "port must not be 0" },
      ]) {
        invoke.mockReset();
        // Start unreachable so the banner's own text can witness the status
        // actually landing — a poll asserted before the first read has flushed
        // proves nothing, because the interval is not installed yet.
        let state: unknown = {
          state: "unreachable",
          endpoint: "nope.invalid:8080",
        };
        invoke.mockImplementation((cmd: string) =>
          cmd === "get_proxy_status"
            ? Promise.resolve(state)
            : Promise.resolve(undefined),
        );
        const { unmount } = render(<ProxyNoticeBanner />);
        await vi.waitFor(() =>
          expect(screen.queryByText(/nope\.invalid/)).not.toBeNull(),
        );

        state = settled;
        await vi.advanceTimersByTimeAsync(16000);
        await vi.waitFor(() =>
          expect(screen.queryByText(/nope\.invalid/)).toBeNull(),
        );

        const mark = invoke.mock.calls.length;
        await vi.advanceTimersByTimeAsync(60000);
        expect(invoke.mock.calls.length).toBeGreaterThan(mark);
        expect(
          invoke.mock.calls
            .slice(mark)
            .filter((c) => c[0] === "probe_proxy_reachability"),
        ).toEqual([]);
        unmount();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  /// The bar is not always just a report. On the login screen Settings →
  /// Network is behind the login the proxy is refusing, so the bar *is* the
  /// escape hatch — and dismissing it would take the escape with it. `blocked`
  /// makes that permanent for the session: nothing is sent through a cell with
  /// no client, so no probe and no request can ever change what the status
  /// says. `unreachable` only recovers if the proxy does. Neither is a bet to
  /// put behind a close button.
  it("keeps the last way out where there is no other", async () => {
    for (const state of [
      { state: "blocked", reason: "proxy unusable" },
      { state: "unreachable", endpoint: "nope.invalid:8080" },
    ]) {
      invoke.mockReset();
      invoke.mockResolvedValue(state);

      const { unmount } = render(<ProxyNoticeBanner />);
      await screen.findByRole("alert");
      expect(screen.queryByLabelText("Dismiss")).toBeNull();
      expect(screen.getByText("Turn off proxy")).toBeTruthy();
      unmount();

      // And where a settings screen is reachable it is a report again, so it
      // can be put away.
      render(<ProxyNoticeBanner offerSettings />);
      await screen.findByRole("alert");
      expect(screen.getByLabelText("Dismiss")).toBeTruthy();
      cleanup();
    }
  });

  /// The tooltip has to be true of the tone it is on. `unreachable` clears
  /// itself once the probe gets an answer; `blocked` never does, so promising
  /// it will come back "next time this happens" would be a lie — it has not
  /// stopped happening.
  it("says why the bar will come back, per tone", async () => {
    invoke.mockResolvedValue({
      state: "unreachable",
      endpoint: "nope.invalid:8080",
    });
    const { unmount } = render(<ProxyNoticeBanner offerSettings />);
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Dismiss").getAttribute("title")).toBe(
      "Dismiss — shown again the next time this happens",
    );
    unmount();

    invoke.mockResolvedValue({ state: "blocked", reason: "proxy unusable" });
    render(<ProxyNoticeBanner offerSettings />);
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Dismiss").getAttribute("title")).toBe(
      "Dismiss — shown again if the reason changes",
    );
  });

  /// A bar the user cannot put away is its own problem, where putting it away
  /// does not also throw away the only thing that can fix it.
  it("can be dismissed by hand", async () => {
    invoke.mockResolvedValue({
      state: "unreachable",
      endpoint: "nope.invalid:8080",
    });
    render(<ProxyNoticeBanner offerSettings />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByLabelText("Dismiss"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  /// And the rule that keeps dismissal honest: it is pinned to the condition
  /// in front of the user, so it lasts exactly as long as that condition stays
  /// continuously true. The proxy recovering retires the dismissal with it —
  /// the next failure is news again, not something the user already waved off.
  it("comes back when the same failure happens again later", async () => {
    let state: unknown = {
      state: "unreachable",
      endpoint: "nope.invalid:8080",
    };
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_proxy_status"
        ? Promise.resolve(state)
        : Promise.resolve(undefined),
    );
    render(<ProxyNoticeBanner offerSettings />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByLabelText("Dismiss"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    // Still failing, still dismissed: the user said "not now" about this.
    fireEvent(window, new Event(PROXY_STATUS_EVENT));
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();

    state = { state: "active", degraded: [] };
    fireEvent(window, new Event(PROXY_STATUS_EVENT));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    state = { state: "unreachable", endpoint: "nope.invalid:8080" };
    fireEvent(window, new Event(PROXY_STATUS_EVENT));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
  });

  /// A dismissal must not carry across to a different claim. Same state, new
  /// endpoint — or a new block reason — is a sentence the user has not read.
  it("does not let a dismissal cover a different failure", async () => {
    let state: unknown = { state: "unreachable", endpoint: "one.invalid:8080" };
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_proxy_status"
        ? Promise.resolve(state)
        : Promise.resolve(undefined),
    );
    render(<ProxyNoticeBanner offerSettings />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByLabelText("Dismiss"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    state = { state: "unreachable", endpoint: "two.invalid:9090" };
    fireEvent(window, new Event(PROXY_STATUS_EVENT));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("two.invalid:9090");
  });

  it("does not invent a notice out of a failed status call", async () => {
    invoke.mockRejectedValue("ipc broke");
    render(<ProxyNoticeBanner />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
