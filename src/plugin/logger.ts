import type { createOpencodeClient } from "@opencode-ai/sdk";

type Client = ReturnType<typeof createOpencodeClient>;

export function createLogger(client: Client) {
  const log = (level: "info" | "warn" | "error", message: string) => {
    client.app.log({ body: { service: "lattice", level, message } }).catch(() => {});
  };
  return {
    info: (message: string) => log("info", message),
    warn: (message: string) => log("warn", message),
    error: (message: string) => log("error", message),
  };
}
