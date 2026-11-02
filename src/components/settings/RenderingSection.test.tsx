import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
import RenderingSection from "./RenderingSection";
beforeEach(() => { invoke.mockReset(); invoke.mockImplementation(async (cmd) => cmd === "get_render_status" ? { mode: "auto", path: "cpu", envOverride: false, nvidia: true, reason: "NVIDIA detected" } : undefined); });
afterEach(cleanup);
describe("RenderingSection", () => {
  it("shows the current path and reason", async () => {
    render(<RenderingSection />);
    await waitFor(() => screen.getByText("Currently: CPU (NVIDIA detected)"));
  });
  it("asks before restarting into a new mode", async () => {
    render(<RenderingSection />);
    await waitFor(() => screen.getByText("Currently: CPU (NVIDIA detected)"));
    fireEvent.click(screen.getByText("GPU"));
    expect(invoke).not.toHaveBeenCalledWith("set_render_mode", expect.anything());
    fireEvent.click(screen.getByText("Restart"));
    expect(invoke).toHaveBeenCalledWith("set_render_mode", { mode: "gpu" });
  });
  it("re-selecting the current mode does nothing", async () => {
    render(<RenderingSection />);
    await waitFor(() => screen.getByText("Currently: CPU (NVIDIA detected)"));
    fireEvent.click(screen.getByText("Auto"));
    expect(screen.queryByText("Restart")).toBeNull();
  });
});
