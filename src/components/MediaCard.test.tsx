import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
vi.mock("../hooks/useContentPrefs", () => ({ useContentPrefs: () => ({ allowAi: true }) }));
import MediaCard from "./MediaCard";
afterEach(cleanup);
const item = { id: 1, title: "T", cover: null, artists: [] };
describe("MediaCard hover buttons", () => {
  it("mounts the blurred buttons only while hovered or focused", () => {
    const { container } = render(<MediaCard item={item} onClick={() => {}} onMoreClick={() => {}} onFavoriteToggle={() => {}} />);
    const blurred = () => container.querySelectorAll(".backdrop-blur-sm").length;
    expect(blurred()).toBe(0);
    fireEvent.mouseEnter(container.firstChild as Element);
    expect(blurred()).toBe(2);
    fireEvent.mouseLeave(container.firstChild as Element);
    expect(blurred()).toBe(0);
    fireEvent.focus(container.firstChild as Element);
    expect(blurred()).toBe(2);
    expect(container.querySelector(".animate-fadeIn")).not.toBeNull();
    fireEvent.blur(container.firstChild as Element);
    expect(blurred()).toBe(0);
  });
  it("mounts on focus bubbling from a child and survives focus moving within the card", () => {
    const { container } = render(<MediaCard item={item} onClick={() => {}} onMoreClick={() => {}} onFavoriteToggle={() => {}} />);
    const blurred = () => container.querySelectorAll(".backdrop-blur-sm");
    const play = container.querySelector("button") as HTMLButtonElement;
    fireEvent.focus(play);
    expect(blurred().length).toBe(2);
    fireEvent.blur(play, { relatedTarget: blurred()[0] });
    expect(blurred().length).toBe(2);
    fireEvent.blur(blurred()[0], { relatedTarget: document.body });
    expect(blurred().length).toBe(0);
  });
  it("artist cards never mount them", () => {
    const { container } = render(<MediaCard item={item} onClick={() => {}} isArtist />);
    fireEvent.mouseEnter(container.firstChild as Element);
    expect(container.querySelectorAll(".backdrop-blur-sm").length).toBe(0);
  });
});
