import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { allowAiAtom } from "../atoms/playback";
import MediaCard from "./MediaCard";

const aiAlbum = { id: 1, title: "Paper Sun", ai: true };

describe("MediaCard AI label", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("badges and dims an ai album when AI is off; play no-ops, navigation still works", () => {
    const store = createStore();
    store.set(allowAiAtom, false);
    const onClick = vi.fn();
    const onPlay = vi.fn();
    const { container, getByLabelText } = render(
      <Provider store={store}>
        <MediaCard item={aiAlbum} onClick={onClick} onPlay={onPlay} />
      </Provider>,
    );
    expect(getByLabelText("AI-generated").textContent).toBe("AI");
    expect(container.firstElementChild?.className).toContain("opacity-50");
    fireEvent.click(container.querySelectorAll("button")[0]);
    expect(onPlay).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(container.firstElementChild!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("badges but does not dim or block when AI is on", () => {
    const onPlay = vi.fn();
    const { container, getByLabelText } = render(
      <Provider store={createStore()}>
        <MediaCard item={aiAlbum} onClick={() => {}} onPlay={onPlay} />
      </Provider>,
    );
    expect(getByLabelText("AI-generated")).toBeTruthy();
    expect(container.firstElementChild?.className).not.toContain("opacity-50");
    fireEvent.click(container.querySelectorAll("button")[0]);
    expect(onPlay).toHaveBeenCalledTimes(1);
  });
});
