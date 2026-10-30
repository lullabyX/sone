import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { getVersion } from "@tauri-apps/api/app";
import { updateInfoAtom } from "../../atoms/updates";
import { TvQrCode } from "./TvQrCode";
import { TvSettingsRow, TvSettingsSection } from "./TvSettingsParts";

export function TvAboutSection() {
  const info = useAtomValue(updateInfoAtom);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  return (
    <TvSettingsSection title="About">
      {/* Rows here do nothing when selected; they take focus only so the
          remote can scroll the section into view. */}
      <TvSettingsRow
        title="SONE"
        value={
          version ? (
            <span className="text-[0.8rem] text-th-text-muted">{version}</span>
          ) : undefined
        }
        onSelect={() => {}}
      />
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
