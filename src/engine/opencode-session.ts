import type { createOpencodeClient } from "@opencode-ai/sdk";
import type { ModelOverride, SessionDispatchResult, SessionProvider, SubtaskDispatchInput } from "./session.js";

type Client = ReturnType<typeof createOpencodeClient>;

type ChildSession = {
  id: string;
  title?: string;
  time?: { created?: number };
};

const subtaskSessionWaitMs = 5_000;
const subtaskSessionPollMs = 100;

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data: unknown }).data;
    if (data && typeof data === "object" && "message" in data) {
      return (data as { message: string }).message;
    }
  }
  return JSON.stringify(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function childSessions(client: Client, sessionId: string, directory: string): Promise<ChildSession[]> {
  const { data, error } = await client.session.children({ path: { id: sessionId }, query: { directory } });
  if (error || !data) return [];
  return data.map((session) => ({ id: session.id, title: session.title, time: session.time }));
}

async function waitForSubtaskSessionId(
  client: Client,
  parentSessionId: string,
  directory: string,
  description: string,
  beforeIds: Set<string>,
  startedAt: number,
): Promise<string | undefined> {
  const deadline = Date.now() + subtaskSessionWaitMs;

  while (Date.now() < deadline) {
    const candidates = (await childSessions(client, parentSessionId, directory))
      .filter((session) => !beforeIds.has(session.id))
      .filter((session) => (session.time?.created ?? 0) >= startedAt - 1_000)
      .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));

    const titled = candidates.find((session) => session.title?.startsWith(description));
    if (titled) return titled.id;
    if (candidates[0]) return candidates[0].id;

    await sleep(subtaskSessionPollMs);
  }

  return undefined;
}

async function waitForSubtaskSessionIds(
  client: Client,
  parentSessionId: string,
  directory: string,
  descriptions: string[],
  beforeIds: Set<string>,
  startedAt: number,
): Promise<Array<string | undefined>> {
  const deadline = Date.now() + subtaskSessionWaitMs;
  const assigned = new Map<number, string>();

  while (Date.now() < deadline) {
    const candidates = (await childSessions(client, parentSessionId, directory))
      .filter((session) => !beforeIds.has(session.id))
      .filter((session) => (session.time?.created ?? 0) >= startedAt - 1_000)
      .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));

    const used = new Set(assigned.values());
    for (let index = 0; index < descriptions.length; index++) {
      if (assigned.has(index)) continue;
      const match = candidates.find(
        (session) => !used.has(session.id) && session.title?.startsWith(descriptions[index] ?? ""),
      );
      if (!match) continue;
      assigned.set(index, match.id);
      used.add(match.id);
    }

    if (assigned.size === descriptions.length) break;
    await sleep(subtaskSessionPollMs);
  }

  return descriptions.map((_, index) => assigned.get(index));
}

async function injectSubtaskBatch(
  client: Client,
  directory: string,
  sessionId: string,
  subtasks: SubtaskDispatchInput[],
): Promise<SessionDispatchResult[]> {
  if (subtasks.length === 0) return [];

  const startedAt = Date.now();
  const beforeIds = new Set((await childSessions(client, sessionId, directory)).map((session) => session.id));

  const results = await Promise.all(
    subtasks.map(({ agent, prompt, description, model }) =>
      client.session.promptAsync({
        path: { id: sessionId },
        query: { directory },
        body: {
          parts: [{ type: "subtask" as const, prompt, description, agent, ...(model && { model }) }],
        },
      }),
    ),
  );
  const failed = results.find((result) => result.error);
  if (failed?.error) {
    throw new Error(`Failed to inject subtasks: ${errorMessage(failed.error)}`);
  }

  const ids = await waitForSubtaskSessionIds(
    client,
    sessionId,
    directory,
    subtasks.map((subtask) => subtask.description),
    beforeIds,
    startedAt,
  );
  return ids.map((childSessionId) => ({ sessionId: childSessionId }));
}

export function createOpencodeSessionProvider(client: Client, directory: string): SessionProvider {
  return {
    async injectPrompt(
      sessionId: string,
      agent: string,
      prompt: string,
      model?: ModelOverride,
      system?: string,
    ): Promise<void> {
      const { error } = await client.session.promptAsync({
        path: { id: sessionId },
        query: { directory },
        body: {
          agent,
          ...(system && { system }),
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
    ): Promise<SessionDispatchResult> {
      const startedAt = Date.now();
      const beforeIds = new Set((await childSessions(client, sessionId, directory)).map((session) => session.id));
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
      return {
        sessionId: await waitForSubtaskSessionId(client, sessionId, directory, description, beforeIds, startedAt),
      };
    },

    injectSubtasks(sessionId: string, subtasks: SubtaskDispatchInput[]): Promise<SessionDispatchResult[]> {
      return injectSubtaskBatch(client, directory, sessionId, subtasks);
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
