import type { ReactNode } from "react";

interface SettingRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  disabled?: boolean;
  /** HTML title tooltip on the row — used to explain a disabled/grayed state. */
  tooltip?: string;
}

export default function SettingRow({
  title,
  subtitle,
  children,
  disabled,
  tooltip,
}: SettingRowProps) {
  return (
    <div
      title={tooltip}
      className={`flex items-center gap-3.5 px-4 py-3 ${disabled ? "opacity-45" : ""}`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-[13.5px] font-semibold text-th-text-primary">
          {title}
        </p>
        {subtitle && (
          <p className="text-[11.5px] text-th-text-muted mt-0.5">{subtitle}</p>
        )}
      </div>
      {children}
    </div>
  );
}
