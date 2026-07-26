import { useAtomValue, useSetAtom } from "jotai";
import { isAuthenticatedAtom, localOnlyAtom } from "../atoms/auth";
import { Headphones } from "lucide-react";
import { useNavigation } from "../hooks/useNavigation";

export default function TidalSignInBanner() {
  const isAuthenticated = useAtomValue(isAuthenticatedAtom);
  const localOnly = useAtomValue(localOnlyAtom);
  const setLocalOnly = useSetAtom(localOnlyAtom);
  const { navigateHome } = useNavigation();

  if (isAuthenticated || !localOnly) return null;

  return (
    <div className="mx-4 mt-4 flex items-center gap-3 rounded-lg border border-th-accent/20 bg-th-accent/5 px-4 py-3">
      <Headphones size={20} className="text-th-accent shrink-0" />
      <p className="flex-1 text-sm text-th-text-secondary">
        Sign in to TIDAL to access your streaming library, playlists, and
        favorites.
      </p>
      <button
        onClick={() => {
          setLocalOnly(false);
          navigateHome();
        }}
        className="shrink-0 rounded-full bg-th-accent px-4 py-1.5 text-xs font-semibold text-th-accent-text transition hover:brightness-110"
      >
        Sign in
      </button>
    </div>
  );
}
