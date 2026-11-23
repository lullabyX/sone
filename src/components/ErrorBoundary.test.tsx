import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ErrorBoundary from "./ErrorBoundary";

let consoleError: MockInstance<typeof console.error>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  consoleError.mockRestore();
});

function Boom(): never {
  throw new Error("x");
}

it("renders a custom fallback when given", () => {
  render(
    <ErrorBoundary onGoHome={() => {}} fallback={() => <p>tv crash</p>}>
      <Boom />
    </ErrorBoundary>,
  );
  expect(screen.getByText("tv crash")).toBeTruthy();
});

it("keeps the desktop page by default", () => {
  render(
    <ErrorBoundary onGoHome={() => {}}>
      <Boom />
    </ErrorBoundary>,
  );
  expect(screen.getByText("Something went wrong")).toBeTruthy();
});
