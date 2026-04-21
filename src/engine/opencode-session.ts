import type { createOpencodeClient } from "@opencode-ai/sdk";
import type { ModelOverride, SessionProvider } from "./session.js";

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
    async injectPrompt(sessionId: string, agent: string, prompt: string, model?: ModelOverride): Promise<void> {
      const { error } = await client.session.promptAsync({
        path: { id: sessionId },
        query: { directory },
        body: {
          agent,
          parts: [{ type: "text", text: prompt }],
          ...(model && { model }),
        },
      });
      if (error) {
        throw new Error(`Failed to inject prompt: ${errorMessage(error)}`);
      }
    },

    async injectSubtask(
      sessionId: string,
      agent: string,
      prompt: string,
      description: string,
      model?: ModelOverride,
    ): Promise<void> {
      // Subtasks carry their model inside the SubtaskPartInput — `body.model`
      // is ignored for subtasks. SubtaskPartInput.model is the right field,
      // verified against @opencode-ai/sdk types.gen.d.ts.
      const { error } = await client.session.promptAsync({
        path: { id: sessionId },
        query: { directory },
        body: {
          parts: [{ type: "subtask", prompt, description, agent, ...(model && { model }) }],
        },
      });
      if (error) {
        throw new Error(`Failed to inject subtask: ${errorMessage(error)}`);
      }
    },

    async notify(sessionId: string, message: string): Promise<void> {
      const { error } = await client.session.promptAsync({
        path: { id: sessionId },
        query: { directory },
        body: {
          noReply: true,
          parts: [{ type: "text", text: message }],
        },
      });
      if (error) {
        // Notification failure shouldn't break the pipeline — log-and-swallow.
        // The caller logs to opencode's app log separately.
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
