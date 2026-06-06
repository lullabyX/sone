import { atom } from "jotai";

export type McpConnectionInfo = {
  enabled: boolean;
  url: string | null;
  port: number | null;
};

export const mcpConnectionInfoAtom = atom<McpConnectionInfo>({
  enabled: false,
  url: null,
  port: null,
});
