import type { ReactNode } from "react";
import { Check } from "lucide-react";

export function TvSettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-[2rem]">
      <h2 className="text-[0.7rem] font-bold uppercase tracking-[0.15em] text-th-text-muted px-[1rem] mb-[0.5rem]">
        {title}
      </h2>
      <div className="flex flex-col gap-[0.2rem]">{children}</div>
    </section>
  );
}

function TvSwitch({ on }: { on: boolean }) {
  return (
    <span
      role="switch"
      aria-checked={on}
      className={`relative inline-flex w-[2.4rem] h-[1.3rem] shrink-0 rounded-full transition-colors ${
        on ? "bg-th-accent" : "bg-th-border-subtle"
      }`}
    >
      <span
        className={`absolute top-[0.15rem] w-[1rem] h-[1rem] rounded-full bg-th-text-primary transition-transform ${
          on ? "translate-x-[1.25rem]" : "translate-x-[0.15rem]"
        }`}
      />
    </span>
  );
}

/**
 * One settings line with a switch, a check or a value. With `onSelect` it is
 * a focusable row; without it, a plain information line.
 */
export function TvSettingsRow({
  title,
  subtitle,
  toggle,
  checked,
  value,
  disabled,
  autoFocus,
  onSelect,
}: {
  title: string;
  subtitle?: string;
  toggle?: boolean;
  checked?: boolean;
  value?: ReactNode;
  disabled?: boolean;
  autoFocus?: boolean;
  onSelect?: () => void;
}) {
  const layout = `flex items-center gap-[1rem] w-full px-[1rem] py-[0.75rem] rounded-[0.6rem] text-left ${
    disabled ? "opacity-40" : ""
  }`;
  const content = (
    <>
      <span className="flex-1 min-w-0">
        <span
          className={`block text-[0.85rem] font-semibold ${
            checked ? "text-th-accent" : "text-th-text-primary"
          }`}
        >
          {title}
        </span>
        {subtitle && (
          <span className="block text-[0.65rem] text-th-text-muted mt-[0.1rem]">
            {subtitle}
          </span>
        )}
      </span>
      {value}
      {toggle !== undefined && <TvSwitch on={toggle} />}
      {checked && <Check className="w-[1.1rem] h-[1.1rem] text-th-accent" />}
    </>
  );

  if (!onSelect) return <div className={layout}>{content}</div>;

  return (
    <button
      data-tv-focusable
      data-tv-autofocus={autoFocus || undefined}
      disabled={disabled}
      onClick={() => onSelect()}
      className={`tv-track ${layout}`}
    >
      {content}
    </button>
  );
}
