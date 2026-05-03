/** Optional per-prompt model override. Format resolved from `"provider/model-id"`. */
export interface ModelOverride {
  providerID: string;
  modelID: string;
}

export interface SessionDispatchResult {
  sessionId?: string;
}

export interface SubtaskDispatchInput {
  agent: string;
  prompt: string;
  description: string;
  model?: ModelOverride;
}

/**
 * Parse a `"provider/model-id"` config string into the structured form opencode
 * expects. Splits on the first `/` so model IDs containing dots or hyphens
 * (e.g. `amazon-bedrock/eu.anthropic.claude-opus-4-7`) round-trip cleanly.
 * Returns undefined for empty/malformed input.
 */
function parseModelOverride(model: string | undefined): ModelOverride | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/**
 * Resolve the model override for a given agent from lattice config. Returns
 * undefined when no override is configured, letting opencode use the session
 * default.
 */
export function resolveModelOverride(
  latticeConfig: { agents?: Record<string, { model?: string }> } | undefined,
  agent: string,
): ModelOverride | undefined {
  return parseModelOverride(latticeConfig?.agents?.[agent]?.model);
}

/** Abstraction over opencode session management for testability. */
export interface SessionProvider {
  /** Inject a prompt into a session with a specific agent (agent switching). */
  injectPrompt(sessionId: string, agent: string, prompt: string, model?: ModelOverride, system?: string): Promise<void>;
  /** Send a subtask to a session, spawning a visible sub-agent. */
  injectSubtask(
    sessionId: string,
    agent: string,
    prompt: string,
    description: string,
    model?: ModelOverride,
  ): Promise<SessionDispatchResult>;
  /** Send multiple subtasks to a session in one prompt turn. */
  injectSubtasks(sessionId: string, subtasks: SubtaskDispatchInput[]): Promise<SessionDispatchResult[]>;
  /**
   * Post a user-visible status message into a session WITHOUT triggering an
   * LLM response. Use for progress surfaces (e.g. "running verification...")
   * so the user isn't staring at a silent terminal while the pipeline works.
   */
  notify(sessionId: string, message: string): Promise<void>;
  /** Get the last assistant message text from a session. */
  getLastAssistantMessage(sessionId: string): Promise<string>;
}
