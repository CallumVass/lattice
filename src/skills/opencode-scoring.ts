import type { createOpencodeClient } from "@opencode-ai/sdk";
import type { ScoringProvider } from "./scorer.js";

type Client = ReturnType<typeof createOpencodeClient>;

/**
 * ScoringProvider that uses the opencode SDK to make an LLM call
 * via a temporary session for skill relevance scoring.
 */
export function createOpencodeScoringProvider(client: Client, directory: string): ScoringProvider {
  return {
    async scoreSkills(prompt: string): Promise<string> {
      // Create a temporary session for scoring
      const { data: session, error: createError } = await client.session.create({
        query: { directory },
      });
      if (createError || !session) return "[]";

      // Send the scoring prompt and wait for response
      const { error: promptError } = await client.session.prompt({
        path: { id: session.id },
        query: { directory },
        body: {
          parts: [{ type: "text", text: prompt }],
          noReply: false,
        },
      });
      if (promptError) return "[]";

      // Read the response
      const { data: messages } = await client.session.messages({
        path: { id: session.id },
        query: { directory },
      });
      if (!messages) return "[]";

      // Get last assistant message
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.info.role === "assistant") {
          const text = msg.parts
            .filter((p) => p.type === "text")
            .map((p) => ("text" in p ? p.text : ""))
            .join("\n");

          // Clean up — delete the temporary session
          await client.session.delete({ path: { id: session.id } }).catch(() => {});
          return text;
        }
      }

      await client.session.delete({ path: { id: session.id } }).catch(() => {});
      return "[]";
    },
  };
}
