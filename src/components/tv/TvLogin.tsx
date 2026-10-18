import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useSetAtom } from "jotai";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { QRCodeSVG } from "qrcode.react";
import { ArrowLeft, LogOut, RefreshCw, Smartphone, Tv } from "lucide-react";
import {
  getDefaultCredentials,
  hasPkceDefaults,
  startPkceLoginWindow,
} from "../../api/tidal";
import { authTokensAtom, isAuthenticatedAtom } from "../../atoms/auth";
import { tvModeAtom } from "../../atoms/tv";
import type { AuthTokens } from "../../types";
import { useAuth } from "../../hooks/useAuth";
import { formatSoneError } from "../../lib/errorUtils";
import { focusFirstIn, moveFocus, type Direction } from "../../lib/spatialNav";
import { TvButton } from "./TvParts";
import "./tv.css";

const ARROWS: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

type State =
  | { step: "starting" }
  | {
      step: "code";
      userCode: string;
      verificationUri: string;
      qrUrl: string;
    }
  | { step: "signing-in" }
  | { step: "error"; message: string }
  | { step: "no-credentials" };

const withScheme = (uri: string) =>
  uri.startsWith("http") ? uri : `https://${uri}`;

/**
 * Sign-in for TV mode, two ways:
 * - On this TV (the desktop's PKCE sign-in, in a maximized window scaled for
 *   the TV): full quality, but e-mail and password need a keyboard.
 * - With a phone: TIDAL's device login as a QR code (or a code to enter at
 *   the address shown); nothing to type, but TIDAL caps streams from this
 *   kind of sign-in below lossless.
 * Either way the TV interface takes over once signed in. The desktop login
 * (other methods) is one button away.
 */
export default function TvLogin() {
  const { startDeviceAuth, pollDeviceAuth, getUserPlaylists } = useAuth();
  const setTvMode = useSetAtom(tvModeAtom);
  const setAuthTokens = useSetAtom(authTokensAtom);
  const setIsAuthenticated = useSetAtom(isAuthenticatedAtom);
  const rootRef = useRef<HTMLDivElement>(null);
  // null until known whether this build can sign in on the TV (PKCE).
  const [pkce, setPkce] = useState<boolean | null>(null);
  const [usePhone, setUsePhone] = useState(false);
  const [tvError, setTvError] = useState<string | null>(null);
  const [state, setState] = useState<State>({ step: "starting" });
  const [attempt, setAttempt] = useState(0);
  const phone = pkce === false || usePhone;

  useEffect(() => {
    hasPkceDefaults().then(setPkce, () => setPkce(false));
  }, []);

  // The on-TV sign-in reports back through these events (as on the desktop).
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    listen<AuthTokens>("pkce-login-success", async (event) => {
      const tokens = event.payload;
      setAuthTokens(tokens);
      setIsAuthenticated(true);
      if (tokens.user_id) {
        await getUserPlaylists(tokens.user_id).catch(() => {});
      }
    }).then((u) => unsubs.push(u));
    listen<string>("pkce-login-error", (event) => {
      setTvError(event.payload || "Signing in failed.");
    }).then((u) => unsubs.push(u));
    return () => unsubs.forEach((u) => u());
  }, [getUserPlaylists, setAuthTokens, setIsAuthenticated]);

  const signInOnTv = useCallback(() => {
    setTvError(null);
    // Scale the sign-in page like the TV interface (1 at 1080p ÷ 1.5 ...).
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    startPkceLoginWindow(Math.max(1, rem / 16)).catch((e) =>
      setTvError(formatSoneError(e)),
    );
  }, []);

  // Same screen scaling and full screen as the TV interface.
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.classList.add("tv-mode");
    getCurrentWindow()
      .setFullscreen(true)
      .catch(() => {});
    return () => html.classList.remove("tv-mode");
  }, []);

  useEffect(() => {
    if (!phone) return;
    let cancelled = false;
    let timer: number | undefined;
    (async () => {
      try {
        const creds = await getDefaultCredentials();
        if (cancelled) return;
        if (!creds.clientId) {
          setState({ step: "no-credentials" });
          return;
        }
        const resp = await startDeviceAuth(creds.clientId, creds.clientSecret);
        if (cancelled) return;
        const uri = withScheme(resp.verificationUri);
        setState({
          step: "code",
          userCode: resp.userCode,
          verificationUri: uri,
          qrUrl: resp.verificationUriComplete
            ? withScheme(resp.verificationUriComplete)
            : uri,
        });
        const interval = Math.max(resp.interval || 5, 5) * 1000;
        const deadline = Date.now() + (resp.expiresIn || 300) * 1000;
        const poll = async () => {
          if (cancelled) return;
          if (Date.now() > deadline) {
            setState({
              step: "error",
              message: "The code expired. Get a new one to try again.",
            });
            return;
          }
          try {
            const tokens = await pollDeviceAuth(
              resp.deviceCode,
              creds.clientId,
              creds.clientSecret,
            );
            if (cancelled) return;
            if (tokens) {
              // Signed in: the app switches to the TV interface.
              setState({ step: "signing-in" });
              if (tokens.user_id) {
                await getUserPlaylists(tokens.user_id).catch(() => {});
              }
              return;
            }
            timer = window.setTimeout(poll, interval);
          } catch (e) {
            if (!cancelled) {
              setState({ step: "error", message: formatSoneError(e) });
            }
          }
        };
        timer = window.setTimeout(poll, interval);
      } catch (e) {
        if (!cancelled)
          setState({ step: "error", message: formatSoneError(e) });
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [phone, attempt, startDeviceAuth, pollDeviceAuth, getUserPlaylists]);

  const retry = useCallback(() => {
    setState({ step: "starting" });
    setAttempt((a) => a + 1);
  }, []);

  // The remote: arrows move between the buttons, Enter presses them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = ARROWS[e.key];
      const root = rootRef.current;
      if (!dir || !root) return;
      e.preventDefault();
      if (!root.contains(document.activeElement)) focusFirstIn(root);
      else moveFocus(root, dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const root = rootRef.current;
    if (root && !root.contains(document.activeElement)) focusFirstIn(root);
  }, [state.step, phone, pkce]);

  if (!phone) {
    return (
      <div
        ref={rootRef}
        className="tv-root h-full w-full flex items-center justify-center px-[5rem] bg-th-base text-th-text-primary"
      >
        <div className="max-w-[40rem]">
          <h1 className="text-[2.4rem] font-extrabold leading-tight">
            Sign in to TIDAL
          </h1>
          {pkce === null ? (
            <p className="mt-[1rem] text-[1rem] text-th-text-secondary">…</p>
          ) : (
            <>
              <div className="mt-[2rem]">
                <TvButton
                  primary
                  autoFocus
                  icon={<Tv className="w-[1rem] h-[1rem]" />}
                  label="Sign in on this TV"
                  onClick={signInOnTv}
                />
                <p className="mt-[0.6rem] text-[0.85rem] text-th-text-secondary">
                  Full quality, up to Hi-Res. Opens TIDAL&apos;s sign-in page;
                  e-mail and password need a keyboard.
                </p>
                {tvError && (
                  <p className="mt-[0.6rem] text-[0.85rem] text-red-400">
                    {tvError}
                  </p>
                )}
              </div>
              <div className="mt-[2rem]">
                <TvButton
                  icon={<Smartphone className="w-[1rem] h-[1rem]" />}
                  label="Sign in with your phone"
                  onClick={() => setUsePhone(true)}
                />
                <p className="mt-[0.6rem] text-[0.85rem] text-th-text-secondary">
                  Scan a QR code, nothing to type. TIDAL limits this kind of
                  sign-in to High quality (AAC, 320 kbps).
                </p>
              </div>
              <div className="mt-[2rem]">
                <TvButton
                  icon={<LogOut className="w-[1rem] h-[1rem]" />}
                  label="Other sign-in options"
                  title="Leave TV mode for the desktop sign-in"
                  onClick={() => setTvMode(false)}
                />
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="tv-root h-full w-full flex items-center justify-center gap-[5rem] px-[5rem] bg-th-base text-th-text-primary"
    >
      <div className="max-w-[34rem]">
        <h1 className="text-[2.4rem] font-extrabold leading-tight">
          Sign in to TIDAL
        </h1>
        {state.step === "code" && (
          <>
            <p className="mt-[1rem] text-[1rem] text-th-text-secondary">
              Scan the code with your phone and sign in there. Or open
            </p>
            <p className="mt-[0.3rem] text-[1.1rem] font-semibold text-th-accent break-all">
              {state.verificationUri.replace(/^https?:\/\//, "")}
            </p>
            <p className="mt-[0.3rem] text-[1rem] text-th-text-secondary">
              and enter this code:
            </p>
            <p className="mt-[0.8rem] text-[2.6rem] font-extrabold tracking-[0.2em] tabular-nums">
              {state.userCode}
            </p>
            <p className="mt-[0.8rem] text-[0.8rem] text-th-text-muted">
              TIDAL limits this kind of sign-in to High quality (AAC, 320 kbps).
            </p>
          </>
        )}
        {state.step === "starting" && (
          <p className="mt-[1rem] text-[1rem] text-th-text-secondary">
            Getting a sign-in code…
          </p>
        )}
        {state.step === "signing-in" && (
          <p className="mt-[1rem] text-[1rem] text-th-text-secondary">
            Signed in — loading your library…
          </p>
        )}
        {state.step === "error" && (
          <p className="mt-[1rem] text-[1rem] text-th-text-secondary">
            {state.message}
          </p>
        )}
        {state.step === "no-credentials" && (
          <p className="mt-[1rem] text-[1rem] text-th-text-secondary">
            This build has no built-in sign-in code. Sign in once in the desktop
            layout; TV mode picks up from there.
          </p>
        )}
        <div className="mt-[2rem] flex flex-wrap gap-[0.8rem]">
          {(state.step === "code" || state.step === "error") && (
            <TvButton
              primary={state.step === "error"}
              icon={<RefreshCw className="w-[1rem] h-[1rem]" />}
              label="New code"
              onClick={retry}
            />
          )}
          {pkce && (
            <TvButton
              icon={<ArrowLeft className="w-[1rem] h-[1rem]" />}
              label="Back"
              onClick={() => setUsePhone(false)}
            />
          )}
          <TvButton
            primary={state.step === "no-credentials"}
            icon={<LogOut className="w-[1rem] h-[1rem]" />}
            label="Other sign-in options"
            title="Leave TV mode for the desktop sign-in"
            onClick={() => setTvMode(false)}
          />
        </div>
      </div>
      {state.step === "code" && (
        <div className="shrink-0 rounded-[1.2rem] bg-white p-[1.2rem]">
          <QRCodeSVG
            value={state.qrUrl}
            level="M"
            className="block w-[16rem] h-[16rem]"
          />
        </div>
      )}
    </div>
  );
}
