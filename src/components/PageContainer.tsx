import { ReactNode } from "react";

export default function PageContainer({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`mx-auto w-full ${className}`.trim()}
      style={{ maxWidth: 1872 }}
    >
      {children}
    </div>
  );
}
