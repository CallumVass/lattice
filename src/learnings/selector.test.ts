import { describe, expect, it, vi } from "vitest";
import type { LearningEntry } from "../schema/index.js";
import type { ScoringProvider } from "../skills/index.js";
import { selectLearningsForAgent } from "./selector.js";

function entry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  const now = new Date("2026-04-01T00:00:00.000Z").toISOString();
  return {
    id: "00000000-0000-4000-8000-000000000000",
    agent: "code-reviewer",
    pattern: "default pattern",
    category: "general",
    severity: "blocking",
    source: { stageId: "propose-comments", date: now },
    confidence: 0.9,
    usageCount: 0,
    feedbackScore: 0,
    reinforcementCount: 0,
    createdAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

const ctx = {
  agent: "code-reviewer",
  goal: "review PR #1",
  stageId: "code-review",
  maxPerAgent: 3,
  confidenceThreshold: 0.5,
};

const noopProvider: ScoringProvider = { scoreSkills: async () => "[]" };

describe("selectLearningsForAgent", () => {
  it("returns entries matching the agent or wildcard", async () => {
    const entries = [
      entry({ id: "11111111-1111-4111-8111-111111111111", agent: "code-reviewer" }),
      entry({ id: "22222222-2222-4222-8222-222222222222", agent: "*" }),
      entry({ id: "33333333-3333-4333-8333-333333333333", agent: "planner" }),
    ];
    const result = await selectLearningsForAgent(entries, ctx, noopProvider);
    expect(result.map((e) => e.agent)).toEqual(["code-reviewer", "*"]);
  });

  it("filters out entries below confidence threshold", async () => {
    const entries = [
      entry({ id: "11111111-1111-4111-8111-111111111111", confidence: 0.9 }),
      entry({ id: "22222222-2222-4222-8222-222222222222", confidence: 0.3 }),
    ];
    const result = await selectLearningsForAgent(entries, ctx, noopProvider);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("drops negative and expired entries even above threshold", async () => {
    const now = new Date("2026-04-17T00:00:00.000Z");
    const entries = [
      entry({ id: "11111111-1111-4111-8111-111111111111", severity: "negative", confidence: 0.99 }),
      entry({
        id: "22222222-2222-4222-8222-222222222222",
        expiresAt: "2025-01-01T00:00:00.000Z",
        confidence: 0.99,
      }),
      entry({ id: "33333333-3333-4333-8333-333333333333", confidence: 0.8 }),
    ];
    const result = await selectLearningsForAgent(entries, { ...ctx, now }, noopProvider);
    expect(result.map((e) => e.id)).toEqual(["33333333-3333-4333-8333-333333333333"]);
  });

  it("sorts survivors by confidence when under the cap", async () => {
    const entries = [
      entry({ id: "11111111-1111-4111-8111-111111111111", confidence: 0.6 }),
      entry({ id: "22222222-2222-4222-8222-222222222222", confidence: 0.95 }),
      entry({ id: "33333333-3333-4333-8333-333333333333", confidence: 0.75 }),
    ];
    const provider: ScoringProvider = { scoreSkills: vi.fn(async () => "[]") };
    const result = await selectLearningsForAgent(entries, ctx, provider);
    expect(result.map((e) => e.confidence)).toEqual([0.95, 0.75, 0.6]);
    expect(provider.scoreSkills).not.toHaveBeenCalled();
  });

  it("delegates to the scoring provider when over the cap", async () => {
    const entries = [
      entry({ id: "11111111-1111-4111-8111-111111111111", pattern: "p1", confidence: 0.9 }),
      entry({ id: "22222222-2222-4222-8222-222222222222", pattern: "p2", confidence: 0.9 }),
      entry({ id: "33333333-3333-4333-8333-333333333333", pattern: "p3", confidence: 0.9 }),
      entry({ id: "44444444-4444-4444-8444-444444444444", pattern: "p4", confidence: 0.9 }),
    ];
    const provider: ScoringProvider = { scoreSkills: vi.fn(async () => "[3, 1]") };
    const result = await selectLearningsForAgent(entries, { ...ctx, maxPerAgent: 2 }, provider);
    expect(provider.scoreSkills).toHaveBeenCalledOnce();
    expect(result.map((e) => e.pattern)).toEqual(["p3", "p1"]);
  });

  it("falls back to confidence-sorted top-N when LLM output is malformed", async () => {
    const entries = [
      entry({ id: "11111111-1111-4111-8111-111111111111", pattern: "p1", confidence: 0.6 }),
      entry({ id: "22222222-2222-4222-8222-222222222222", pattern: "p2", confidence: 0.95 }),
      entry({ id: "33333333-3333-4333-8333-333333333333", pattern: "p3", confidence: 0.8 }),
      entry({ id: "44444444-4444-4444-8444-444444444444", pattern: "p4", confidence: 0.7 }),
    ];
    const provider: ScoringProvider = { scoreSkills: async () => "nothing parseable here" };
    const result = await selectLearningsForAgent(entries, { ...ctx, maxPerAgent: 2 }, provider);
    expect(result.map((e) => e.pattern)).toEqual(["p2", "p3"]);
  });
});
