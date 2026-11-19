import { expect, it } from "vitest";
import { act } from "@testing-library/react";
import { OPEN_SETTINGS_EVENT } from "../ProxyNoticeBanner";
import { useTvMoreSettings } from "./useTvMoreSettings";
import { renderTvHook, setupTvTest } from "./tvTestUtils";

setupTvTest();

it("opens on Playback, closes, and never takes a click event as the tab", () => {
  const { result } = renderTvHook(() => useTvMoreSettings());
  act(() => result.current.open());
  expect(result.current.tab).toBe("playback");
  act(() => result.current.close());
  expect(result.current.tab).toBeNull();
  act(() => result.current.open(new MouseEvent("click") as never));
  expect(result.current.tab).toBe("playback");
});

it("the proxy notice's Open network settings opens it on Network", () => {
  const { result } = renderTvHook(() => useTvMoreSettings());
  act(() => {
    window.dispatchEvent(
      new CustomEvent(OPEN_SETTINGS_EVENT, { detail: "network" }),
    );
  });
  expect(result.current.tab).toBe("network");
});
