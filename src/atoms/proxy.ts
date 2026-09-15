import { atom } from "jotai";

export interface ProxySettings {
  enabled: boolean;
  proxy_type: "http" | "socks5";
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

export const proxySettingsAtom = atom<ProxySettings>({
  enabled: false,
  proxy_type: "http",
  host: "",
  port: 0,
  username: null,
  password: null,
});

/**
 * Dispatched on `window` once the proxy settings have been saved, from
 * whichever screen sent them.
 *
 * Saving detaches whatever gapless branch was prerolled — the backend will not
 * keep a branch opened under settings it no longer holds — and nothing else
 * tells the frontend that the slot is now empty. `useGaplessPrefetch` dedups on
 * the predicted next track, which a proxy save does not change, so without this
 * the slot stays empty until the boundary: one audible gap after every save.
 */
export const PROXY_SAVED_EVENT = "sone:proxy-saved";
