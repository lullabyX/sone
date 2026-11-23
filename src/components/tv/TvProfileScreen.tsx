import { useCallback } from "react";
import { useAtomValue } from "jotai";
import { getProfile } from "../../api/tidal";
import { authTokensAtom } from "../../atoms/auth";
import { pickProfileAvatarHref } from "../ProfilePage";
import { useTvInitialFocus } from "./TvNavContext";
import { TvError, TvHeader, TvRow, TvSpinner } from "./TvParts";
import { useTvLoader } from "./useTvLoader";

/** The signed-in user's profile. Editing, sharing and social links stay on
 *  the desktop: they need a keyboard, an upload, the clipboard or a browser. */
export default function TvProfileScreen() {
  const userId = useAtomValue(authTokensAtom)?.user_id;
  if (userId == null) {
    return (
      <p className="px-[3rem] pt-[2.5rem] text-[1rem] text-th-text-secondary">
        Not signed in
      </p>
    );
  }
  return <ProfileBody userId={userId} />;
}

function ProfileBody({ userId }: { userId: number }) {
  const { data, error, retry } = useTvLoader(
    useCallback(() => getProfile(userId), [userId]),
    "Couldn't load your profile",
  );

  useTvInitialFocus(data !== null || error !== null);

  if (error) return <TvError message={error} onRetry={retry} />;
  if (!data) return <TvSpinner screen />;

  const { name, handle, bio, fanCount, pictureFiles, publicPlaylists } = data;
  const fans =
    typeof fanCount === "number"
      ? `${new Intl.NumberFormat("en", {
          notation: "compact",
          maximumFractionDigits: 1,
        }).format(fanCount)} fan${fanCount === 1 ? "" : "s"}`
      : null;

  return (
    <div className="pb-[3rem]">
      <TvHeader
        round
        kicker="Profile"
        title={name}
        subtitle={[handle && "@" + handle, fans].filter(Boolean).join(" · ")}
        image={pickProfileAvatarHref(pictureFiles) ?? undefined}
      />
      {bio && (
        <p className="text-[0.9rem] text-th-text-secondary line-clamp-4 px-[3rem] mb-[1.5rem]">
          {bio}
        </p>
      )}
      <TvRow
        title="Public playlists"
        entries={publicPlaylists.map((p) => ({
          key: p.id,
          title: p.title,
          subtitle: p.numberOfTracks ? `${p.numberOfTracks} tracks` : "",
          image: p.coverUrl ?? "",
          action: {
            kind: "open",
            view: {
              type: "playlist",
              uuid: p.id,
              title: p.title,
              image: p.coverUrl,
            },
          },
        }))}
      />
    </div>
  );
}
