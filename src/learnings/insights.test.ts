import { describe, expect, it } from "vitest";
import type { LearningEntry } from "../schema/index.js";
import { findingsTrendByCategory, nearExpiry, negativeCount, topReinforced } from "./insights.js";
import type { RunMetrics } from "./metrics.js";

function run(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    instance: "run-1",
    pipeline: "review",
    findingsCount: 0,
    byCategory: {},
    learningsInjected: 0,
    timestamp: "2026-04-17T12:00:00.000Z",
    ...overrides,
  };
}

function entry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  const iso = "2026-04-01T00:00:00.000Z";
  return {
    id: "11111111-1111-4111-8111-111111111111",
    agent: "*",
    pattern: "Null check missing",
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

describe("findingsTrendByCategory", () => {
  it("buckets counts into ISO week-start dates per category", () => {
    const now = new Date("2026-04-17T00:00:00.000Z");
    const metrics: RunMetrics[] = [
      run({ timestamp: "2026-04-06T10:00:00.000Z", byCategory: { auth: 2, perf: 1 } }),
      run({ timestamp: "2026-04-08T10:00:00.000Z", byCategory: { auth: 1 } }),
      run({ timestamp: "2026-04-14T10:00:00.000Z", byCategory: { perf: 3 } }),
    ];
    const trend = findingsTrendByCategory(metrics, 30, now);
    expect(trend.auth).toEqual([{ weekStart: "2026-04-06", count: 3 }]);
    expect(trend.perf).toEqual([
      { weekStart: "2026-04-06", count: 1 },
      { weekStart: "2026-04-13", count: 3 },
    ]);
  });

  it("drops runs outside the window", () => {
    const now = new Date("2026-04-17T00:00:00.000Z");
    const metrics: RunMetrics[] = [
      run({ timestamp: "2026-01-01T10:00:00.000Z", byCategory: { auth: 5 } }),
      run({ timestamp: "2026-04-15T10:00:00.000Z", byCategory: { perf: 1 } }),
    ];
    const trend = findingsTrendByCategory(metrics, 14, now);
    expect(trend.auth).toBeUndefined();
    expect(trend.perf).toBeDefined();
  });

  it("returns {} for empty input", () => {
    expect(findingsTrendByCategory([], 30)).toEqual({});
  });
});

function uuid(prefix: string): string {
  return `${prefix.padEnd(8, "0")}-0000-4000-8000-000000000000`;
}

describe("topReinforced", () => {
  it("ranks by reinforcementCount then confidence", () => {
    const entries: LearningEntry[] = [
      entry({ id: uuid("a"), reinforcementCount: 1, confidence: 0.9 }),
      entry({ id: uuid("b"), reinforcementCount: 3, confidence: 0.6 }),
      entry({ id: uuid("c"), reinforcementCount: 3, confidence: 0.8 }),
    ];
    const top = topReinforced(entries, 2);
    expect(top.map((e) => e.reinforcementCount)).toEqual([3, 3]);
    expect(top[0]?.confidence).toBe(0.8);
  });

  it("excludes negative entries", () => {
    const entries: LearningEntry[] = [
      entry({ id: uuid("a"), severity: "negative", reinforcementCount: 10 }),
      entry({ id: uuid("b"), reinforcementCount: 1 }),
    ];
    const top = topReinforced(entries, 5);
    expect(top).toHaveLength(1);
    expect(top[0]?.severity).toBe("blocking");
  });
});

describe("nearExpiry", () => {
  it("orders entries by computed time-to-expiry", () => {
    const now = new Date("2026-04-17T00:00:00.000Z");
    const entries: LearningEntry[] = [
      // Stale, one week old — closest to threshold
      entry({ id: uuid("a"), confidence: 0.6, lastSeenAt: "2026-04-10T00:00:00.000Z" }),
      // Fresh and high confidence — far from expiry
      entry({ id: uuid("b"), confidence: 0.95, lastSeenAt: "2026-04-16T00:00:00.000Z" }),
    ];
    const ordered = nearExpiry(entries, 2, { confidenceThreshold: 0.5, decayRate: 0.05 }, now);
    expect(ordered.map((e) => e.id.slice(0, 1))).toEqual(["a", "b"]);
  });

  it("skips entries already expired or below threshold", () => {
    const now = new Date("2026-04-17T00:00:00.000Z");
    const entries: LearningEntry[] = [
      entry({ id: uuid("a"), expiresAt: "2026-04-01T00:00:00.000Z" }),
      entry({ id: uuid("b"), confidence: 0.1 }),
      entry({ id: uuid("c"), confidence: 0.9 }),
    ];
    const surfaced = nearExpiry(entries, 5, { confidenceThreshold: 0.5, decayRate: 0.05 }, now);
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.id.startsWith("c")).toBe(true);
  });

  it("excludes negatives", () => {
    const now = new Date("2026-04-17T00:00:00.000Z");
    const entries: LearningEntry[] = [entry({ id: uuid("a"), severity: "negative" })];
    expect(nearExpiry(entries, 5, { confidenceThreshold: 0.5, decayRate: 0.05 }, now)).toEqual([]);
  });
});

describe("negativeCount", () => {
  it("counts only negative-severity entries", () => {
    const entries: LearningEntry[] = [
      entry({ id: uuid("a"), severity: "negative" }),
      entry({ id: uuid("b"), severity: "blocking" }),
      entry({ id: uuid("c"), severity: "negative" }),
      entry({ id: uuid("d"), severity: "advisory" }),
    ];
    expect(negativeCount(entries)).toBe(2);
  });

  it("returns 0 for empty input", () => {
    expect(negativeCount([])).toBe(0);
  });
});
