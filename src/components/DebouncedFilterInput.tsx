import { memo, useState, useEffect, useRef } from "react";
import { Search } from "lucide-react";

interface DebouncedFilterInputProps {
  placeholder?: string;
  delay?: number;
  onChange: (value: string) => void;
  onFocus?: () => void;
}

export default memo(function DebouncedFilterInput({
  placeholder = "Filter on title, artist or album",
  delay = 300,
  onChange,
  onFocus,
}: DebouncedFilterInputProps) {
  const [value, setValue] = useState("");
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const timer = setTimeout(() => onChangeRef.current(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return (
    <div className="relative">
      <Search
        size={16}
        className="absolute left-3.5 top-1/2 -translate-y-1/2 text-th-text-disabled pointer-events-none"
      />
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={onFocus}
        placeholder={placeholder}
        className="w-full bg-th-surface-hover/60 text-[13px] text-th-text-primary placeholder:text-th-text-disabled rounded-md py-2 pl-9 pr-3 outline-none border border-transparent focus:border-th-border-subtle transition-colors"
      />
    </div>
  );
});
