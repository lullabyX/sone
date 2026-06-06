import { Compass } from "lucide-react";
import { useNavigation } from "../hooks/useNavigation";

export default function NotFoundPage() {
  const { navigateHome } = useNavigation();

  return (
    <div className="h-full bg-linear-to-b from-th-surface to-th-base flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-center px-8">
        <Compass size={48} className="text-th-text-disabled" />
        <p className="text-th-text-primary font-semibold text-lg">
          Page not found
        </p>
        <p className="text-th-text-muted text-sm max-w-md">
          Something went wrong. The page you're looking for doesn't exist.
        </p>
        <button
          onClick={navigateHome}
          className="mt-2 px-6 py-2 bg-th-accent text-black rounded-full text-sm font-bold hover:bg-th-accent-hover hover:scale-105 transition-[transform,background-color]"
        >
          Go home
        </button>
      </div>
    </div>
  );
}
