import { createContext, useContext, type ReactNode } from "react";

const PageScrollContext = createContext<HTMLElement | null>(null);

/**
 * Publishes the one element that scrolls page content. Page roots carry
 * `overflow-y-auto` but are height-auto inside a block parent, so they never
 * scroll — a consumer that walks the DOM for an `overflow-y` ancestor finds one
 * of those instead and silently does nothing useful.
 *
 * The value is `null` both when no provider sits above the consumer and until
 * the container's ref attaches after the first commit, so consumers must treat
 * the element as a dependency rather than reading it once.
 */
export function PageScrollProvider({
  element,
  children,
}: {
  element: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <PageScrollContext.Provider value={element}>
      {children}
    </PageScrollContext.Provider>
  );
}

export function usePageScrollElement(): HTMLElement | null {
  return useContext(PageScrollContext);
}
