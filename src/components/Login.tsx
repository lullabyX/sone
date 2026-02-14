import { useState, useRef, useEffect, useCallback } from "react";
import { useAuth } from "../hooks/useAuth";
import { getSavedCredentials, parseTokenData } from "../api/tidal";
import {
  Loader2,
  ExternalLink,
  ClipboardPaste,
  KeyRound,
  Eye,
  EyeOff,
  Info,
  Smartphone,
  Globe,
  Import,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

type AuthMethod = "device" | "pkce" | "import";

export default function Login() {
  const {
    startPkceAuth,
    completePkceAuth,
    startDeviceAuth,
    pollDeviceAuth,
    importSession,
    getUserPlaylists,
  } = useAuth();

  const [step, setStep] = useState<
    "idle" | "device_pending" | "pkce_waiting" | "exchanging"
  >("idle");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("device");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  // Credentials
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [credentialsLoaded, setCredentialsLoaded] = useState(false);

  // Device code state
  const [userCode, setUserCode] = useState("");
  const [verificationUri, setVerificationUri] = useState("");
  const deviceCodeRef = useRef<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // PKCE state
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [pasteUrl, setPasteUrl] = useState("");
  const pkceRef = useRef<{
    codeVerifier: string;
    clientUniqueKey: string;
  } | null>(null);

  // Token Import state
  const [curlText, setCurlText] = useState("");
  const [responseText, setResponseText] = useState("");
  const [curlMasked, setCurlMasked] = useState(false);
  const [responseMasked, setResponseMasked] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Load saved credentials on mount
  useEffect(() => {
    const loadCreds = async () => {
      const { clientId: savedId, clientSecret: savedSecret } =
        await getSavedCredentials();
      if (savedId) setClientId(savedId);
      if (savedSecret) setClientSecret(savedSecret);
      setCredentialsLoaded(true);
    };
    loadCreds();
  }, []);

  // Auto-mask long pastes
  useEffect(() => {
    if (curlText.length > 200) setCurlMasked(true);
  }, [curlText]);
  useEffect(() => {
    if (responseText.length > 200) setResponseMasked(true);
  }, [responseText]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  const hasSecret = clientSecret.trim().length > 0;

  // ==================== Device Code Flow ====================

  const handleDeviceLogin = async () => {
    if (!clientId.trim()) {
      setError("Client ID is required.");
      return;
    }

    try {
      setError(null);
      setStatus("Starting device authorization...");

      const resp = await startDeviceAuth(clientId.trim(), clientSecret.trim());

      deviceCodeRef.current = resp.deviceCode;
      setUserCode(resp.userCode);

      // Ensure the URI has a protocol prefix
      const ensureUrl = (uri: string) =>
        uri.startsWith("http") ? uri : `https://${uri}`;
      const vUri = ensureUrl(resp.verificationUri);
      const vUriComplete = resp.verificationUriComplete
        ? ensureUrl(resp.verificationUriComplete)
        : null;

      setVerificationUri(vUri);
      setStep("device_pending");
      setStatus("");

      try {
        await openUrl(vUriComplete || vUri);
      } catch {
        window.open(vUriComplete || vUri, "_blank");
      }

      const interval = Math.max(resp.interval || 5, 5) * 1000;
      pollIntervalRef.current = setInterval(async () => {
        if (!deviceCodeRef.current) return;
        try {
          const tokens = await pollDeviceAuth(
            deviceCodeRef.current,
            clientId.trim(),
            clientSecret.trim()
          );
          if (tokens) {
            if (pollIntervalRef.current)
              clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
            setStep("exchanging");
            setStatus("Loading your library...");
            if (tokens.user_id) await getUserPlaylists(tokens.user_id);
            setStep("idle");
            setStatus("");
          }
        } catch (err: any) {
          if (pollIntervalRef.current)
            clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
          setError(`Device auth failed: ${err?.message || err}`);
          setStep("idle");
        }
      }, interval);
    } catch (err: any) {
      setError(`Failed to start device auth: ${err?.message || err}`);
      setStep("idle");
      setStatus("");
    }
  };

  // ==================== PKCE Flow ====================

  const handlePkceLogin = async () => {
    if (!clientId.trim()) {
      setError("Client ID is required.");
      return;
    }
    if (!clientSecret.trim()) {
      setError("Client Secret is required for PKCE.");
      return;
    }

    try {
      setError(null);
      setStep("exchanging");
      setStatus("Preparing login...");
      const params = await startPkceAuth(clientId.trim());
      pkceRef.current = {
        codeVerifier: params.codeVerifier,
        clientUniqueKey: params.clientUniqueKey,
      };
      setAuthorizeUrl(params.authorizeUrl);
      setStep("pkce_waiting");
      setStatus("");
      try {
        await openUrl(params.authorizeUrl);
      } catch {
        window.open(params.authorizeUrl, "_blank");
      }
    } catch (err: any) {
      setError(`Failed to start login: ${err?.message || err}`);
      setStep("idle");
    }
  };

  const handleSubmitUrl = async () => {
    if (!pasteUrl.trim() || !pkceRef.current) return;
    try {
      let code: string | null = null;
      try {
        const url = new URL(pasteUrl.trim());
        code = url.searchParams.get("code");
      } catch {
        if (pasteUrl.trim().length > 10 && !pasteUrl.includes(" "))
          code = pasteUrl.trim();
      }
      if (!code) {
        setError("Could not find authorization code in the URL.");
        return;
      }
      setStep("exchanging");
      setStatus("Completing login...");
      const tokens = await completePkceAuth(
        code,
        pkceRef.current.codeVerifier,
        pkceRef.current.clientUniqueKey,
        clientId.trim(),
        clientSecret.trim()
      );
      setStatus("Loading your library...");
      if (tokens.user_id) await getUserPlaylists(tokens.user_id);
      setStep("idle");
      setStatus("");
    } catch (err: any) {
      setError(`Authentication failed: ${err?.message || err}`);
      setStep("pkce_waiting");
      setStatus("");
    }
  };

  // ==================== Token Import Flow ====================

  const handleTokenImport = async () => {
    if (!curlText.trim() && !responseText.trim()) return;
    setImporting(true);
    setImportError(null);

    try {
      let parsedClientId: string | undefined;
      let parsedClientSecret: string | undefined;
      let parsedRefreshToken: string | undefined;
      let parsedAccessToken: string | undefined;

      if (curlText.trim()) {
        const r = await parseTokenData(curlText.trim());
        parsedClientId = r.clientId || undefined;
        parsedClientSecret = r.clientSecret || undefined;
        if (r.refreshToken) parsedRefreshToken = r.refreshToken;
        if (r.accessToken) parsedAccessToken = r.accessToken;
      }

      if (responseText.trim()) {
        const r = await parseTokenData(responseText.trim());
        if (r.accessToken) parsedAccessToken = r.accessToken;
        if (r.refreshToken) parsedRefreshToken = r.refreshToken;
        if (r.clientId && !parsedClientId) parsedClientId = r.clientId;
      }

      if (!parsedClientId) {
        setImportError(
          "Could not find a Client ID. Make sure you pasted the cURL command."
        );
        return;
      }
      if (!parsedRefreshToken && !parsedAccessToken) {
        setImportError(
          "No session tokens found. Make sure you pasted the Response body (JSON) from the token request."
        );
        return;
      }

      setStep("exchanging");
      setStatus("Importing session...");
      setError(null);

      const tokens = await importSession(
        parsedClientId,
        parsedClientSecret || "",
        parsedRefreshToken || "",
        parsedAccessToken
      );

      setStatus("Loading your library...");
      if (tokens.user_id) await getUserPlaylists(tokens.user_id);
      setStep("idle");
      setStatus("");
    } catch (err: any) {
      setError(`Session import failed: ${err?.message || err}`);
      setStep("idle");
      setStatus("");
    } finally {
      setImporting(false);
    }
  };

  // ==================== Helpers ====================

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setPasteUrl(text);
    } catch {}
  };

  const pasteTo = async (setter: (v: string) => void) => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setter(text);
    } catch {}
  };

  const reset = useCallback(() => {
    setError(null);
    setStep("idle");
    setStatus("");
    setPasteUrl("");
    setAuthorizeUrl("");
    setUserCode("");
    setVerificationUri("");
    pkceRef.current = null;
    deviceCodeRef.current = null;
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  if (!credentialsLoaded) {
    return (
      <div className="flex items-center justify-center h-screen w-screen bg-gradient-to-br from-th-overlay via-th-base to-th-overlay">
        <Loader2 className="animate-spin text-th-accent" size={32} />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-screen w-screen bg-gradient-to-br from-th-overlay via-th-base to-th-overlay">
      <div className="text-center p-10 bg-th-surface/60 backdrop-blur-sm rounded-2xl shadow-2xl border border-th-border-subtle max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="mb-6 flex items-center justify-center gap-3">
          <div className="w-12 h-12 bg-white text-black font-extrabold flex items-center justify-center rounded-md text-2xl">
            T
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-white">
            TIDE VIBE
          </h1>
        </div>

        {/* ==================== Idle ==================== */}
        {step === "idle" && (
          <>
            <p className="text-th-text-muted mb-6 text-lg">
              Connect your Tidal account to start streaming
            </p>

            {/* Credentials */}
            <div className={`text-left bg-th-overlay rounded-xl p-5 border border-th-border-subtle mb-4 transition-opacity ${authMethod === "import" ? "opacity-70 cursor-not-allowed" : ""}`}>
              <div className="flex items-center gap-2 mb-4">
                <KeyRound size={16} className="text-th-accent" />
                <span className="text-[14px] text-white font-medium">
                  API Credentials
                </span>
                {authMethod === "import" && (
                  <span className="text-[10px] text-th-text-faint ml-auto">
                    Extracted from pasted data
                  </span>
                )}
              </div>

              <div className="space-y-3">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[12px] text-th-text-faint">
                      Client ID <span className="text-red-400/70">*</span>
                    </label>
                    <span className="text-[10px] text-th-text-disabled">Required</span>
                  </div>
                  <input
                    type="text"
                    value={authMethod === "import" ? "" : clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    disabled={authMethod === "import"}
                    placeholder={authMethod === "import" ? "Auto-extracted from cURL" : "Your Tidal app Client ID"}
                    className="w-full bg-th-surface border border-white/[0.1] rounded-lg px-3 py-2.5 text-[13px] text-white placeholder-th-text-disabled outline-none focus:border-th-accent/50 font-mono disabled:cursor-not-allowed disabled:placeholder-th-text-faint"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[12px] text-th-text-faint">
                      Client Secret
                    </label>
                    <span className="text-[10px] text-th-text-disabled">
                      Optional -- enables Hi-Res
                    </span>
                  </div>
                  <div className="relative">
                    <input
                      type={showSecret ? "text" : "password"}
                      value={authMethod === "import" ? "" : clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                      disabled={authMethod === "import"}
                      placeholder={authMethod === "import" ? "Auto-extracted from cURL" : "Leave blank for Lossless (CD quality)"}
                      className="w-full bg-th-surface border border-white/[0.1] rounded-lg px-3 py-2.5 pr-10 text-[13px] text-white placeholder-th-text-disabled outline-none focus:border-th-accent/50 font-mono disabled:cursor-not-allowed disabled:placeholder-th-text-faint"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSecret(!showSecret)}
                      disabled={authMethod === "import"}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-th-text-faint hover:text-th-text-faint transition-colors disabled:cursor-not-allowed"
                    >
                      {showSecret ? (
                        <EyeOff size={15} />
                      ) : (
                        <Eye size={15} />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {clientId.trim() && authMethod !== "import" && (
                <div
                  className={`mt-4 flex items-start gap-2 p-2.5 rounded-lg text-[12px] ${
                    hasSecret
                      ? "bg-emerald-900/20 border border-emerald-700/30 text-emerald-400"
                      : "bg-blue-900/20 border border-blue-700/30 text-blue-400"
                  }`}
                >
                  <Info size={14} className="shrink-0 mt-0.5" />
                  {hasSecret ? (
                    <span>
                      <span className="font-medium">Hi-Res mode:</span>{" "}
                      Up to 24-bit/192kHz with automatic token refresh.
                    </span>
                  ) : (
                    <span>
                      <span className="font-medium">Lossless mode:</span>{" "}
                      CD quality (16-bit/44.1kHz). Add a Client Secret for
                      Hi-Res.
                    </span>
                  )}
                </div>
              )}

              <p className="text-[11px] text-th-text-disabled mt-3">
                Credentials are stored locally and only sent to Tidal's auth
                servers.
              </p>
            </div>

            {/* Auth Method Tabs */}
            <div className="text-left bg-th-overlay rounded-xl border border-th-border-subtle mb-6 overflow-hidden">
              <div className="flex border-b border-th-border-subtle">
                {(
                  [
                    ["device", Smartphone, "Device Code"],
                    ["pkce", Globe, "PKCE"],
                    ["import", Import, "Token Import"],
                  ] as const
                ).map(([id, Icon, label]) => (
                  <button
                    key={id}
                    onClick={() => {
                      setAuthMethod(id as AuthMethod);
                      setError(null);
                      setImportError(null);
                    }}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-3 text-[12px] font-medium transition-colors ${
                      authMethod === id
                        ? "text-th-accent bg-th-accent/[0.06] border-b-2 border-th-accent"
                        : "text-th-text-faint hover:text-th-text-faint"
                    }`}
                  >
                    <Icon size={13} />
                    {label}
                  </button>
                ))}
              </div>

              <div className="p-5">
                {/* ---- Device Code ---- */}
                {authMethod === "device" && (
                  <>
                    <p className="text-[12px] text-th-text-faint mb-2">
                      Get a code, visit{" "}
                      <span className="text-th-text-faint">link.tidal.com</span>, and
                      enter it to log in. No redirect URLs needed.
                    </p>
                    <p className="text-[11px] text-amber-400/70 mb-4">
                      Requires a native app Client ID (Android/desktop). Web
                      player client IDs do not support this flow -- use Token
                      Import instead.
                    </p>
                    <button
                      onClick={handleDeviceLogin}
                      disabled={!clientId.trim()}
                      className="w-full px-6 py-3 bg-th-accent text-black font-bold rounded-full hover:scale-[1.02] hover:brightness-110 transition-all text-[15px] shadow-xl disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
                    >
                      Get Login Code
                    </button>
                  </>
                )}

                {/* ---- PKCE ---- */}
                {authMethod === "pkce" && (
                  <>
                    <p className="text-[12px] text-th-text-faint mb-2">
                      Opens Tidal's login in your browser. After login, copy the
                      redirect URL back here.
                    </p>
                    <p className="text-[11px] text-amber-400/70 mb-4">
                      Requires both Client ID and Client Secret from a native
                      app (Android redirect URI). Web player credentials will
                      not work.
                    </p>
                    <button
                      onClick={handlePkceLogin}
                      disabled={!clientId.trim() || !hasSecret}
                      className="w-full px-6 py-3 bg-th-accent text-black font-bold rounded-full hover:scale-[1.02] hover:brightness-110 transition-all text-[15px] shadow-xl disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
                    >
                      Login with Tidal
                    </button>
                  </>
                )}

                {/* ---- Token Import ---- */}
                {authMethod === "import" && (
                  <>
                    <p className="text-[12px] text-th-text-faint mb-4">
                      For{" "}
                      <span className="text-th-text-faint">
                        web player client IDs
                      </span>{" "}
                      or any client that doesn't support Device Code. Paste the
                      cURL and response from your browser's Network tab.
                    </p>

                    {/* cURL field */}
                    <div className="mb-3">
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-[11px] text-th-text-faint font-medium">
                          cURL Command
                        </label>
                        <button
                          onClick={() => pasteTo(setCurlText)}
                          className="flex items-center gap-1 text-[10px] text-th-text-faint hover:text-white transition-colors"
                        >
                          <ClipboardPaste size={10} />
                          Paste
                        </button>
                      </div>
                      <div className="relative">
                        <textarea
                          value={curlText}
                          onChange={(e) => {
                            setCurlText(e.target.value);
                            setImportError(null);
                          }}
                          placeholder="Right-click token request → Copy as cURL"
                          rows={2}
                          className={`w-full bg-th-surface border border-white/[0.1] rounded-lg px-3 py-2 text-[11px] text-white placeholder-th-text-disabled outline-none focus:border-th-accent/50 font-mono resize-none ${
                            curlMasked && curlText.length > 0
                              ? "[-webkit-text-security:disc]"
                              : ""
                          }`}
                        />
                        {curlText.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setCurlMasked(!curlMasked)}
                            className="absolute right-2 top-2 text-th-text-disabled hover:text-th-text-faint transition-colors"
                          >
                            {curlMasked ? (
                              <Eye size={11} />
                            ) : (
                              <EyeOff size={11} />
                            )}
                          </button>
                        )}
                      </div>
                      <p className="text-[10px] text-th-text-disabled mt-0.5">
                        Provides Client ID.
                      </p>
                    </div>

                    {/* Response body field */}
                    <div className="mb-3">
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-[11px] text-th-text-faint font-medium">
                          Response Body
                        </label>
                        <button
                          onClick={() => pasteTo(setResponseText)}
                          className="flex items-center gap-1 text-[10px] text-th-text-faint hover:text-white transition-colors"
                        >
                          <ClipboardPaste size={10} />
                          Paste
                        </button>
                      </div>
                      <div className="relative">
                        <textarea
                          value={responseText}
                          onChange={(e) => {
                            setResponseText(e.target.value);
                            setImportError(null);
                          }}
                          placeholder='Same request → Response tab → copy JSON&#10;{"access_token":"...","refresh_token":"..."}'
                          rows={2}
                          className={`w-full bg-th-surface border border-white/[0.1] rounded-lg px-3 py-2 text-[11px] text-white placeholder-th-text-disabled outline-none focus:border-th-accent/50 font-mono resize-none ${
                            responseMasked && responseText.length > 0
                              ? "[-webkit-text-security:disc]"
                              : ""
                          }`}
                        />
                        {responseText.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setResponseMasked(!responseMasked)}
                            className="absolute right-2 top-2 text-th-text-disabled hover:text-th-text-faint transition-colors"
                          >
                            {responseMasked ? (
                              <Eye size={11} />
                            ) : (
                              <EyeOff size={11} />
                            )}
                          </button>
                        )}
                      </div>
                      <p className="text-[10px] text-th-text-disabled mt-0.5">
                        Provides session tokens (access_token, refresh_token).
                      </p>
                    </div>

                    {importError && (
                      <p className="text-[11px] text-red-400 mb-3">
                        {importError}
                      </p>
                    )}

                    <button
                      onClick={handleTokenImport}
                      disabled={
                        (!curlText.trim() && !responseText.trim()) || importing
                      }
                      className="w-full px-6 py-3 bg-th-accent text-black font-bold rounded-full hover:scale-[1.02] hover:brightness-110 transition-all text-[15px] shadow-xl disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
                    >
                      {importing ? (
                        <span className="flex items-center justify-center gap-2">
                          <Loader2 size={16} className="animate-spin" />
                          Importing...
                        </span>
                      ) : (
                        "Import Session"
                      )}
                    </button>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {/* ==================== Device Code Pending ==================== */}
        {step === "device_pending" && (
          <div className="flex flex-col gap-5">
            <div className="text-left bg-th-overlay rounded-xl p-6 border border-th-border-subtle">
              <p className="text-[14px] text-th-text-muted mb-4">
                Go to the link below and enter this code:
              </p>
              <div className="flex items-center justify-center py-4">
                <span className="text-4xl font-mono font-bold tracking-[0.3em] text-white">
                  {userCode}
                </span>
              </div>
              <div className="flex items-center justify-center gap-2 mt-2 mb-4">
                <span className="text-[13px] text-th-text-faint">
                  {verificationUri}
                </span>
              </div>
              <button
                onClick={async () => {
                  try {
                    await openUrl(verificationUri);
                  } catch {
                    window.open(verificationUri, "_blank");
                  }
                }}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-white/[0.08] hover:bg-th-inset rounded-full text-[13px] text-white font-medium transition-colors"
              >
                <ExternalLink size={14} />
                Open {verificationUri}
              </button>
            </div>
            <div className="flex items-center justify-center gap-3 text-th-text-faint">
              <Loader2 className="animate-spin" size={16} />
              <span className="text-[13px]">Waiting for authorization...</span>
            </div>
            <button
              onClick={reset}
              className="text-[12px] text-th-text-faint hover:text-th-text-faint transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        {/* ==================== PKCE Waiting ==================== */}
        {step === "pkce_waiting" && (
          <div className="flex flex-col gap-5">
            <div className="text-left bg-th-overlay rounded-xl p-5 border border-th-border-subtle">
              <div className="flex items-start gap-3 mb-4">
                <div className="w-7 h-7 rounded-full bg-th-accent/20 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-[13px] font-bold text-th-accent">
                    1
                  </span>
                </div>
                <div>
                  <p className="text-[14px] text-white font-medium">
                    Log in to Tidal in your browser
                  </p>
                  <p className="text-[12px] text-th-text-faint mt-1">
                    A browser window should have opened.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3 mb-4">
                <div className="w-7 h-7 rounded-full bg-th-accent/20 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-[13px] font-bold text-th-accent">
                    2
                  </span>
                </div>
                <div>
                  <p className="text-[14px] text-white font-medium">
                    Copy the redirect URL
                  </p>
                  <p className="text-[12px] text-th-text-faint mt-1">
                    After login you'll see an "Oops" page. Copy the full URL.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-full bg-th-accent/20 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-[13px] font-bold text-th-accent">
                    3
                  </span>
                </div>
                <div className="flex-1">
                  <p className="text-[14px] text-white font-medium mb-2">
                    Paste the URL here
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={pasteUrl}
                      onChange={(e) => setPasteUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSubmitUrl();
                      }}
                      placeholder="https://tidal.com/android/login/auth?code=..."
                      className="flex-1 bg-th-surface border border-white/[0.1] rounded-lg px-3 py-2 text-[13px] text-white placeholder-th-text-disabled outline-none focus:border-th-accent/50 min-w-0"
                    />
                    <button
                      onClick={handlePaste}
                      className="px-3 py-2 bg-white/[0.08] hover:bg-th-inset rounded-lg text-th-text-muted hover:text-white transition-colors shrink-0"
                    >
                      <ClipboardPaste size={16} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={async () => {
                  try {
                    await openUrl(authorizeUrl);
                  } catch {
                    window.open(authorizeUrl, "_blank");
                  }
                }}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-white/[0.08] hover:bg-th-inset rounded-full text-[13px] text-white font-medium transition-colors"
              >
                <ExternalLink size={14} />
                Open Tidal Login
              </button>
              <button
                onClick={handleSubmitUrl}
                disabled={!pasteUrl.trim()}
                className="flex-1 px-4 py-2.5 bg-th-accent text-black rounded-full text-[13px] font-bold hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Complete Login
              </button>
            </div>
            <button
              onClick={reset}
              className="text-[12px] text-th-text-faint hover:text-th-text-faint transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        {/* ==================== Loading ==================== */}
        {step === "exchanging" && (
          <div className="flex flex-col items-center gap-4 py-8">
            <Loader2 className="animate-spin text-th-accent" size={32} />
            <p className="text-th-text-muted">
              {status || "Completing login..."}
            </p>
          </div>
        )}

        {/* ==================== Error ==================== */}
        {error && (
          <div className="mt-5 p-4 bg-red-900/30 border border-red-700/50 rounded-lg text-red-400 text-sm text-left break-words overflow-hidden">
            <p className="whitespace-pre-wrap break-words" style={{ overflowWrap: "anywhere" }}>{error}</p>
            <button
              onClick={() => setError(null)}
              className="mt-2 block w-full text-center underline text-red-300 hover:text-red-200"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
