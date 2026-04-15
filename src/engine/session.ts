/** Abstraction over opencode session management for testability. */
export interface SessionProvider {
  /** Inject a prompt into a session with a specific agent (agent switching). */
  injectPrompt(sessionId: string, agent: string, prompt: string): Promise<void>;
  /** Send a subtask to a session, spawning a visible sub-agent. */
  injectSubtask(sessionId: string, agent: string, prompt: string, description: string): Promise<void>;
  /** Get the last assistant message text from a session. */
  getLastAssistantMessage(sessionId: string): Promise<string>;
}
