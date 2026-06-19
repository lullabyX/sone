import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface SettingRowProps {
  icon?: LucideIcon; // accepted for back-compat during the de-icon pass; not rendered
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  disabled?: boolean;
}

export default function SettingRow({ title, subtitle, children, disabled }: SettingRowProps) {
  return (
    <div className={`flex items-center gap-3.5 px-4 py-3 ${disabled ? "opacity-45" : ""}`}>
      <div className="flex-1 min-w-0">
        <p className="text-[13.5px] font-semibold text-th-text-primary">{title}</p>
        {subtitle && <p className="text-[11.5px] text-th-text-muted mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}
