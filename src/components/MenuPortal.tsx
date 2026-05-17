import { createPortal } from "react-dom";
import type { ReactNode } from "react";

export default function MenuPortal({ children }: { children: ReactNode }) {
  return createPortal(
    <div data-menu-portal="true" style={{ display: "contents" }}>
      {children}
    </div>,
    document.body,
  );
}
