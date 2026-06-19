import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Loader2, ExternalLink } from "lucide-react";

interface ProviderStatus {
  name: string;
  connected: boolean;
  username: string | null;
}

type AuthStep = "idle" | "waiting" | "authorized" | "submitting";

interface AudioscrobblerState {
  step: AuthStep;
  token: string;
  error: string | null;
}

interface ListenBrainzState {
  step: "idle" | "submitting";
  token: string;
  error: string | null;
}

const CONNECT_BTN =
  "px-4 py-1.5 text-[13px] font-bold rounded-full bg-th-accent text-th-on-accent hover:brightness-110 active:scale-95 transition-all duration-150 disabled:opacity-50 disabled:pointer-events-none flex items-center gap-1.5";

const ACCENT_TINT =
  "linear-gradient(90deg, color-mix(in srgb, var(--th-accent) 10%, transparent), transparent 72%)";

const LASTFM_GLYPH = (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="var(--th-accent)"
    aria-hidden="true"
  >
    <path d="M10.584 17.21l-.88-2.392s-1.43 1.594-3.573 1.594c-1.897 0-3.244-1.649-3.244-4.288 0-3.382 1.704-4.591 3.381-4.591 2.42 0 3.189 1.567 3.849 3.574l.88 2.749c.88 2.666 2.529 4.81 7.285 4.81 3.409 0 5.718-1.044 5.718-3.793 0-2.227-1.265-3.381-3.63-3.931l-1.758-.385c-1.21-.275-1.567-.77-1.567-1.595 0-.934.742-1.484 1.952-1.484 1.32 0 2.034.495 2.144 1.677l2.749-.33c-.22-2.474-1.924-3.492-4.729-3.492-2.474 0-4.893.935-4.893 3.932 0 1.87.907 3.051 3.189 3.601l1.87.44c1.402.33 1.869.907 1.869 1.704 0 1.017-.99 1.43-2.86 1.43-2.776 0-3.93-1.457-4.59-3.464l-.907-2.75c-1.155-3.573-2.997-4.893-6.653-4.893C2.144 5.333 0 7.89 0 12.233c0 4.18 2.144 6.434 5.993 6.434 3.106 0 4.591-1.457 4.591-1.457z" />
  </svg>
);

const LIBREFM_GLYPH = (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="var(--th-accent)"
    aria-hidden="true"
  >
    <rect x="2.5" y="10" width="2.6" height="4" rx="1.3" />
    <rect x="7" y="6.5" width="2.6" height="11" rx="1.3" />
    <rect x="11.5" y="3" width="2.6" height="18" rx="1.3" />
    <rect x="16" y="7.5" width="2.6" height="9" rx="1.3" />
    <rect x="20.5" y="10.5" width="2.6" height="3" rx="1.3" />
  </svg>
);

const LISTENBRAINZ_GLYPH = (
  <svg
    width="22"
    height="24"
    viewBox="0 0 243.4 276"
    preserveAspectRatio="xMidYMid meet"
    aria-hidden="true"
  >
    {/* right face — harder accent */}
    <polygon
      fill="var(--th-accent)"
      fillOpacity={0.7}
      points="126.5,0 126.5,276 243.4,208.9 243.4,67.1"
    />
    {/* left face — light accent */}
    <polygon
      fill="var(--th-accent)"
      fillOpacity={0.2}
      points="116.9,-0.1 0,66.9 0,208.8 116.9,275.8"
    />
    <path
      fill="var(--th-text-primary)"
      d="M185.8,57.9c-0.7-3.1-2.5-5.7-5.2-7.4c-1.9-1.2-4-1.8-6.3-1.8c-4.1,0-7.8,2-9.9,5.5c-2.6,4.1-2.3,9.2,0.3,13c-7,7.9-16.7,8.3-19.1,8.2c-7.1-3.1-13.9-4.1-19.2-4.4v7.7c4.7,0.3,10.6,1.3,16.8,4.1c6.6,3,12.1,7.5,16.5,13.5c-0.3,0.3-0.5,0.7-0.7,1c-3.4,5.5-1.8,12.7,3.6,16.2c1.9,1.2,4,1.8,6.3,1.8c4.1,0,7.8-2,9.9-5.5c3.5-5.5,1.8-12.7-3.7-16.2c-2.7-1.7-5.9-2.1-8.9-1.4c-2.9-4.1-6.4-7.7-10.2-10.7c4.8-1.5,10.4-4.3,14.9-9.8c1.1,0.3,2.2,0.5,3.4,0.5c4.1,0,7.8-2,9.9-5.5C185.9,64.1,186.5,61,185.8,57.9"
    />
    <path
      fill="var(--th-text-primary)"
      d="M202.5,136.5c0.8,2,2.2,3.8,4,5.1c0.1,0.1,0.3,0.2,0.5,0.4c1.9,1.2,4,1.8,6.3,1.8c4.1,0,7.8-2,9.9-5.5c1.7-2.6,2.2-5.8,1.5-8.8c-0.7-3.1-2.5-5.7-5.2-7.4c-1.9-1.2-4-1.8-6.3-1.8c-0.2,0-0.5,0-0.7,0c-1.4-6.1-1.8-14.9,0.1-21.6c0.2,0,0.4,0,0.6,0c4.1,0,7.8-2,9.9-5.5c1.7-2.6,2.2-5.8,1.5-8.8c-0.7-3.1-2.5-5.7-5.2-7.4c-1.9-1.2-4-1.8-6.3-1.8c-4.1,0-7.8,2-9.9,5.5c-3.1,4.9-2.1,11.1,2,14.9c-2.6,8.7-2.2,19.8-0.1,27.6c-0.3,0.3-0.6,0.5-0.8,0.8c-0.4,0.5-0.9,1-1.2,1.6c-0.6,1-1.1,2-1.4,3c-6.5,0.9-10,3.2-13.1,5.2c-3.9,2.5-7.6,4.9-18.5,5.1c-3.8-0.4-6.8-0.3-10.1-0.2c-2.7,0.1-5.6,0.2-9.3,0c-2.6-0.1-4-1.7-6.6-4.6c-3.5-3.9-8.1-8.9-18-9.6v7.7c6.3,0.6,9.2,3.6,12.2,7c2.8,3.2,6.1,6.9,12,7.3c4.1,0.2,7.2,0.1,10,0c4.8-0.2,8.5-0.3,15.1,1.3c5,1.2,23.2,18.5,28.3,27.4c-0.2,0.3-0.4,0.5-0.6,0.8c-3.3,5.3-2,12.2,3.1,15.8c0.1,0.1,0.3,0.2,0.5,0.4c1.9,1.2,4,1.8,6.3,1.8c4.1,0,7.8-2,9.9-5.5c1.7-2.6,2.2-5.8,1.5-8.8c-0.7-3.1-2.5-5.7-5.2-7.4c-1.9-1.2-4-1.8-6.3-1.8c-1,0-2,0.1-3,0.4c-4.9-8-16.6-20-25.3-26.4c3.5-1.2,5.8-2.8,8.1-4.2C195.9,138.6,198.2,137.2,202.5,136.5"
    />
    <path
      fill="var(--th-accent)"
      d="M108.5,69.3c-19.8,0-39.9,7.2-52.4,18.7c-13.5,12.5-20.6,31.8-20.3,54.9c-3.8,0.6-6.7,3.8-6.7,7.7v35.5c0,4.3,3.5,7.8,7.8,7.8h4c0.6,0,1.2-0.1,1.8-0.2v3.1c0,4.3,3.1,7.8,6.8,7.8h3.7c3.8,0,6.8-3.5,6.8-7.8v-58.1c0-4.3-3.1-7.8-6.8-7.8h-3.7c-3.4,0-6.1,2.8-6.7,6.4c0.1-3.6,0.4-7.2,0.9-10c2.3-14.2,8.1-26,17-34.3c11.1-10.3,29.8-16.9,47.7-16.9c2,0,6.4,0.1,8.4,0.3v-6.8C114.6,69.4,110.7,69.3,108.5,69.3z M41,185.3c-2.9,0-5.2-2.3-5.2-5.2v-23.5c0-2.9,2.3-5.2,5.2-5.2h1.8v33.9H41z"
    />
  </svg>
);

export default function ScrobbleTab() {
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [queueSize, setQueueSize] = useState(0);
  const [loading, setLoading] = useState(true);

  const [lastfm, setLastfm] = useState<AudioscrobblerState>({
    step: "idle",
    token: "",
    error: null,
  });
  const [librefm, setLibrefm] = useState<AudioscrobblerState>({
    step: "idle",
    token: "",
    error: null,
  });
  const [listenbrainz, setListenBrainz] = useState<ListenBrainzState>({
    step: "idle",
    token: "",
    error: null,
  });

  const fetchStatus = async () => {
    try {
      const [providers, queue] = await Promise.all([
        invoke<ProviderStatus[]>("get_scrobble_status"),
        invoke<number>("get_scrobble_queue_size"),
      ]);
      setStatuses(providers);
      setQueueSize(queue);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  // Fetch status on mount
  useEffect(() => {
    setLoading(true);
    setLastfm({ step: "idle", token: "", error: null });
    setLibrefm({ step: "idle", token: "", error: null });
    setListenBrainz({ step: "idle", token: "", error: null });
    fetchStatus();
  }, []);

  const getStatus = (name: string): ProviderStatus | undefined =>
    statuses.find((s) => s.name === name);

  const handleAudioscrobblerConnect = async (
    provider: "lastfm" | "librefm",
    setState: React.Dispatch<React.SetStateAction<AudioscrobblerState>>,
  ) => {
    setState((s) => ({ ...s, step: "waiting", error: null }));
    try {
      const command =
        provider === "lastfm" ? "connect_lastfm" : "connect_librefm";
      const { url, token } = await invoke<{ url: string; token: string }>(
        command,
      );
      await openUrl(url);
      setState((s) => ({ ...s, step: "authorized", token }));
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to start auth flow";
      setState((s) => ({ ...s, step: "idle", error: msg }));
    }
  };

  const handleAudioscrobblerSubmit = async (
    provider: "lastfm" | "librefm",
    state: AudioscrobblerState,
    setState: React.Dispatch<React.SetStateAction<AudioscrobblerState>>,
  ) => {
    if (!state.token) return;
    setState((s) => ({ ...s, step: "submitting", error: null }));
    try {
      await invoke<string>("complete_audioscrobbler_auth", {
        providerName: provider,
        token: state.token,
      });
      setState({ step: "idle", token: "", error: null });
      await fetchStatus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Authentication failed";
      setState((s) => ({ ...s, step: "authorized", error: msg }));
    }
  };

  const handleListenBrainzConnect = async () => {
    if (!listenbrainz.token.trim()) return;
    setListenBrainz((s) => ({ ...s, step: "submitting", error: null }));
    try {
      await invoke<string>("connect_listenbrainz", {
        token: listenbrainz.token.trim(),
      });
      setListenBrainz({ step: "idle", token: "", error: null });
      await fetchStatus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Invalid token";
      setListenBrainz((s) => ({ ...s, step: "idle", error: msg }));
    }
  };

  const handleDisconnect = async (provider: string) => {
    try {
      await invoke("disconnect_provider", { provider });
      await fetchStatus();
    } catch {
      // ignore
    }
  };

  const glyphClass =
    "w-[38px] h-[38px] rounded-xl shrink-0 flex items-center justify-center text-th-text-secondary bg-th-surface border border-th-border-subtle";

  const renderProviderRow = (
    name: string,
    displayName: string,
    glyph: React.ReactNode,
    provider: "lastfm" | "librefm",
    state: AudioscrobblerState,
    setState: React.Dispatch<React.SetStateAction<AudioscrobblerState>>,
  ) => {
    const status = getStatus(name);
    const connected = status?.connected ?? false;

    return (
      <div
        className="relative px-4 py-3.5 border-t border-th-border-subtle first:border-t-0"
        style={connected ? { background: ACCENT_TINT } : undefined}
      >
        {connected && (
          <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-th-accent" />
        )}

        <div className="flex items-center gap-3">
          <div className={glyphClass}>{glyph}</div>

          <div className="flex-1 min-w-0">
            <div className="text-[13.5px] font-bold text-th-text-primary">
              {displayName}
            </div>
            {connected ? (
              <div className="flex items-center gap-2 mt-0.5 text-[11.5px] text-th-text-secondary">
                <span className="w-[7px] h-[7px] rounded-full bg-th-accent shrink-0" />
                Scrobbling as{" "}
                <span className="text-th-text-primary font-semibold">
                  {status?.username}
                </span>
              </div>
            ) : state.step === "waiting" ? (
              <div className="flex items-center gap-2 mt-0.5 text-[11.5px] text-th-text-secondary">
                <Loader2 size={12} className="animate-spin" />
                Opening browser…
              </div>
            ) : (
              <div className="text-[11.5px] text-th-text-muted mt-0.5">
                Not connected
              </div>
            )}
          </div>

          {connected ? (
            <button
              onClick={() => handleDisconnect(provider)}
              className="text-[11.5px] text-th-text-muted hover:text-red-400 transition-colors shrink-0"
            >
              Disconnect
            </button>
          ) : state.step === "idle" ? (
            <button
              onClick={() => handleAudioscrobblerConnect(provider, setState)}
              className={CONNECT_BTN}
            >
              Connect
            </button>
          ) : null}
        </div>

        {!connected &&
          (state.step === "authorized" || state.step === "submitting") && (
            <div className="mt-3 space-y-2">
              <p className="text-[11.5px] text-th-text-muted">
                Authorize in the browser, then come back and click below.
              </p>
              <button
                onClick={() =>
                  handleAudioscrobblerSubmit(provider, state, setState)
                }
                disabled={state.step === "submitting"}
                className={CONNECT_BTN}
              >
                {state.step === "submitting" && (
                  <Loader2 size={13} className="animate-spin" />
                )}
                I've authorized
              </button>
              {state.error && (
                <p className="text-[11.5px] text-red-400">{state.error}</p>
              )}
            </div>
          )}

        {!connected && state.step === "idle" && state.error && (
          <p className="mt-2 text-[11.5px] text-red-400">{state.error}</p>
        )}
      </div>
    );
  };

  const lbStatus = getStatus("listenbrainz");
  const lbConnected = lbStatus?.connected ?? false;

  return (
    <div>
      <p className="text-[10.5px] font-bold tracking-[1.4px] uppercase text-th-text-faint mb-3">
        Scrobbling
      </p>
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={24} className="animate-spin text-th-accent" />
        </div>
      ) : (
        <div
          className="rounded-xl bg-th-base border border-th-border-subtle overflow-hidden"
          style={{
            boxShadow:
              "inset 0 2px 8px light-dark(rgba(0,0,0,0.07), rgba(0,0,0,0.35))",
          }}
        >
          {renderProviderRow(
            "lastfm",
            "Last.fm",
            LASTFM_GLYPH,
            "lastfm",
            lastfm,
            setLastfm,
          )}
          {renderProviderRow(
            "librefm",
            "Libre.fm",
            LIBREFM_GLYPH,
            "librefm",
            librefm,
            setLibrefm,
          )}

          {/* ListenBrainz */}
          <div
            className="relative px-4 py-3.5 border-t border-th-border-subtle"
            style={lbConnected ? { background: ACCENT_TINT } : undefined}
          >
            {lbConnected && (
              <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-th-accent" />
            )}

            <div className="flex items-center gap-3">
              <div className={glyphClass}>{LISTENBRAINZ_GLYPH}</div>
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-bold text-th-text-primary">
                  ListenBrainz
                </div>
                {lbConnected ? (
                  <div className="flex items-center gap-2 mt-0.5 text-[11.5px] text-th-text-secondary">
                    <span className="w-[7px] h-[7px] rounded-full bg-th-accent shrink-0" />
                    Scrobbling as{" "}
                    <span className="text-th-text-primary font-semibold">
                      {lbStatus?.username}
                    </span>
                  </div>
                ) : (
                  <div className="text-[11.5px] text-th-text-muted mt-0.5">
                    Paste token to connect
                  </div>
                )}
              </div>
              {lbConnected && (
                <button
                  onClick={() => handleDisconnect("listenbrainz")}
                  className="text-[11.5px] text-th-text-muted hover:text-red-400 transition-colors shrink-0"
                >
                  Disconnect
                </button>
              )}
            </div>

            {!lbConnected && (
              <div className="mt-3 space-y-2">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={listenbrainz.token}
                    onChange={(e) =>
                      setListenBrainz((s) => ({
                        ...s,
                        token: e.target.value,
                      }))
                    }
                    placeholder="User token"
                    disabled={listenbrainz.step === "submitting"}
                    className="flex-1 px-3 py-1.5 text-[13px] bg-th-inset border border-th-border-subtle rounded-lg text-th-text-primary placeholder:text-th-text-muted focus:outline-none focus:border-th-accent transition-colors disabled:opacity-50"
                  />
                  <button
                    onClick={handleListenBrainzConnect}
                    disabled={
                      listenbrainz.step === "submitting" ||
                      !listenbrainz.token.trim()
                    }
                    className={CONNECT_BTN}
                  >
                    {listenbrainz.step === "submitting" && (
                      <Loader2 size={13} className="animate-spin" />
                    )}
                    Connect
                  </button>
                </div>
                <p className="text-[11px] text-th-text-muted">
                  Get your token from{" "}
                  <button
                    onClick={() =>
                      openUrl("https://listenbrainz.org/settings/")
                    }
                    className="text-th-accent hover:underline inline-flex items-center gap-0.5"
                  >
                    listenbrainz.org/settings
                    <ExternalLink size={10} />
                  </button>
                </p>
                {listenbrainz.error && (
                  <p className="text-[11.5px] text-red-400">
                    {listenbrainz.error}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {!loading && queueSize > 0 && (
        <div className="flex items-center justify-between mt-4 pt-3 border-t border-th-border-subtle">
          <span className="inline-flex items-center gap-2 text-[10px] text-th-text-secondary bg-th-surface border border-th-border-subtle px-3 py-1.5 rounded-full">
            Pending scrobbles
            <span className="bg-th-accent text-th-on-accent font-extrabold text-[9.5px] px-1.5 py-px rounded-full">
              {queueSize}
            </span>
          </span>
          <span className="text-[10px] text-th-text-muted">
            auto-retries on reconnect
          </span>
        </div>
      )}
    </div>
  );
}
