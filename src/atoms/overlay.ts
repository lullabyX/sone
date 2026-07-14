import { atom } from "jotai";

export type OverlayConnectionInfo = {
  enabled: boolean;
  url: string | null;
  port: number | null;
  host: string;
};

export const overlayConnectionInfoAtom = atom<OverlayConnectionInfo>({
  enabled: false,
  url: null,
  port: null,
  host: "127.0.0.1",
});
