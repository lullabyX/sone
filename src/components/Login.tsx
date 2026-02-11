import { useState, useRef } from "react";
import { useAudioContext } from "../contexts/AudioContext";
import { Loader2, ExternalLink, ClipboardPaste } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

export default function Login() {
  const { startPkceAuth, completePkceAuth, getUserPlaylists } =
    useAudioContext();
  const [step, setStep] = useState<"idle" | "waiting" | "exchanging">("idle");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [pasteUrl, setPasteUrl] = useState("");
  const pkceRef = useRef<{
    codeVerifier: string;
    clientUniqueKey: string;
  } | null>(null);

  const handleLogin = async () => {
    try {
      setError(null);
      setStep("waiting");
      setStatus("Preparing login...");

      const params = await startPkceAuth();
      pkceRef.current = {
        codeVerifier: params.codeVerifier,
        clientUniqueKey: params.clientUniqueKey,
      };
      setAuthorizeUrl(params.authorizeUrl);
      setStatus("");

      // Open browser
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
      // Extract code from the pasted URL
      let code: string | null = null;
      try {
        const url = new URL(pasteUrl.trim());
        code = url.searchParams.get("code");
      } catch {
        // Maybe they pasted just the code
        if (pasteUrl.trim().length > 10 && !pasteUrl.includes(" ")) {
          code = pasteUrl.trim();
        }
      }

      if (!code) {
        setError(
          "Could not find authorization code in the URL. Make sure you copied the full URL from the browser."
        );
        return;
      }

      setStep("exchanging");
      setStatus("Completing login...");

      const tokens = await completePkceAuth(
        code,
        pkceRef.current.codeVerifier,
        pkceRef.current.clientUniqueKey
      );

      setStatus("Loading your library...");
      if (tokens.user_id) {
        await getUserPlaylists(tokens.user_id);
      }

      setStep("idle");
      setStatus("");
    } catch (err: any) {
      setError(`Authentication failed: ${err?.message || err}`);
      setStep("waiting");
      setStatus("");
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setPasteUrl(text);
      }
    } catch {
      // Clipboard access denied, user can paste manually
    }
  };

  const reset = () => {
    setError(null);
    setStep("idle");
    setStatus("");
    setPasteUrl("");
    setAuthorizeUrl("");
    pkceRef.current = null;
  };

  return (
    <div className="flex items-center justify-center h-screen w-screen bg-gradient-to-br from-[#0a0a0a] via-[#121212] to-[#0a0a0a]">
      <div className="text-center p-10 bg-[#1a1a1a]/60 backdrop-blur-sm rounded-2xl shadow-2xl border border-white/[0.06] max-w-lg w-full mx-4">
        <div className="mb-6 flex items-center justify-center gap-3">
          <div className="w-12 h-12 bg-white text-black font-extrabold flex items-center justify-center rounded-md text-2xl">
            T
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-white">
            TIDE VIBE
          </h1>
        </div>

        {step === "idle" && (
          <>
            <p className="text-[#a6a6a6] mb-8 text-lg">
              Connect your Tidal account to start streaming in Hi-Res
            </p>
            <button
              onClick={handleLogin}
              className="px-8 py-4 bg-[#00FFFF] text-black font-bold rounded-full hover:scale-105 hover:brightness-110 transition-all text-lg shadow-xl"
            >
              Login with Tidal
            </button>
          </>
        )}

        {step === "waiting" && (
          <div className="flex flex-col gap-5">
            <div className="text-left bg-[#0f0f0f] rounded-xl p-5 border border-white/[0.06]">
              <div className="flex items-start gap-3 mb-4">
                <div className="w-7 h-7 rounded-full bg-[#00FFFF]/20 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-[13px] font-bold text-[#00FFFF]">
                    1
                  </span>
                </div>
                <div>
                  <p className="text-[14px] text-white font-medium">
                    Log in to Tidal in your browser
                  </p>
                  <p className="text-[12px] text-[#808080] mt-1">
                    A browser window should have opened. If not, click the
                    button below.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 mb-4">
                <div className="w-7 h-7 rounded-full bg-[#00FFFF]/20 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-[13px] font-bold text-[#00FFFF]">
                    2
                  </span>
                </div>
                <div>
                  <p className="text-[14px] text-white font-medium">
                    Copy the URL from the redirect page
                  </p>
                  <p className="text-[12px] text-[#808080] mt-1">
                    After login you'll see an "Oops" page. Copy the full URL
                    from the browser address bar.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-full bg-[#00FFFF]/20 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-[13px] font-bold text-[#00FFFF]">
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
                      className="flex-1 bg-[#1a1a1a] border border-white/[0.1] rounded-lg px-3 py-2 text-[13px] text-white placeholder-[#555] outline-none focus:border-[#00FFFF]/50 min-w-0"
                    />
                    <button
                      onClick={handlePaste}
                      className="px-3 py-2 bg-white/[0.08] hover:bg-white/[0.12] rounded-lg text-[#a6a6a6] hover:text-white transition-colors shrink-0"
                      title="Paste from clipboard"
                    >
                      <ClipboardPaste size={16} />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => {
                  try {
                    openUrl(authorizeUrl);
                  } catch {
                    window.open(authorizeUrl, "_blank");
                  }
                }}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-white/[0.08] hover:bg-white/[0.12] rounded-full text-[13px] text-white font-medium transition-colors"
              >
                <ExternalLink size={14} />
                Open Tidal Login
              </button>
              <button
                onClick={handleSubmitUrl}
                disabled={!pasteUrl.trim()}
                className="flex-1 px-4 py-2.5 bg-[#00FFFF] text-black rounded-full text-[13px] font-bold hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Complete Login
              </button>
            </div>

            <button
              onClick={reset}
              className="text-[12px] text-[#666] hover:text-[#999] transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        {step === "exchanging" && (
          <div className="flex flex-col items-center gap-4 py-8">
            <Loader2 className="animate-spin text-[#00FFFF]" size={32} />
            <p className="text-[#a6a6a6]">{status || "Completing login..."}</p>
          </div>
        )}

        {error && (
          <div className="mt-5 p-4 bg-red-900/30 border border-red-700/50 rounded-lg text-red-400 text-sm">
            {error}
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
