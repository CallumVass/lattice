import { describe, expect, it } from "vitest";
import type { LearningEntry } from "../schema/index.js";
import { compact, findReinforcementTarget } from "./compaction.js";

function entry(id: string, overrides: Partial<LearningEntry> = {}): LearningEntry {
  const iso = "2026-04-01T00:00:00.000Z";
  return {
    id,
    agent: "*",
    pattern: "default",
    category: "auth",
    severity: "blocking",
    source: { stageId: "propose-comments", date: iso },
    confidence: 0.8,
    usageCount: 0,
    feedbackScore: 0,
    reinforcementCount: 0,
    createdAt: iso,
    lastSeenAt: iso,
    ...overrides,
  };
}

describe("compact", () => {
  it("merges entries with overlapping patterns in the same category", () => {
    const entries = [
      entry("1", { pattern: "Null check missing on user email", usageCount: 1, confidence: 0.7 }),
      entry("2", { pattern: "Null check missing user email again", usageCount: 3, confidence: 0.9 }),
      entry("3", { pattern: "SQL injection in raw query", usageCount: 1, category: "db" }),
      entry("4", { pattern: "Unrelated password hashing concern", usageCount: 1 }),
      entry("5", { pattern: "Null user email null check is missing", usageCount: 2, reinforcementCount: 4 }),
    ];

    const result = compact(entries);
    expect(result.merged).toBe(2);
    expect(result.kept).toHaveLength(3);

    const nullCheck = result.kept.find((e) => e.id === "1");
    expect(nullCheck).toBeDefined();
    expect(nullCheck?.usageCount).toBe(1 + 3 + 2);
    expect(nullCheck?.reinforcementCount).toBe(4);
    expect(nullCheck?.confidence).toBe(0.9);
  });

  it("does not merge across different categories or severities", () => {
    const entries = [
      entry("1", { pattern: "Null check missing", category: "auth", severity: "blocking" }),
      entry("2", { pattern: "Null check missing", category: "auth", severity: "advisory" }),
      entry("3", { pattern: "Null check missing", category: "db", severity: "blocking" }),
    ];
    const result = compact(entries);
    expect(result.merged).toBe(0);
    expect(result.kept).toHaveLength(3);
  });

  it("is idempotent — running twice produces no further merges", () => {
    const entries = [
      entry("1", { pattern: "Null check missing on email" }),
      entry("2", { pattern: "null email null check missing" }),
      entry("3", { pattern: "SQL injection raw interpolation", category: "db" }),
    ];
    const first = compact(entries);
    const second = compact(first.kept);
    expect(second.merged).toBe(0);
    expect(second.kept).toHaveLength(first.kept.length);
  });

  it("preserves the earliest createdAt and the latest lastSeenAt", () => {
    const entries = [
      entry("1", {
        pattern: "Null check missing on email",
        createdAt: "2026-03-01T00:00:00.000Z",
        lastSeenAt: "2026-03-10T00:00:00.000Z",
      }),
      entry("2", {
        pattern: "Null check missing email",
        createdAt: "2026-04-01T00:00:00.000Z",
        lastSeenAt: "2026-04-15T00:00:00.000Z",
      }),
    ];
    const result = compact(entries);
    expect(result.merged).toBe(1);
    expect(result.kept[0]?.createdAt).toBe("2026-03-01T00:00:00.000Z");
    expect(result.kept[0]?.lastSeenAt).toBe("2026-04-15T00:00:00.000Z");
  });
});

describe("findReinforcementTarget", () => {
  it("locates an existing entry that the candidate would merge with", () => {
    const existing = [
      entry("1", { pattern: "Null check missing on user email" }),
      entry("2", { pattern: "SQL injection concern", category: "db" }),
    ];
    const candidate = entry("new", { pattern: "Null check null missing user email" });
    const target = findReinforcementTarget(existing, candidate);
    expect(target?.id).toBe("1");
  });

  it("returns undefined when nothing matches", () => {
    const existing = [entry("1", { pattern: "Null check missing" })];
    const candidate = entry("new", { pattern: "Completely unrelated refactor opportunity", category: "util" });
    expect(findReinforcementTarget(existing, candidate)).toBeUndefined();
  });
});
