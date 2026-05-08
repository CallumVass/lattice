import type { createOpencodeClient } from "@opencode-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { createOpencodeSessionProvider } from "./opencode-session.js";

type Client = ReturnType<typeof createOpencodeClient>;

interface StubSession {
  children?: ReturnType<typeof vi.fn>;
  promptAsync?: ReturnType<typeof vi.fn>;
  messages?: ReturnType<typeof vi.fn>;
}

function makeClient(overrides: StubSession = {}): Client {
  const base: StubSession = {
    children: vi.fn(async () => ({ data: [], error: undefined })),
    promptAsync: vi.fn(async () => ({ data: {}, error: undefined })),
    messages: vi.fn(async () => ({ data: [], error: undefined })),
    ...overrides,
  };
  return { session: base } as unknown as Client;
}

describe("injectSubtasks", () => {
  it("submits one promptAsync with every subtask part", async () => {
    const children = vi
      .fn()
      .mockResolvedValueOnce({ data: [], error: undefined })
      .mockResolvedValue({
        data: [
          { id: "child-security", title: "[1/3] Lattice: security", time: { created: Date.now() } },
          { id: "child-quality", title: "[1/3] Lattice: quality", time: { created: Date.now() } },
        ],
        error: undefined,
      });
    const promptAsync = vi.fn(async () => ({ data: {}, error: undefined }));
    const client = makeClient({ children, promptAsync });
    const provider = createOpencodeSessionProvider(client, "/tmp/project");

    const results = await provider.injectSubtasks("parent", [
      { agent: "security-reviewer", prompt: "sec prompt", description: "[1/3] Lattice: security" },
      { agent: "quality-reviewer", prompt: "qual prompt", description: "[1/3] Lattice: quality" },
    ]);

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const calls = promptAsync.mock.calls as unknown as Array<
      [{ body: { parts: Array<{ type: string; agent: string }> } }]
    >;
    const firstCall = calls[0];
    if (!firstCall) throw new Error("promptAsync was not called");
    const args = firstCall[0];
    expect(args.body.parts).toHaveLength(2);
    expect(args.body.parts.map((part) => part.agent)).toEqual(["security-reviewer", "quality-reviewer"]);
    expect(args.body.parts.every((part) => part.type === "subtask")).toBe(true);

    expect(results.map((r) => r.sessionId)).toEqual(["child-security", "child-quality"]);
  });

  it("throws when the single prompt call fails", async () => {
    const promptAsync = vi.fn(async () => ({ data: undefined, error: { data: { message: "bad request" } } }));
    const client = makeClient({ promptAsync });
    const provider = createOpencodeSessionProvider(client, "/tmp/project");

    await expect(
      provider.injectSubtasks("parent", [
        { agent: "security-reviewer", prompt: "sec prompt", description: "security" },
      ]),
    ).rejects.toThrow(/Failed to inject subtasks.*bad request/);
  });

  it("returns empty array when no subtasks", async () => {
    const promptAsync = vi.fn(async () => ({ data: {}, error: undefined }));
    const client = makeClient({ promptAsync });
    const provider = createOpencodeSessionProvider(client, "/tmp/project");

    const results = await provider.injectSubtasks("parent", []);
    expect(results).toEqual([]);
    expect(promptAsync).not.toHaveBeenCalled();
  });
});
