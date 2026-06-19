import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface SettingRowProps {
  icon: LucideIcon;
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  disabled?: boolean;
}

export default function SettingRow({
  icon: Icon,
  title,
  subtitle,
  children,
  disabled,
}: SettingRowProps) {
  return (
    <div
      className={`flex items-center gap-3.5 py-3.5 ${disabled ? "opacity-45" : ""}`}
    >
      <div className="w-[34px] h-[34px] shrink-0 rounded-[10px] bg-th-inset border border-th-border-subtle flex items-center justify-center text-th-text-secondary">
        <Icon size={17} />
      </div>
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
