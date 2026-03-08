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
