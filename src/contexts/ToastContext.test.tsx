import { useEffect } from "react";
import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { tvModeAtom } from "../atoms/tv";
import { setupTvTest } from "../components/tv/tvTestUtils";
import { ToastProvider, useToast } from "./ToastContext";

setupTvTest();

function Fire() {
  const { showToast } = useToast();
  useEffect(
    () =>
      showToast("Update available", "info", 30000, {
        label: "View release",
        onClick: () => {},
      }),
    [showToast],
  );
  return null;
}

it("has no buttons in TV mode, and sits above TV overlays", () => {
  const store = createStore();
  store.set(tvModeAtom, true);
  render(
    <Provider store={store}>
      <ToastProvider>
        <Fire />
      </ToastProvider>
    </Provider>,
  );
  expect(screen.getByText("Update available")).toBeTruthy();
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  expect(document.querySelector(".sone-toasts")!.className).toContain(
    "z-[10001]",
  );
});

it("keeps the action and close buttons on the desktop", () => {
  render(
    <Provider store={createStore()}>
      <ToastProvider>
        <Fire />
      </ToastProvider>
    </Provider>,
  );
  expect(screen.getAllByRole("button")).toHaveLength(2);
  expect(document.querySelector(".sone-toasts")!.className).toContain(
    "z-[9900]",
  );
});
