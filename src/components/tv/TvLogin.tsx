import { useCallback, useEffect, useRef, useState } from "react";
import { useSetAtom } from "jotai";
import { listen } from "@tauri-apps/api/event";
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
import { formatSoneError, isNetworkError } from "../../lib/errorUtils";
import { focusFirstIn } from "../../lib/spatialNav";
import ProxyNoticeBanner from "../ProxyNoticeBanner";
import { TvButton } from "./TvParts";
import { TvQrCode } from "./TvQrCode";
import { useTvLocalNav } from "./useTvLocalNav";
import "./tv.css";

const OFFLINE_TEXT =
  "Can't reach TIDAL. Check the network connection, then try again.";

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

const phoneErrorText = (e: unknown) =>
  isNetworkError(e) ? OFFLINE_TEXT : formatSoneError(e);

const withScheme = (uri: string) =>
  uri.startsWith("http") ? uri : `https://${uri}`;

/**
 * Sign-in for TV mode, two ways:
 * - With a phone (default): TIDAL's device login as a QR code (or a code to
 *   enter at the address shown); nothing to type.
 * - On this TV (the desktop's PKCE sign-in, in a maximized window scaled for
 *   the TV): e-mail and password need a keyboard.
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
    let disposed = false;
    const unsubs: Array<() => void> = [];
    // A listener that registers after the screen closed goes straight away.
    const keep = (u: () => void) => (disposed ? u() : void unsubs.push(u));
    listen<AuthTokens>("pkce-login-success", async (event) => {
      const tokens = event.payload;
      setAuthTokens(tokens);
      setIsAuthenticated(true);
      if (tokens.user_id) {
        await getUserPlaylists(tokens.user_id).catch(() => {});
      }
    }).then(keep);
    listen<string>("pkce-login-error", (event) => {
      setTvError(event.payload || "Signing in failed.");
    }).then(keep);
    listen("pkce-login-cancelled", () => {
      setTvError(null);
      if (rootRef.current) focusFirstIn(rootRef.current);
    }).then(keep);
    listen("pkce-login-offline", () => {
      setTvError(OFFLINE_TEXT);
      if (rootRef.current) focusFirstIn(rootRef.current);
    }).then(keep);
    return () => {
      disposed = true;
      unsubs.forEach((u) => u());
    };
  }, [getUserPlaylists, setAuthTokens, setIsAuthenticated]);

  const signInOnTv = useCallback(() => {
    setTvError(null);
    // Scale the sign-in page like the TV interface (1 at 1080p ÷ 1.5 ...).
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    startPkceLoginWindow(Math.max(1, rem / 16)).catch((e) =>
      setTvError(formatSoneError(e)),
    );
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
              setState({ step: "error", message: phoneErrorText(e) });
            }
          }
        };
        timer = window.setTimeout(poll, interval);
      } catch (e) {
        if (!cancelled) setState({ step: "error", message: phoneErrorText(e) });
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

  // A fresh code each time the phone way is chosen, never the last one.
  const choosePhone = () => {
    setState({ step: "starting" });
    setUsePhone(true);
  };
  const back = () => {
    setState({ step: "starting" });
    setUsePhone(false);
  };

  useTvLocalNav(rootRef, `${state.step}:${phone}:${pkce}`);

  if (!phone) {
    return (
      <div
        ref={rootRef}
        className="tv-root h-full w-full flex flex-col bg-th-base text-th-text-primary"
      >
        <ProxyNoticeBanner />
        <div className="flex-1 min-h-0 flex items-center justify-center px-[5rem]">
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
                    icon={<Smartphone className="w-[1rem] h-[1rem]" />}
                    label="Sign in with your phone"
                    onClick={choosePhone}
                  />
                  <p className="mt-[0.6rem] text-[0.85rem] text-th-text-secondary">
                    Scan a QR code. No typing needed.
                  </p>
                </div>
                <div className="mt-[2rem]">
                  <TvButton
                    icon={<Tv className="w-[1rem] h-[1rem]" />}
                    label="Sign in on this TV"
                    onClick={signInOnTv}
                  />
                  <p className="mt-[0.6rem] text-[0.85rem] text-th-text-secondary">
                    Opens TIDAL&apos;s sign-in page here. You&apos;ll need a
                    keyboard to type.
                  </p>
                  {tvError && (
                    <p className="mt-[0.6rem] text-[0.85rem] text-red-400">
                      {tvError}
                    </p>
                  )}
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
      </div>
    );
  }

  // Default focus stays off the proxy notice, whose OK turns the proxy off.
  const canRetry =
    state.step === "code" ||
    state.step === "starting" ||
    state.step === "error";
  return (
    <div
      ref={rootRef}
      className="tv-root h-full w-full flex flex-col bg-th-base text-th-text-primary"
    >
      <ProxyNoticeBanner />
      <div className="flex-1 min-h-0 flex items-center justify-center gap-[5rem] px-[5rem]">
        <div className="max-w-[34rem]">
          <h1 className="text-[2.4rem] font-extrabold leading-tight">
            Sign in to TIDAL
          </h1>
          {(state.step === "code" || state.step === "starting") && (
            <>
              {state.step === "starting" && (
                <span className="sr-only">Getting a sign-in code…</span>
              )}
              <p className="mt-[1rem] text-[1rem] text-th-text-secondary">
                Scan the QR code with your phone and sign in there.
              </p>
              <p className="mt-[0.8rem] text-[1rem] text-th-text-secondary">
                Or go to
              </p>
              <p className="mt-[0.3rem] text-[1.1rem] font-semibold text-th-accent break-all">
                {state.step === "code" ? (
                  state.verificationUri.replace(/^https?:\/\//, "")
                ) : (
                  <span className="inline-block h-[1em] w-[11em] align-middle rounded bg-th-surface-hover animate-pulse" />
                )}
              </p>
              <p className="mt-[0.3rem] text-[1rem] text-th-text-secondary">
                and enter this code:
              </p>
              <p className="mt-[0.8rem] text-[2.6rem] font-extrabold tracking-[0.2em] tabular-nums">
                {state.step === "code" ? (
                  state.userCode
                ) : (
                  <span className="inline-block h-[1em] w-[4.5em] align-middle rounded-[0.3rem] bg-th-surface-hover animate-pulse" />
                )}
              </p>
            </>
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
              Phone sign-in isn&apos;t available in this build. Sign in once
              from the desktop layout and TV mode will use that account.
            </p>
          )}
          <div className="mt-[2rem] flex flex-wrap gap-[0.8rem]">
            {canRetry && (
              <TvButton
                primary={state.step === "error"}
                autoFocus
                icon={<RefreshCw className="w-[1rem] h-[1rem]" />}
                label={state.step === "error" ? "Try again" : "New code"}
                onClick={retry}
              />
            )}
            {pkce && (
              <TvButton
                icon={<ArrowLeft className="w-[1rem] h-[1rem]" />}
                label="Back"
                autoFocus={!canRetry}
                onClick={back}
              />
            )}
            <TvButton
              primary={state.step === "no-credentials"}
              autoFocus={!canRetry && !pkce}
              icon={<LogOut className="w-[1rem] h-[1rem]" />}
              label="Other sign-in options"
              title="Leave TV mode for the desktop sign-in"
              onClick={() => setTvMode(false)}
            />
          </div>
        </div>
        {state.step === "code" && (
          <TvQrCode
            value={state.qrUrl}
            label="Phone sign-in code"
            className="w-[16rem] h-[16rem]"
          />
        )}
        {state.step === "starting" && (
          <div
            aria-hidden
            className="shrink-0 w-[18.4rem] h-[18.4rem] rounded-[1.2rem] bg-th-surface-hover animate-pulse"
          />
        )}
      </div>
    </div>
  );
}
