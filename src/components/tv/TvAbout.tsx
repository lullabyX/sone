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
      <TvSettingsRow
        title="SONE"
        value={
          version ? (
            <span className="text-[0.8rem] text-th-text-muted">{version}</span>
          ) : undefined
        }
      />
      {info?.available && (
        <>
          <TvSettingsRow
            title={`Update available: SONE v${info.latest}`}
            subtitle="Update through your package manager, or scan the code for the release page"
          />
          <div className="px-[1rem]">
            <TvQrCode
              value={info.url}
              label="Release page"
              className="w-[9rem] h-[9rem]"
            />
          </div>
        </>
      )}
    </TvSettingsSection>
  );
}
