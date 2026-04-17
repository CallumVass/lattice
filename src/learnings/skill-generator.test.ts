import { describe, expect, it } from "vitest";
import type { LearningEntry } from "../schema/index.js";
import { LEARNINGS_SKILL_NAME, renderLearningsAsSkill } from "./skill-generator.js";

function entry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  const now = new Date("2026-04-01T00:00:00.000Z").toISOString();
  return {
    id: "abcdef12-3456-4789-8abc-def012345678",
    agent: "code-reviewer",
    pattern: "Null check missing",
    category: "auth",
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

describe("renderLearningsAsSkill", () => {
  it("returns undefined for an empty list", () => {
    expect(renderLearningsAsSkill([])).toBeUndefined();
  });

  it("uses the canonical skill name and groups entries by category", () => {
    const skill = renderLearningsAsSkill([
      entry({ id: "11111111-aaaa-4bbb-8ccc-dddddddddddd", category: "auth", pattern: "Null check" }),
      entry({ id: "22222222-aaaa-4bbb-8ccc-dddddddddddd", category: "perf", pattern: "N+1 query" }),
      entry({ id: "33333333-aaaa-4bbb-8ccc-dddddddddddd", category: "auth", pattern: "Missing authz" }),
    ]);
    expect(skill?.name).toBe(LEARNINGS_SKILL_NAME);
    expect(skill?.content).toContain("## auth");
    expect(skill?.content).toContain("## perf");
    const authIdx = skill?.content.indexOf("## auth") ?? -1;
    const perfIdx = skill?.content.indexOf("## perf") ?? -1;
    expect(authIdx).toBeGreaterThan(-1);
    expect(perfIdx).toBeGreaterThan(authIdx);
    expect(skill?.content).toContain("Null check");
    expect(skill?.content).toContain("Missing authz");
    expect(skill?.content).toContain("N+1 query");
  });

  it("prefixes each entry with a short id so the reviewer can cite it", () => {
    const skill = renderLearningsAsSkill([entry({ id: "abcdef12-3456-4789-8abc-def012345678" })]);
    expect(skill?.content).toContain("(learning: abcdef12)");
  });

  it("tags entries with their severity", () => {
    const skill = renderLearningsAsSkill([
      entry({ id: "11111111-aaaa-4bbb-8ccc-dddddddddddd", severity: "blocking" }),
      entry({ id: "22222222-aaaa-4bbb-8ccc-dddddddddddd", severity: "advisory" }),
    ]);
    expect(skill?.content).toContain("[blocking]");
    expect(skill?.content).toContain("[advisory]");
  });
});
