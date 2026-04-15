import type { createOpencodeClient } from "@opencode-ai/sdk";
import type { SessionProvider } from "./session.js";

type Client = ReturnType<typeof createOpencodeClient>;

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data: unknown }).data;
    if (data && typeof data === "object" && "message" in data) {
      return (data as { message: string }).message;
    }
  }
  return JSON.stringify(error);
}

export function createOpencodeSessionProvider(client: Client, directory: string): SessionProvider {
  return {
    async injectPrompt(sessionId: string, agent: string, prompt: string): Promise<void> {
      const { error } = await client.session.promptAsync({
        path: { id: sessionId },
        query: { directory },
        body: {
          agent,
          parts: [{ type: "text", text: prompt }],
        },
      });
      if (error) {
        throw new Error(`Failed to inject prompt: ${errorMessage(error)}`);
      }
    },

    async injectSubtask(sessionId: string, agent: string, prompt: string, description: string): Promise<void> {
      const { error } = await client.session.promptAsync({
        path: { id: sessionId },
        query: { directory },
        body: {
          parts: [{ type: "subtask", prompt, description, agent }],
        },
      });
      if (error) {
        throw new Error(`Failed to inject subtask: ${errorMessage(error)}`);
      }
    },

    async getLastAssistantMessage(sessionId: string): Promise<string> {
      if (!sessionId) return "";

      const { data, error } = await client.session.messages({
        path: { id: sessionId },
        query: { directory },
      });
      if (error || !data) return "";

      for (let i = data.length - 1; i >= 0; i--) {
        const msg = data[i];
        if (msg?.info.role === "assistant") {
          const textParts = msg.parts.filter((p) => p.type === "text").map((p) => ("text" in p ? p.text : ""));
          return textParts.join("\n");
        }
      }

      return "";
    },
  };
}
