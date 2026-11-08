import { invoke } from "@tauri-apps/api/core";

export type RenderMode = "auto" | "gpu" | "cpu";

export interface RenderStatus {
  mode: RenderMode;
  path: "gpu" | "cpu";
  envOverride: boolean;
  nvidia: boolean;
  reason: string;
}

export interface ActiveTrial {
  mode: RenderMode;
  revertTo: RenderMode;
  unprompted: boolean;
  deadlineMs: number;
}

export const RENDER_MODE_LABELS: Record<RenderMode, string> = {
  auto: "Auto",
  gpu: "GPU",
  cpu: "CPU",
};

export const getRenderStatus = () => invoke<RenderStatus>("get_render_status");
export const setRenderMode = (mode: RenderMode) =>
  invoke<void>("set_render_mode", { mode });
export const getRenderTrial = () =>
  invoke<ActiveTrial | null>("get_render_trial");
export const confirmRenderMode = () => invoke<void>("confirm_render_mode");
export const revertRenderMode = () => invoke<void>("revert_render_mode");
export const getRenderReverted = () =>
  invoke<RenderMode | null>("get_render_reverted");
