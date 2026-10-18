import { useEffect, useState } from "react";
import { useAtom, useAtomValue, useStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import {
  autoplayAtom,
  bitPerfectAtom,
  volumeNormalizationAtom,
  gaplessAtom,
  exclusiveModeAtom,
  allowExplicitAtom,
  allowAiAtom,
  currentTrackAtom,
  queueAtom,
  manualQueueAtom,
} from "../../atoms/playback";
import { videoCoversAtom } from "../../atoms/ui";
import { resetPlaybackForContentChange } from "../../lib/playbackReset";
import Toggle from "../Toggle";
import SettingRow from "./SettingRow";
import QualityPicker from "./QualityPicker";
import ContentOffDialog from "./ContentOffDialog";

type ContentKind = "explicit" | "ai";

export default function PlaybackTab() {
  const [autoplay, setAutoplay] = useAtom(autoplayAtom);
  const [videoCovers, setVideoCovers] = useAtom(videoCoversAtom);
  const [volumeNormalization, setVolumeNormalization] = useAtom(
    volumeNormalizationAtom,
  );
  const [allowExplicit, setAllowExplicit] = useAtom(allowExplicitAtom);
  const [allowAi, setAllowAi] = useAtom(allowAiAtom);
  const [gapless, setGapless] = useAtom(gaplessAtom);
  const bitPerfect = useAtomValue(bitPerfectAtom);
  const exclusiveMode = useAtomValue(exclusiveModeAtom);
  const [gaplessSupported, setGaplessSupported] = useState(false);
  const store = useStore();

  useEffect(() => {
    invoke<boolean>("get_gapless_supported")
      .then(setGaplessSupported)
      .catch(() => {});
  }, []);

  const gaplessDisabled = !gaplessSupported || exclusiveMode || bitPerfect;

  const [pendingOff, setPendingOff] = useState<ContentKind | null>(null);

  const hasPlayback = () =>
    !!store.get(currentTrackAtom) ||
    store.get(queueAtom).length > 0 ||
    store.get(manualQueueAtom).length > 0;

  const applyOff = (which: ContentKind) => {
    if (which === "explicit") setAllowExplicit(false);
    else setAllowAi(false);
    resetPlaybackForContentChange(store);
    setPendingOff(null);
  };

  const onContentToggle = (which: ContentKind, current: boolean) => {
    if (!current) {
      if (which === "explicit") setAllowExplicit(true);
      else setAllowAi(true);
      return;
    }
    if (hasPlayback()) setPendingOff(which);
    else applyOff(which);
  };

  return (
    <div>
      <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mb-2.5">
        Audio quality
      </p>
      <QualityPicker />
      <p className="text-[11px] text-th-text-muted mt-2.5">
        Caps the quality requested from Tidal. Playback steps down automatically
        when a track isn't available at this tier.
      </p>

      <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mt-6 mb-1">
        Playback
      </p>
      <div
        className="rounded-[14px] bg-th-surface border border-th-border-subtle overflow-hidden divide-y divide-th-border-subtle"
        style={{ boxShadow: "inset 0 2px 8px rgba(0,0,0,.32)" }}
      >
        <SettingRow
          title="Autoplay"
          subtitle="Play similar tracks when the queue ends"
        >
          <button onClick={() => setAutoplay(!autoplay)}>
            <Toggle on={autoplay} />
          </button>
        </SettingRow>

        <SettingRow
          title={
            <span className="flex items-center gap-2">
              Gapless playback
              <span className="text-[10px] font-bold text-th-accent bg-th-accent/12 border border-th-accent/35 rounded-full px-2 py-px">
                Normal mode
              </span>
            </span>
          }
          subtitle="Seamless transitions between continuous tracks"
          disabled={gaplessDisabled}
          tooltip={
            !gaplessDisabled
              ? undefined
              : !gaplessSupported
                ? "Requires GStreamer 1.24 or newer"
                : "Available in normal mode only"
          }
        >
          <button
            disabled={gaplessDisabled}
            className="disabled:cursor-not-allowed"
            onClick={async () => {
              const next = !gapless;
              setGapless(next);
              await invoke("set_gapless", { enabled: next }).catch(() => {});
            }}
          >
            <Toggle
              on={gapless && gaplessSupported && !exclusiveMode && !bitPerfect}
            />
          </button>
        </SettingRow>

        <SettingRow
          title="Normalize volume"
          subtitle={
            bitPerfect
              ? "Disabled while bit-perfect output is on"
              : "Even out volume differences between tracks"
          }
          disabled={bitPerfect}
          tooltip={bitPerfect ? "Disabled in bit-perfect mode" : undefined}
        >
          <button
            disabled={bitPerfect}
            className="disabled:cursor-not-allowed"
            onClick={() => {
              if (bitPerfect) return;
              const next = !volumeNormalization;
              setVolumeNormalization(next);
              invoke("set_volume_normalization", { enabled: next }).catch(
                () => {},
              );
            }}
          >
            <Toggle on={volumeNormalization} />
          </button>
        </SettingRow>

        <SettingRow
          title="Animated album covers"
          subtitle="Play motion covers in the player when available"
        >
          <button onClick={() => setVideoCovers(!videoCovers)}>
            <Toggle on={videoCovers} />
          </button>
        </SettingRow>

        <SettingRow
          title="Allow explicit content"
          subtitle="Allow playing tracks marked as explicit"
        >
          <button onClick={() => onContentToggle("explicit", allowExplicit)}>
            <Toggle on={allowExplicit} />
          </button>
        </SettingRow>

        <SettingRow
          title="Allow AI content"
          subtitle="Allow playing tracks labeled as AI-generated"
        >
          <button onClick={() => onContentToggle("ai", allowAi)}>
            <Toggle on={allowAi} />
          </button>
        </SettingRow>
      </div>

      {pendingOff && (
        <ContentOffDialog
          label={pendingOff === "ai" ? "AI" : "explicit"}
          onCancel={() => setPendingOff(null)}
          onConfirm={() => applyOff(pendingOff)}
        />
      )}
    </div>
  );
}
