import { ChevronLeft, ChevronRight } from "lucide-react";
import { useNavigation } from "../hooks/useNavigation";
import UserMenu from "./UserMenu";
import SearchBar from "./SearchBar";

export default function Header() {
  const { currentView } = useNavigation();

  const getHeaderTitle = () => {
    if (currentView.type === "search") {
      return `Results for "${currentView.query}"`;
    }
    return "";
  };

  return (
    <div className="h-16 flex items-center justify-between px-6 bg-th-base z-30 shrink-0 sticky top-0">
      <div className="flex items-center gap-4 flex-1 min-w-0">
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => window.history.back()}
            className="w-8 h-8 rounded-full bg-black/40 flex items-center justify-center text-th-text-muted hover:text-th-text-primary transition-colors disabled:opacity-50"
          >
            <ChevronLeft size={20} />
          </button>
          <button
            onClick={() => window.history.forward()}
            className="w-8 h-8 rounded-full bg-black/40 flex items-center justify-center text-th-text-muted hover:text-th-text-primary transition-colors disabled:opacity-50"
          >
            <ChevronRight size={20} />
          </button>
        </div>

        {/* Dynamic Title */}
        <h1 className="text-[18px] font-bold text-th-text-primary truncate ml-2">
          {getHeaderTitle()}
        </h1>
      </div>

      <div className="flex items-center gap-4">
        {/* Search Input */}
        <SearchBar />

        <UserMenu />
      </div>
    </div>
  );
}
