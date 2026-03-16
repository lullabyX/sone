export default function Toggle({ on }: { on: boolean }) {
  return (
    <div
      className={`w-8 h-[18px] rounded-full transition-colors shrink-0 flex ${
        on ? "bg-th-accent" : "bg-th-border-subtle"
      }`}
    >
      <div
        className={`w-3.5 h-3.5 rounded-full bg-th-text-primary mt-[2px] transition-transform ${
          on ? "translate-x-[16px]" : "translate-x-[2px]"
        }`}
      />
    </div>
  );
}
