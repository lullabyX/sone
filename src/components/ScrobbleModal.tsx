import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { X, Loader2, ExternalLink } from "lucide-react";

interface ScrobbleModalProps {
  open: boolean;
  onClose: () => void;
}

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

export default function ScrobbleModal({ open, onClose }: ScrobbleModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
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

  // Fetch status on open
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setLastfm({ step: "idle", token: "", error: null });
    setLibrefm({ step: "idle", token: "", error: null });
    setListenBrainz({ step: "idle", token: "", error: null });
    fetchStatus();
  }, [open]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

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

  const renderAudioscrobblerCard = (
    name: string,
    displayName: string,
    provider: "lastfm" | "librefm",
    state: AudioscrobblerState,
    setState: React.Dispatch<React.SetStateAction<AudioscrobblerState>>,
  ) => {
    const status = getStatus(name);
    const connected = status?.connected ?? false;

    return (
      <div className="rounded-lg bg-th-surface border border-th-border-subtle p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[14px] font-semibold text-th-text-primary">
            {displayName}
          </h3>
          {connected && (
            <button
              onClick={() => handleDisconnect(provider)}
              className="text-[12px] text-red-400 hover:text-red-300 transition-colors"
            >
              Disconnect
            </button>
          )}
        </div>

        {connected ? (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-400" />
            <span className="text-[13px] text-green-400">
              Scrobbling as: {status?.username}
            </span>
          </div>
        ) : (
          <>
            {state.step === "idle" && (
              <>
                <button
                  onClick={() =>
                    handleAudioscrobblerConnect(provider, setState)
                  }
                  className="px-4 py-1.5 text-[13px] font-bold rounded-full bg-th-accent text-black hover:brightness-110 active:scale-95 transition-all duration-150"
                >
                  Connect
                </button>
                {state.error && (
                  <p className="mt-2 text-[12px] text-red-400">{state.error}</p>
                )}
              </>
            )}

            {state.step === "waiting" && (
              <div className="flex items-center gap-2 text-[13px] text-th-text-secondary">
                <Loader2 size={14} className="animate-spin" />
                Opening browser...
              </div>
            )}

            {(state.step === "authorized" || state.step === "submitting") && (
              <div className="space-y-2">
                <p className="text-[12px] text-th-text-muted">
                  Authorize in the browser, then come back and click below.
                </p>
                <button
                  onClick={() =>
                    handleAudioscrobblerSubmit(provider, state, setState)
                  }
                  disabled={state.step === "submitting"}
                  className="px-4 py-1.5 text-[13px] font-bold rounded-full bg-th-accent text-black hover:brightness-110 active:scale-95 transition-all duration-150 disabled:opacity-50 disabled:pointer-events-none flex items-center gap-1.5"
                >
                  {state.step === "submitting" && (
                    <Loader2 size={13} className="animate-spin" />
                  )}
                  I've authorized
                </button>
                {state.error && (
                  <p className="text-[12px] text-red-400">{state.error}</p>
                )}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const lbStatus = getStatus("listenbrainz");
  const lbConnected = lbStatus?.connected ?? false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={panelRef}
        className="w-[440px] bg-th-elevated rounded-xl shadow-2xl max-h-[80vh] flex flex-col overflow-hidden"
        style={{ animation: "slideUp 0.2s ease-out" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h2 className="text-[16px] font-bold text-th-text-primary">
            Scrobbling
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-th-inset transition-colors text-th-text-muted hover:text-th-text-primary"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 pb-5 space-y-3 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={24} className="animate-spin text-th-accent" />
            </div>
          ) : (
            <>
              {/* Last.fm */}
              {renderAudioscrobblerCard(
                "lastfm",
                "Last.fm",
                "lastfm",
                lastfm,
                setLastfm,
              )}

              {/* Libre.fm */}
              {renderAudioscrobblerCard(
                "librefm",
                "Libre.fm",
                "librefm",
                librefm,
                setLibrefm,
              )}

              {/* ListenBrainz */}
              <div className="rounded-lg bg-th-surface border border-th-border-subtle p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-[14px] font-semibold text-th-text-primary">
                    ListenBrainz
                  </h3>
                  {lbConnected && (
                    <button
                      onClick={() => handleDisconnect("listenbrainz")}
                      className="text-[12px] text-red-400 hover:text-red-300 transition-colors"
                    >
                      Disconnect
                    </button>
                  )}
                </div>

                {lbConnected ? (
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-400" />
                    <span className="text-[13px] text-green-400">
                      Scrobbling as: {lbStatus?.username}
                    </span>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-[12px] text-th-text-muted">
                      Paste your user token from{" "}
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
                        className="px-4 py-1.5 text-[13px] font-bold rounded-full bg-th-accent text-black hover:brightness-110 active:scale-95 transition-all duration-150 disabled:opacity-50 disabled:pointer-events-none flex items-center gap-1.5"
                      >
                        {listenbrainz.step === "submitting" && (
                          <Loader2 size={13} className="animate-spin" />
                        )}
                        Connect
                      </button>
                    </div>
                    {listenbrainz.error && (
                      <p className="text-[12px] text-red-400">
                        {listenbrainz.error}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Pending scrobbles */}
              {queueSize > 0 && (
                <p className="text-[12px] text-th-text-muted pt-1">
                  Pending scrobbles: {queueSize}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
