import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Separate from vite.config.ts so the multi-input Tauri build config stays
// untouched. Vitest picks up this file automatically. jsdom gives hooks a DOM
// to render into; import describe/it/expect from "vitest" (no globals).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
  },
});
