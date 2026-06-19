import { useState, useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import Toggle from "../Toggle";
import SettingRow from "./SettingRow";
import { currentTrackAtom, streamInfoAtom } from "../../atoms/playback";
import { userNameAtom } from "../../atoms/auth";
import { getTrackDisplayTitle, getTidalImageUrl } from "../../types";
import {
  getTrackArtistDiscordDisplay,
  formatStreamQuality,
} from "../../utils/itemHelpers";

const TAGS = ["{track}", "{artist}", "{album}"] as const;

export default function DiscordTab() {
  const [discordRpc, setDiscordRpc] = useState(false);
  const [discordStatusText, setDiscordStatusText] = useState("");
  const discordStatusSaveTimer = useRef<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  const currentTrack = useAtomValue(currentTrackAtom);
  const streamInfo = useAtomValue(streamInfoAtom);
  const userName = useAtomValue(userNameAtom);

  useEffect(() => {
    invoke<boolean>("get_discord_rpc")
      .then(setDiscordRpc)
      .catch(() => {});
    invoke<string>("get_discord_status_text")
      .then(setDiscordStatusText)
      .catch(() => {});
    return () => {
      clearTimeout(discordStatusSaveTimer.current);
    };
  }, []);

  const saveStatusText = (text: string) => {
    clearTimeout(discordStatusSaveTimer.current);
    discordStatusSaveTimer.current = window.setTimeout(() => {
      invoke("set_discord_status_text", { text }).catch(() => {});
    }, 500);
  };

  const updateDiscordStatusText = (text: string) => {
    setDiscordStatusText(text);
    saveStatusText(text);
  };

  const insertTag = (tag: string) => {
    const el = inputRef.current;
    const v = discordStatusText;
    const s = el?.selectionStart ?? v.length;
    const next = v.slice(0, s) + tag + v.slice(s);
    setDiscordStatusText(next);
    saveStatusText(next);
    requestAnimationFrame(() => {
      if (!el) return;
      const caret = s + tag.length;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  // Sample fields: live track if playing, else the static showcase track.
  const title = currentTrack
    ? getTrackDisplayTitle(currentTrack)
    : "High Hopes";
  const artist = currentTrack
    ? getTrackArtistDiscordDisplay(currentTrack)
    : "Pink Floyd";
  const album = currentTrack
    ? currentTrack.album?.title || ""
    : "The Division Bell";
  // Show the real stream format (e.g. "24-BIT 192KHZ FLAC"); fall back to the
  // Hi-Res default when the stream reports no bit/rate/codec info.
  const quality = formatStreamQuality(streamInfo) || "24-BIT 192KHZ FLAC";
  const coverUrl = currentTrack
    ? getTidalImageUrl(currentTrack.album?.cover, 320)
    : "";

  const rendered =
    (discordStatusText || "")
      .split("{track}")
      .join(title)
      .split("{artist}")
      .join(artist)
      .split("{album}")
      .join(album)
      .trim() || "TIDAL via SONE";

  return (
    <div>
      <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mb-1">
        Discord
      </p>
      <SettingRow
        title="Discord Rich Presence"
        subtitle="Show what you're listening to on Discord"
      >
        <button
          onClick={() => {
            const next = !discordRpc;
            setDiscordRpc(next);
            invoke("set_discord_rpc", { enabled: next }).catch(() => {
              setDiscordRpc(!next);
            });
          }}
        >
          <Toggle on={discordRpc} />
        </button>
      </SettingRow>

      {discordRpc && (
        <div className="px-4 pb-3 pt-3.5 border-t border-th-border-subtle space-y-1.5">
          <label className="block text-[11px] text-th-text-muted">
            Status text
          </label>
          <input
            ref={inputRef}
            type="text"
            value={discordStatusText}
            onChange={(e) => updateDiscordStatusText(e.target.value)}
            placeholder="{track} by {artist} on {album}"
            className="w-full px-2.5 py-1.5 rounded-md bg-th-inset border border-th-border-subtle text-[12px] text-th-text-primary placeholder:text-th-text-disabled focus:border-th-accent/50 focus:outline-none"
          />

          <div className="flex flex-wrap items-center gap-[7px] pt-1.5">
            <span className="text-[11px] text-th-text-muted">
              Customize with tags:
            </span>
            {TAGS.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => insertTag(tag)}
                className="font-mono text-[11px] font-semibold text-th-accent rounded-[7px] px-2 py-[3px] border border-th-accent/30 bg-th-accent/10 hover:bg-th-accent/20 active:scale-[0.94] transition-[background,transform]"
              >
                {tag}
              </button>
            ))}
          </div>

          {/* In a server — member-list status row */}
          <p className="text-[10px] font-bold tracking-[1px] uppercase text-th-text-faint pt-4 pb-2">
            In a server
          </p>
          <div className="flex items-center gap-[11px] bg-th-inset border border-th-border-subtle rounded-[11px] px-[13px] py-2.5">
            <div className="relative w-10 h-10 rounded-full flex-shrink-0 bg-gradient-to-br from-th-accent to-th-accent/40">
              <span className="absolute -left-px -bottom-px w-3.5 h-3.5 rounded-full bg-[#f23f43] border-[3px] border-th-inset" />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-bold text-th-text-primary">
                {userName}
              </div>
              <div className="flex items-center gap-1.5 text-[12px] text-th-text-muted mt-px min-w-0">
                <span className="text-[#1ed760] flex-shrink-0 flex">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-[13px] h-[13px]"
                  >
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </svg>
                </span>
                <span className="truncate">{rendered}</span>
              </div>
            </div>
          </div>

          {/* On your profile — presence card */}
          <p className="text-[10px] font-bold tracking-[1px] uppercase text-th-text-faint pt-4 pb-2">
            On your profile
          </p>
          <div className="bg-th-inset border border-th-border-subtle rounded-xl px-[15px] py-3.5">
            <div className="flex items-start justify-between text-[13px] leading-[1.35] text-th-text-secondary mb-3">
              <span>
                Listening to{" "}
                <span className="font-bold text-th-text-primary">
                  {rendered}
                </span>
              </span>
              <span className="text-th-text-faint font-extrabold tracking-[1px] flex-shrink-0 pl-3">
                •••
              </span>
            </div>
            <div className="flex gap-3">
              {coverUrl ? (
                <img
                  src={coverUrl}
                  alt=""
                  className="w-[60px] h-[60px] rounded-lg flex-shrink-0 object-cover ring-1 ring-inset ring-white/10"
                />
              ) : (
                <div className="w-[60px] h-[60px] rounded-lg flex-shrink-0 bg-gradient-to-br from-th-accent to-th-accent/30 ring-1 ring-inset ring-white/10" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-bold text-th-text-primary truncate">
                  {title}
                </div>
                <div className="text-[12px] text-th-text-secondary mt-0.5 truncate">
                  by {artist}
                  {album ? ` on ${album}` : ""}
                </div>
                <div className="text-[11px] text-th-text-muted mt-0.5 truncate">
                  {quality}
                </div>
                <div className="flex items-center gap-[9px] mt-2">
                  <span className="text-[10px] text-th-text-muted tabular-nums">
                    00:19
                  </span>
                  <div className="flex-1 h-1 rounded-sm bg-white/[0.13] relative">
                    <i className="absolute left-0 top-0 bottom-0 w-[5%] bg-th-accent rounded-sm after:content-[''] after:absolute after:-right-[3px] after:top-1/2 after:-translate-y-1/2 after:w-2 after:h-2 after:rounded-full after:bg-th-accent" />
                  </div>
                  <span className="text-[10px] text-th-text-muted tabular-nums">
                    08:31
                  </span>
                </div>
              </div>
            </div>
            <div
              className="mt-3 w-full py-2 border border-th-border-subtle rounded-lg text-center text-th-text-secondary text-[12px] font-semibold select-none"
              aria-hidden="true"
            >
              Listen on TIDAL
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
