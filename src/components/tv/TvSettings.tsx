import { useEffect, useState, type ReactNode } from "react";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { Check, LogOut, SlidersHorizontal, X } from "lucide-react";
import {
  allowAiAtom,
  allowExplicitAtom,
  autoplayAtom,
  bitPerfectAtom,
  currentTrackAtom,
  exclusiveDeviceAtom,
  exclusiveModeAtom,
  gaplessAtom,
  manualQueueAtom,
  maxQualityAtom,
  queueAtom,
  volumeNormalizationAtom,
} from "../../atoms/playback";
import { themeAtom } from "../../atoms/theme";
import { tvLyricsAtom, tvModeAtom } from "../../atoms/tv";
import { useToast } from "../../contexts/ToastContext";
import { usePlaybackActions } from "../../hooks/usePlaybackActions";
import { useAuth } from "../../hooks/useAuth";
import { resetPlaybackForContentChange } from "../../lib/playbackReset";
import { PRESET_THEMES } from "../../lib/theme";
import { useTvInitialFocus, useTvNav } from "./TvNavContext";

const QUALITY_TIERS = [
  { id: "HIGH", label: "High", spec: "AAC · up to 320 kbps" },
  { id: "LOSSLESS", label: "Lossless", spec: "FLAC · 16-bit / 44.1 kHz" },
  {
    id: "HI_RES_LOSSLESS",
    label: "Hi-Res Lossless",
    spec: "FLAC · up to 24-bit / 192 kHz",
  },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-[2rem]">
      <h2 className="text-[0.7rem] font-bold uppercase tracking-[0.15em] text-th-text-muted px-[1rem] mb-[0.5rem]">
        {title}
      </h2>
      <div className="flex flex-col gap-[0.2rem]">{children}</div>
    </section>
  );
}

function Switch({ on }: { on: boolean }) {
  return (
    <span
      className={`relative inline-flex w-[2.4rem] h-[1.3rem] shrink-0 rounded-full transition-colors ${
        on ? "bg-th-accent" : "bg-th-border-subtle"
      }`}
    >
      <span
        className={`absolute top-[0.15rem] w-[1rem] h-[1rem] rounded-full bg-th-text-primary transition-transform ${
          on ? "translate-x-[1.25rem]" : "translate-x-[0.15rem]"
        }`}
      />
    </span>
  );
}

/** One settings line: a focusable row with a switch, a check or a value. */
function Row({
  title,
  subtitle,
  toggle,
  checked,
  value,
  disabled,
  autoFocus,
  onSelect,
}: {
  title: string;
  subtitle?: string;
  toggle?: boolean;
  checked?: boolean;
  value?: ReactNode;
  disabled?: boolean;
  autoFocus?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      data-tv-focusable
      data-tv-autofocus={autoFocus || undefined}
      disabled={disabled}
      onClick={onSelect}
      className={`tv-track flex items-center gap-[1rem] w-full px-[1rem] py-[0.75rem] rounded-[0.6rem] text-left ${
        disabled ? "opacity-40" : ""
      }`}
    >
      <span className="flex-1 min-w-0">
        <span
          className={`block text-[0.85rem] font-semibold ${
            checked ? "text-th-accent" : "text-th-text-primary"
          }`}
        >
          {title}
        </span>
        {subtitle && (
          <span className="block text-[0.65rem] text-th-text-muted mt-[0.1rem]">
            {subtitle}
          </span>
        )}
      </span>
      {value}
      {toggle !== undefined && <Switch on={toggle} />}
      {checked && <Check className="w-[1.1rem] h-[1.1rem] text-th-accent" />}
    </button>
  );
}

/**
 * Settings that matter on a TV, driven by the remote: audio quality and
 * output, playback behaviour, theme and TV options. Everything else (account
 * services, network, window chrome) sits behind "More settings", which opens
 * the desktop settings sheet.
 */
export default function TvSettings() {
  const nav = useTvNav();
  const store = useStore();
  const { showToast } = useToast();
  const { setBitPerfect } = usePlaybackActions();
  const [maxQuality, setMaxQuality] = useAtom(maxQualityAtom);
  const [autoplay, setAutoplay] = useAtom(autoplayAtom);
  const [gapless, setGapless] = useAtom(gaplessAtom);
  const [normalize, setNormalize] = useAtom(volumeNormalizationAtom);
  const [allowExplicit, setAllowExplicit] = useAtom(allowExplicitAtom);
  const [allowAi, setAllowAi] = useAtom(allowAiAtom);
  const [exclusive, setExclusive] = useAtom(exclusiveModeAtom);
  const [device, setDevice] = useAtom(exclusiveDeviceAtom);
  const bitPerfect = useAtomValue(bitPerfectAtom);
  const [theme, setTheme] = useAtom(themeAtom);
  const [lyricsOn, setLyricsOn] = useAtom(tvLyricsAtom);
  const setTvMode = useSetAtom(tvModeAtom);
  const { userName, logout } = useAuth();
  const [gaplessSupported, setGaplessSupported] = useState(false);
  const [devices, setDevices] = useState<{ id: string; name: string }[]>([]);

  useTvInitialFocus(true);

  useEffect(() => {
    invoke<boolean>("get_gapless_supported")
      .then(setGaplessSupported)
      .catch(() => {});
  }, []);

  // Same as the desktop user menu: list devices while exclusive output is
  // on, and pick the first one when none is chosen yet.
  useEffect(() => {
    if (!exclusive) return;
    invoke<{ id: string; name: string }[]>("list_audio_devices")
      .then((list) => {
        setDevices(list);
        if (!store.get(exclusiveDeviceAtom) && list.length > 0) {
          setDevice(list[0].id);
          invoke("set_exclusive_device", { device: list[0].id }).catch(
            () => {},
          );
        }
      })
      .catch(() => {});
  }, [exclusive, store, setDevice]);

  const gaplessDisabled = !gaplessSupported || exclusive || bitPerfect;

  // As on the desktop: turning a content type off clears the queue, so it is
  // confirmed first when something is playing or queued.
  const applyContentOff = (which: "explicit" | "ai") => {
    if (which === "explicit") setAllowExplicit(false);
    else setAllowAi(false);
    resetPlaybackForContentChange(store);
  };
  const onContentToggle = (which: "explicit" | "ai", on: boolean) => {
    if (!on) {
      if (which === "explicit") setAllowExplicit(true);
      else setAllowAi(true);
      return;
    }
    const hasPlayback =
      !!store.get(currentTrackAtom) ||
      store.get(queueAtom).length > 0 ||
      store.get(manualQueueAtom).length > 0;
    if (!hasPlayback) {
      applyContentOff(which);
      return;
    }
    const label = which === "ai" ? "AI" : "explicit";
    nav.openMenu({
      title: `Turn off ${label} content?`,
      subtitle: "Turning this off clears your current queue.",
      items: [
        { label: "Yes, turn off", onSelect: () => applyContentOff(which) },
        { label: "Not now", icon: X, onSelect: () => {} },
      ],
    });
  };

  return (
    <div className="max-w-[44rem] px-[2rem] pt-[2.5rem] pb-[3rem]">
      <h1 className="text-[2rem] font-extrabold text-th-text-primary px-[1rem] mb-[1.5rem]">
        Settings
      </h1>

      <Section title="Audio quality">
        {QUALITY_TIERS.map((t, i) => (
          <Row
            key={t.id}
            title={t.label}
            subtitle={t.spec}
            checked={maxQuality === t.id}
            autoFocus={i === 0}
            onSelect={() => {
              setMaxQuality(t.id);
              invoke("set_max_quality", { quality: t.id }).catch(() => {});
            }}
          />
        ))}
      </Section>

      <Section title="Output">
        <Row
          title="Exclusive output"
          subtitle="Send audio straight to the device, bypassing the system mixer"
          toggle={exclusive}
          onSelect={() => {
            const next = !exclusive;
            setExclusive(next);
            if (!next && bitPerfect) setBitPerfect(false);
            invoke("set_exclusive_mode", { enabled: next }).catch(() => {});
            showToast(
              next
                ? "Exclusive output on — takes effect next track"
                : "Exclusive output off — takes effect next track",
            );
          }}
        />
        {exclusive &&
          devices.map((d) => (
            <Row
              key={d.id}
              title={d.name}
              subtitle="Output device"
              checked={device === d.id}
              onSelect={() => {
                setDevice(d.id);
                invoke("set_exclusive_device", { device: d.id }).catch(
                  () => {},
                );
              }}
            />
          ))}
        {exclusive && (
          <Row
            title="Bit-perfect"
            subtitle="The DAC gets the source unaltered. Volume and normalization switch at once; the output path changes with the next track"
            toggle={bitPerfect}
            onSelect={() => {
              const next = !bitPerfect;
              setBitPerfect(next);
              showToast(
                next
                  ? "Bit-perfect on — volume set to 100% now, output path changes with the next track"
                  : "Bit-perfect off — your volume is back now, output path changes with the next track",
              );
            }}
          />
        )}
      </Section>

      <Section title="Playback">
        <Row
          title="Autoplay"
          subtitle="Play similar tracks when the queue ends"
          toggle={autoplay}
          onSelect={() => setAutoplay(!autoplay)}
        />
        <Row
          title="Gapless playback"
          subtitle={
            !gaplessSupported
              ? "Requires GStreamer 1.24 or newer"
              : exclusive || bitPerfect
                ? "Available in normal output mode only"
                : "Seamless transitions between continuous tracks"
          }
          toggle={gapless && !gaplessDisabled}
          disabled={gaplessDisabled}
          onSelect={() => {
            const next = !gapless;
            setGapless(next);
            invoke("set_gapless", { enabled: next }).catch(() => {});
          }}
        />
        <Row
          title="Normalize volume"
          subtitle={
            bitPerfect
              ? "Disabled while bit-perfect output is on"
              : "Even out volume differences between tracks"
          }
          toggle={normalize}
          disabled={bitPerfect}
          onSelect={() => {
            const next = !normalize;
            setNormalize(next);
            invoke("set_volume_normalization", { enabled: next }).catch(
              () => {},
            );
          }}
        />
        <Row
          title="Allow explicit content"
          subtitle="Allow playing tracks marked as explicit"
          toggle={allowExplicit}
          onSelect={() => onContentToggle("explicit", allowExplicit)}
        />
        <Row
          title="Allow AI content"
          subtitle="Allow playing tracks labeled as AI-generated"
          toggle={allowAi}
          onSelect={() => onContentToggle("ai", allowAi)}
        />
      </Section>

      <Section title="Theme">
        <div
          data-tv-remember
          className="grid grid-cols-5 gap-[0.8rem] px-[0.5rem] py-[0.4rem]"
        >
          {PRESET_THEMES.map((preset) => {
            const active =
              theme.accent === preset.accent && theme.bgBase === preset.bgBase;
            return (
              <button
                key={preset.name}
                data-tv-focusable
                onClick={() => setTheme(preset)}
                className="tv-card text-left"
              >
                <span
                  className="tv-card-art relative flex items-center justify-center aspect-[4/3] rounded-[0.6rem] border border-th-border-subtle"
                  style={{ background: preset.bgBase }}
                >
                  <span
                    className="w-[1.8rem] h-[1.8rem] rounded-full"
                    style={{ background: preset.accent }}
                  />
                  {active && (
                    <Check
                      className="absolute top-[0.4rem] right-[0.4rem] w-[1rem] h-[1rem]"
                      style={{ color: preset.accent }}
                    />
                  )}
                </span>
                <span
                  className={`block mt-[0.4rem] text-[0.65rem] font-semibold truncate ${
                    active ? "text-th-accent" : "text-th-text-secondary"
                  }`}
                >
                  {preset.name}
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="TV mode">
        <Row
          title="Show lyrics in Now Playing"
          subtitle="When a track has lyrics, show them instead of the cover"
          toggle={lyricsOn}
          onSelect={() => setLyricsOn(!lyricsOn)}
        />
        <Row
          title="More settings"
          subtitle="Scrobbling, Discord, network, custom colors and everything else"
          value={
            <SlidersHorizontal className="w-[1.1rem] h-[1.1rem] text-th-text-muted" />
          }
          onSelect={nav.openMoreSettings}
        />
        <Row
          title="Exit TV mode"
          subtitle="Back to the desktop layout"
          value={
            <LogOut className="w-[1.1rem] h-[1.1rem] text-th-text-muted" />
          }
          onSelect={() => setTvMode(false)}
        />
      </Section>

      <Section title="Account">
        <Row
          title={userName ? `Signed in as ${userName}` : "Signed in"}
          subtitle="Log out of TIDAL on this device"
          value={
            <LogOut className="w-[1.1rem] h-[1.1rem] text-th-text-muted" />
          }
          onSelect={() =>
            nav.openMenu({
              title: "Log out?",
              subtitle: "You can sign in again right here.",
              items: [
                { label: "Log out", icon: LogOut, onSelect: () => logout() },
                { label: "Cancel", icon: X, onSelect: () => {} },
              ],
            })
          }
        />
      </Section>
    </div>
  );
}
