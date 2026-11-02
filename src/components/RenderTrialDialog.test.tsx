import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
const showToast = vi.fn();
vi.mock("../contexts/ToastContext", () => ({ useToast: () => ({ showToast }) }));
import RenderTrialDialog from "./RenderTrialDialog";
beforeEach(() => { invoke.mockReset(); showToast.mockReset(); vi.useFakeTimers({ now: 1_000_000, shouldAdvanceTime: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const trial = (over = {}) => ({ mode: "gpu", revertTo: "auto", unprompted: false, deadlineMs: 1_000_000 + 40_000, ...over });
describe("RenderTrialDialog", () => {
  it("renders nothing without a trial", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "get_render_trial" ? null : null));
    render(<RenderTrialDialog />);
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("counts down and keeps", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "get_render_trial" ? trial() : null));
    render(<RenderTrialDialog />);
    await waitFor(() => screen.getByRole("dialog"));
    expect(screen.getByText(/Reverting to Auto in 40 s/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText(/in 37 s/)).toBeTruthy();
    fireEvent.click(screen.getByText("Keep"));
    expect(invoke).toHaveBeenCalledWith("confirm_render_mode");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("reverts on request and words the unprompted case", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "get_render_trial" ? trial({ unprompted: true, mode: "auto", revertTo: "cpu" }) : null));
    render(<RenderTrialDialog />);
    await waitFor(() => screen.getByRole("dialog"));
    expect(screen.getByText("SONE is now rendering on the GPU. Keep it?")).toBeTruthy();
    fireEvent.click(screen.getByText("Revert"));
    expect(invoke).toHaveBeenCalledWith("revert_render_mode");
  });
  it("toasts a revert from the previous launch", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "get_render_reverted" ? "auto" : null));
    render(<RenderTrialDialog />);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Rendering mode reverted to Auto"));
  });
});
