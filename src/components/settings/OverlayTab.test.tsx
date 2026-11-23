import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => new Promise(() => {})),
}));

import OverlayTab from "./OverlayTab";
import { fieldLabel } from "../tv/tvFields";

afterEach(cleanup);

describe("OverlayTab", () => {
  it("names its host and port fields, so a TV prompt is titled by them", () => {
    render(
      <Provider store={createStore()}>
        <OverlayTab />
      </Provider>,
    );
    const host = screen.getByRole("textbox", { name: "Network interface" });
    const port = screen.getByRole("spinbutton", { name: "Port" });
    expect(fieldLabel(host as HTMLInputElement)).toBe("Network interface");
    expect(fieldLabel(port as HTMLInputElement)).toBe("Port");
  });
});
