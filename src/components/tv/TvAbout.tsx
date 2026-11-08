import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { getVersion } from "@tauri-apps/api/app";
import { Bug, Globe } from "lucide-react";
import { updateInfoAtom } from "../../atoms/updates";
import { NEW_ISSUE_URL, REPO_URL } from "../../lib/projectLinks";
import { linkMenu } from "./tvMenu";
import { useTvNav } from "./TvNavContext";
import { TvQrCode } from "./TvQrCode";
import { TvSettingsRow, TvSettingsSection } from "./TvSettingsParts";

export function TvAboutSection() {
  const nav = useTvNav();
  const info = useAtomValue(updateInfoAtom);
  const [version, setVersion] = useState<string | null>(null);
  // A TV can't open a browser: the links are QR codes for a phone.
  const openAbout = () =>
    nav.openMenu({
      title: "About SONE",
      subtitle: version ? `Version ${version}` : undefined,
      items: [
        {
          label: "Project page",
          icon: Globe,
          submenu: () => linkMenu(REPO_URL, "Project page"),
        },
        {
          label: "Report a problem",
          icon: Bug,
          submenu: () => linkMenu(NEW_ISSUE_URL, "Report a problem"),
        },
      ],
    });

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  return (
    <TvSettingsSection title="About">
      <TvSettingsRow
        title="SONE"
        subtitle="Project page and reporting a problem"
        value={
          version ? (
            <span className="text-[0.8rem] text-th-text-muted">{version}</span>
          ) : undefined
        }
        onSelect={openAbout}
      />
      {/* The update lines do nothing when selected; they take focus only so
          the remote can scroll the section into view. */}
      {info?.available && (
        <>
          <TvSettingsRow
            title={`Update available: SONE v${info.latest}`}
            subtitle="Update through your package manager, or scan the code for the release page"
            onSelect={() => {}}
          />
          <div className="px-[1rem]">
            <div
              data-tv-focusable
              tabIndex={0}
              role="group"
              aria-label="Release page QR code"
              className="tv-track inline-block rounded-[1.4rem] p-[0.3rem]"
            >
              <TvQrCode
                value={info.url}
                label="Release page"
                className="w-[9rem] h-[9rem]"
              />
            </div>
          </div>
        </>
      )}
    </TvSettingsSection>
  );
}
