import { ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Profile } from "../types";
import {
  updateProfileMeta,
  updateProfileBio,
  updateProfileLinks,
} from "../api/tidal";
import { useToast } from "../contexts/ToastContext";
import { safeErrorMessage } from "../lib/errorUtils";
import { splitLinks, assembleExternalLinks } from "../lib/socialLinks";
import SocialMediaPanel from "./SocialMediaPanel";
import { pickProfileHeroImage } from "./ProfilePage";
import { fetchCachedImageUrl } from "./TidalImage";

const BIO_MAX = 5000;

interface ProfileEditModalProps {
  profile: Profile;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  onPickPicture: () => void;
  onDeletePicture: () => void;
}

export default function ProfileEditModal({
  profile,
  open,
  onClose,
  onSaved,
  onPickPicture,
  onDeletePicture,
}: ProfileEditModalProps) {
  const { showToast } = useToast();
  const panelRef = useRef<HTMLDivElement>(null);

  const initial = splitLinks(profile.externalLinks);
  const [name, setName] = useState(profile.name);
  const [handle, setHandle] = useState(profile.handle ?? "");
  const [website, setWebsite] = useState(initial.website);
  const [bio, setBio] = useState(profile.bio ?? "");
  const [socials, setSocials] = useState<Record<string, string>>(
    initial.socials,
  );
  const [showSocial, setShowSocial] = useState(false);
  const [saving, setSaving] = useState(false);
  const [avatar, setAvatar] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const src = pickProfileHeroImage(profile.pictureFiles);
    if (!src) {
      setAvatar(null);
      return;
    }
    let cancelled = false;
    fetchCachedImageUrl(src)
      .then((b) => {
        if (!cancelled) setAvatar(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, profile.pictureFiles]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const artistId = profile.artistId;
  const canSave = artistId != null && !saving;

  const handleSave = async () => {
    if (artistId == null) return;
    setSaving(true);
    try {
      const nextName = name.trim();
      const nextHandle = handle.trim();
      const nameChanged = nextName !== profile.name;
      const handleChanged = nextHandle !== (profile.handle ?? "");
      if (nameChanged || handleChanged) {
        await updateProfileMeta(
          artistId,
          nameChanged ? nextName : null,
          handleChanged ? nextHandle : null,
          true,
        );
        await updateProfileMeta(
          artistId,
          nameChanged ? nextName : null,
          handleChanged ? nextHandle : null,
          false,
        );
      }
      if (profile.bioId && bio !== (profile.bio ?? "")) {
        await updateProfileBio(profile.bioId, bio);
      }
      await updateProfileLinks(
        artistId,
        assembleExternalLinks(website, socials),
      );
      showToast("Profile updated");
      onSaved();
      onClose();
    } catch (err) {
      showToast(safeErrorMessage(err, "Failed to save profile"), "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      {showSocial ? (
        <SocialMediaPanel
          socials={socials}
          onChange={setSocials}
          onBack={() => setShowSocial(false)}
          onClose={onClose}
        />
      ) : (
        <div
          ref={panelRef}
          className="w-[460px] max-w-[92vw] bg-th-elevated rounded-2xl shadow-2xl flex flex-col overflow-hidden max-h-[86vh]"
        >
          <div className="flex items-center justify-between px-5 py-3 border-b border-th-border-subtle">
            <h2 className="text-[16px] font-bold text-th-text-primary">
              Edit profile
            </h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-th-inset text-th-text-muted hover:text-th-text-primary transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          <div className="px-5 py-4 overflow-y-auto scrollbar-thin scrollbar-thumb-th-button scrollbar-track-transparent flex flex-col gap-4">
            <p className="text-[12px] text-th-text-muted">
              Information you add to your profile will be visible to everyone on
              and off TIDAL.
            </p>

            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-th-inset overflow-hidden shrink-0">
                {avatar && (
                  <img
                    src={avatar}
                    alt=""
                    className="w-full h-full object-cover"
                    draggable={false}
                  />
                )}
              </div>
              <div className="text-[13px]">
                <p className="font-semibold text-th-text-primary">
                  Profile picture
                </p>
                <p className="mt-0.5 flex items-center gap-2">
                  <button
                    onClick={onPickPicture}
                    className="text-th-accent hover:underline"
                  >
                    Choose profile picture
                  </button>
                  <span className="text-th-text-faint">·</span>
                  <button
                    onClick={onDeletePicture}
                    className="text-red-400 hover:underline"
                  >
                    Delete
                  </button>
                </p>
              </div>
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold text-th-text-secondary">
                Name
              </span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="bg-th-inset rounded-md px-3 py-2 text-[14px] text-th-text-primary outline-none focus:ring-1 focus:ring-th-accent"
              />
            </label>

            <div className="flex flex-col gap-1">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold text-th-text-secondary">
                  Username
                </span>
                <input
                  type="text"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  className="bg-th-inset rounded-md px-3 py-2 text-[14px] text-th-text-primary outline-none focus:ring-1 focus:ring-th-accent"
                />
              </label>
              <p className="text-[11px] text-th-text-faint">
                Use only the letters a-z, numbers 0-9 and underscores.
              </p>
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold text-th-text-secondary">
                Link
              </span>
              <input
                type="text"
                placeholder="Link"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                className="bg-th-inset rounded-md px-3 py-2 text-[14px] text-th-text-primary placeholder:text-th-text-faint outline-none focus:ring-1 focus:ring-th-accent"
              />
            </label>

            <div className="flex flex-col gap-1">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold text-th-text-secondary">
                  Bio
                </span>
                <textarea
                  placeholder="Bio"
                  value={bio}
                  disabled={!profile.bioId}
                  maxLength={BIO_MAX}
                  onChange={(e) => setBio(e.target.value)}
                  rows={4}
                  className="bg-th-inset rounded-md px-3 py-2 text-[14px] text-th-text-primary placeholder:text-th-text-faint outline-none focus:ring-1 focus:ring-th-accent resize-y disabled:opacity-50"
                />
              </label>
              {profile.bioId ? (
                <p className="text-[11px] text-th-text-faint">
                  {BIO_MAX - bio.length} characters remaining
                </p>
              ) : (
                <p className="text-[11px] text-th-text-faint">
                  Bio editing is unavailable for this profile.
                </p>
              )}
            </div>

            <button
              onClick={() => setShowSocial(true)}
              className="flex items-center justify-between bg-th-inset rounded-md px-3 py-3 text-[14px] text-th-text-primary hover:bg-th-button transition-colors"
            >
              <span>Social media</span>
              <ChevronRight size={18} className="text-th-text-muted" />
            </button>
          </div>

          <div className="px-5 py-3 border-t border-th-border-subtle flex justify-end">
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="px-6 py-2 bg-th-text-primary text-th-base rounded-full text-sm font-bold hover:scale-105 transition-transform disabled:opacity-40 disabled:hover:scale-100"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
