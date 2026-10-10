import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { Provider, createStore } from "jotai";

const invokeMock = vi.fn((..._a: unknown[]) => Promise.resolve(undefined));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));

import PlaybackTab from "./PlaybackTab";
import {
  allowAiAtom,
  allowExplicitAtom,
  currentTrackAtom,
  queueAtom,
} from "../../atoms/playback";

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockClear();
});
afterEach(() => cleanup());

const loaded = () => {
  const store = createStore();
  store.set(currentTrackAtom, { id: 1, title: "x", duration: 1 } as never);
  store.set(queueAtom, [
    { id: 2, title: "y", duration: 1, _qid: "q" },
  ] as never);
  return store;
};

const toggleFor = (getByText: (t: string) => HTMLElement, title: string) =>
  getByText(title).closest("[data-setting-row]")!.querySelector("button")!;

describe("content toggles", () => {
  it("asks before turning AI off while something is queued", () => {
    const store = loaded();
    const { getByText, getByRole, queryByText } = render(
      <Provider store={store}>
        <PlaybackTab />
      </Provider>,
    );
    fireEvent.click(toggleFor(getByText, "Allow AI content"));
    expect(getByRole("dialog").textContent).toContain(
      "Turning this off clears your current queue.",
    );
    expect(getByText("Turn off AI content?")).toBeTruthy();
    expect(store.get(allowAiAtom)).toBe(true);
    fireEvent.click(getByText("Not now"));
    expect(
      queryByText("Turning this off clears your current queue."),
    ).toBeNull();
    expect(store.get(queueAtom)).toHaveLength(1);
  });

  it("Escape dismisses the dialog without turning explicit off", () => {
    const store = loaded();
    const { getByText, queryByRole } = render(
      <Provider store={store}>
        <PlaybackTab />
      </Provider>,
    );
    fireEvent.click(toggleFor(getByText, "Allow explicit content"));
    expect(getByText("Turn off explicit content?")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(queryByRole("dialog")).toBeNull();
    expect(store.get(allowExplicitAtom)).toBe(true);
    expect(store.get(queueAtom)).toHaveLength(1);
  });

  it("clears playback when the user confirms", () => {
    const store = loaded();
    const { getByText } = render(
      <Provider store={store}>
        <PlaybackTab />
      </Provider>,
    );
    fireEvent.click(toggleFor(getByText, "Allow AI content"));
    fireEvent.click(getByText("Yes, turn off"));
    expect(store.get(allowAiAtom)).toBe(false);
    expect(store.get(currentTrackAtom)).toBeNull();
    expect(store.get(queueAtom)).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("stop_track");
  });

  it("turns on without prompting or clearing", () => {
    const store = loaded();
    store.set(allowAiAtom, false);
    const { getByText, queryByText } = render(
      <Provider store={store}>
        <PlaybackTab />
      </Provider>,
    );
    fireEvent.click(toggleFor(getByText, "Allow AI content"));
    expect(
      queryByText("Turning this off clears your current queue."),
    ).toBeNull();
    expect(store.get(allowAiAtom)).toBe(true);
    expect(store.get(queueAtom)).toHaveLength(1);
  });

  it("turns explicit on without prompting, clearing, or stopping", () => {
    const store = loaded();
    store.set(allowExplicitAtom, false);
    const { getByText, queryByText } = render(
      <Provider store={store}>
        <PlaybackTab />
      </Provider>,
    );
    fireEvent.click(toggleFor(getByText, "Allow explicit content"));
    expect(
      queryByText("Turning this off clears your current queue."),
    ).toBeNull();
    expect(store.get(allowExplicitAtom)).toBe(true);
    expect(store.get(queueAtom)).toHaveLength(1);
    expect(invokeMock).not.toHaveBeenCalledWith("stop_track");
  });

  it("turns off immediately when nothing is loaded", () => {
    const store = createStore();
    const { getByText, queryByText } = render(
      <Provider store={store}>
        <PlaybackTab />
      </Provider>,
    );
    fireEvent.click(toggleFor(getByText, "Allow explicit content"));
    expect(
      queryByText("Turning this off clears your current queue."),
    ).toBeNull();
    expect(store.get(allowExplicitAtom)).toBe(false);
  });
});
